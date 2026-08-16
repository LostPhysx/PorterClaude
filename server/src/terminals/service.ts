// OWNER: B2. Turns "session + shell" into a live ExecStream. No websocket knowledge here.
import type { ServiceDeps } from '../context.js';
import type { ExecStream } from '../backends/types.js';
import type { GeneralConfig } from '../config/schema.js';
import type { SessionService } from '../sessions/service.js';
import { composeToolsPath } from '../sessions/container.js';
import { shortId } from '../util/ids.js';
import { shQuote, tmuxSessionName } from '../util/slug.js';
import type { TerminalShell } from './protocol.js';

export interface OpenTerminalInput {
  session: string;
  shell: TerminalShell;
  /** stable pane name -> tmux session pc_<name> */
  name: string;
  cols: number;
  rows: number;
}

export interface OpenTerminalResult {
  terminalId: string;
  stream: ExecStream;
  containerId: string;
  tmux: boolean;
  reattached: boolean;
}

/** capability probes are cheap but not free: cache them per container for a minute. */
const PROBE_TTL_MS = 60_000;

interface ProbeEntry {
  value: boolean;
  at: number;
}

interface PathEntry {
  value: string | null;
  at: number;
}

export class TerminalService {
  private readonly probes = new Map<string, ProbeEntry>();
  private readonly paths = new Map<string, PathEntry>();
  private readonly streams = new Map<string, ExecStream>();

  constructor(private readonly deps: ServiceDeps, private readonly sessions: SessionService) {}

  /**
   * 1. sessions.requireRunningContainer(session)
   * 2. hasTmux(containerId) (cached ~60s per container id)
   * 3. build the command (see buildTerminalCommand)
   * 4. backend.execCreate(tty + stdin, TERM/COLORTERM/LANG, workingDir /workspace)
   * 5. backend.execStart(execId, { tty: true, stdin: true })
   * 6. best-effort backend.execResize(execId, {cols, rows}) right after start
   */
  async open(input: OpenTerminalInput): Promise<OpenTerminalResult> {
    const { containerId, config } = await this.sessions.requireRunningContainer(input.session);
    const general = this.deps.config.general();
    const backend = this.deps.backends.get();

    const tmux = await this.hasTmux(containerId);
    const reattached = tmux ? await this.tmuxSessionExists(containerId, input.name) : false;
    // bash matters with AND without tmux: the tools entrypoint installs tmux into images
    // that have no bash at all (alpine), where `tmux new-session ... bash -l` dies instantly.
    const hasBash = await this.hasBash(containerId);

    // Custom images keep claude in the read-only tools volume. The exec inherits the
    // CONTAINER env (buildContainerSpec pins PATH there), but a container created before
    // that - or one whose /etc/profile resets PATH, which Debian's does - would still not
    // find claude, and a non-root image cannot persist PATH in an rc file it may not write.
    // So the exec gets the tools PATH explicitly AND the command re-exports it after the
    // login shell has sourced its profiles. The re-export carries the WHOLE composed PATH,
    // tools prefix *and* the image's own entries (/usr/local/go/bin & co): /etc/profile
    // replaces PATH wholesale, so re-adding only the tools dirs would leave a golang or
    // rust custom session without its toolchain in every terminal (OPS-7).
    const custom = config.image.type === 'custom';
    const toolsPath = custom ? await this.toolsPath(containerId, general) : null;

    const cmd = buildTerminalCommand({
      shell: input.shell,
      name: input.name,
      tmux,
      hasBash,
      ...(toolsPath ? { pathPrefix: toolsPath.split(':').filter((p) => p.length > 0) } : {}),
    });

    const { execId } = await backend.execCreate({
      containerId,
      cmd,
      tty: true,
      attachStdin: true,
      attachStdout: true,
      attachStderr: true,
      env: {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: 'C.UTF-8',
        ...(toolsPath ? { PATH: toolsPath } : {}),
      },
      workingDir: general.workspaceMount,
      ...(config.user ? { user: config.user } : {}),
    });

    const stream = await backend.execStart(execId, { tty: true, stdin: true });

    try {
      await backend.execResize(execId, { cols: input.cols, rows: input.rows });
    } catch (err) {
      this.deps.log.debug({ err, execId }, 'initial exec resize failed (ignored)');
    }

    const terminalId = shortId(8);
    this.register(terminalId, stream);
    this.deps.log.info(
      { terminalId, session: input.session, shell: input.shell, name: input.name, tmux, reattached },
      'terminal opened',
    );
    return { terminalId, stream, containerId, tmux, reattached };
  }

  /** `command -v tmux` probe, cached per container id. */
  async hasTmux(containerId: string): Promise<boolean> {
    return this.probe(`${containerId}:tmux`, containerId, 'command -v tmux >/dev/null 2>&1');
  }

  /**
   * `<toolsMount>/bin:<home>/.local/bin:<container PATH>` for a custom-image session,
   * cached like the capability probes. Reading the live container PATH keeps whatever the
   * image put there instead of replacing it with a guess.
   */
  async toolsPath(containerId: string, general: GeneralConfig): Promise<string> {
    const cached = this.paths.get(containerId);
    let current = cached && Date.now() - cached.at < PROBE_TTL_MS ? cached.value : undefined;
    if (current === undefined) {
      current = null;
      try {
        const backend = this.deps.backends.get();
        const inspect = await backend.inspectContainer(containerId);
        const entry = inspect.env.find((e) => e.startsWith('PATH='));
        current = entry ? entry.slice('PATH='.length) : null;
      } catch (err) {
        this.deps.log.debug({ err, containerId }, 'reading the container PATH failed (ignored)');
      }
      this.paths.set(containerId, { value: current, at: Date.now() });
    }
    return composeToolsPath(general, current);
  }

  /** `command -v bash` probe, cached per container id. */
  async hasBash(containerId: string): Promise<boolean> {
    return this.probe(`${containerId}:bash`, containerId, 'command -v bash >/dev/null 2>&1');
  }

  /** true when a tmux session named pc_<name> already exists (drives `reattached`). */
  async tmuxSessionExists(containerId: string, terminalName: string): Promise<boolean> {
    const target = shQuote(tmuxSessionName(terminalName));
    try {
      const backend = this.deps.backends.get();
      const res = await backend.runExec(
        containerId,
        ['sh', '-lc', `tmux has-session -t ${target} >/dev/null 2>&1`],
        { timeoutMs: 10_000 },
      );
      return res.exitCode === 0;
    } catch (err) {
      this.deps.log.debug({ err, containerId }, 'tmux has-session probe failed');
      return false;
    }
  }

  /** Track open streams so shutdown can close them. */
  register(terminalId: string, stream: ExecStream): void {
    this.streams.set(terminalId, stream);
  }

  unregister(terminalId: string): void {
    this.streams.delete(terminalId);
  }

  count(): number {
    return this.streams.size;
  }

  closeAll(): void {
    for (const [id, stream] of this.streams) {
      try {
        stream.close();
      } catch (err) {
        this.deps.log.debug({ err, terminalId: id }, 'closing terminal stream failed');
      }
    }
    this.streams.clear();
  }

  /** invalidate the cached capability probes for a container (e.g. after a tools sync). */
  forgetProbes(containerId: string): void {
    for (const key of [...this.probes.keys()]) {
      if (key.startsWith(`${containerId}:`)) this.probes.delete(key);
    }
    this.paths.delete(containerId);
  }

  private async probe(key: string, containerId: string, script: string): Promise<boolean> {
    const cached = this.probes.get(key);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value;
    let value = false;
    try {
      const backend = this.deps.backends.get();
      const res = await backend.runExec(containerId, ['sh', '-lc', script], { timeoutMs: 10_000 });
      value = res.exitCode === 0;
    } catch (err) {
      this.deps.log.debug({ err, containerId, script }, 'capability probe failed');
      value = false;
    }
    this.probes.set(key, { value, at: Date.now() });
    return value;
  }
}

/**
 * Command matrix (docs/design/backend.md §8). `<login>` is `bash` when the container has
 * bash and `sh` otherwise — the tools entrypoint installs tmux into images that ship no
 * bash (alpine & co), so the fallback applies to the tmux rows too, otherwise tmux cannot
 * spawn its pane command and the exec exits immediately:
 *   tmux + bash    sh -lc "exec tmux new-session -A -s pc_<name> <login> -l"
 *   tmux + claude  sh -lc "exec tmux new-session -A -s pc_<name> sh -lc 'claude; exec <login> -l'"
 *   tmux + sh      sh -lc "exec tmux new-session -A -s pc_<name> sh -l"
 *   no tmux bash   ["bash","-l"]  (-> ["sh","-l"] when bash is missing)
 *   no tmux claude ["sh","-lc","claude; exec <login> -l"]
 *   no tmux sh     ["sh","-l"]
 *
 * The tmux session name is sanitised by tmuxSessionName() and then shell-quoted, so a
 * user-supplied pane name can never break out of the `sh -lc` string.
 *
 * `pathPrefix` (custom images: `<toolsMount>/bin`, `<containerHome>/.local/bin` and the
 * image's own PATH entries) is re-exported INSIDE the `sh -lc` command, i.e. after the login
 * shell sourced /etc/profile - which on Debian & co unconditionally overwrites PATH and would
 * otherwise hide both the claude binaries of the tools volume and the image's toolchain
 * (/usr/local/go/bin & co) from an image that cannot persist an rc file.
 */
export function buildTerminalCommand(opts: {
  shell: TerminalShell;
  name: string;
  tmux: boolean;
  hasBash: boolean;
  /** extra PATH entries to re-export inside the command (custom images) */
  pathPrefix?: string[];
}): string[] {
  const target = shQuote(tmuxSessionName(opts.name));
  const login = opts.hasBash ? 'bash' : 'sh';
  const prefix = (opts.pathPrefix ?? []).filter((p) => p.length > 0);
  const setPath = prefix.length ? `PATH=${shQuote(prefix.join(':'))}:$PATH; export PATH; ` : '';

  if (opts.tmux) {
    switch (opts.shell) {
      case 'bash':
        return ['sh', '-lc', `${setPath}exec tmux new-session -A -s ${target} ${login} -l`];
      case 'claude':
        return [
          'sh',
          '-lc',
          `${setPath}exec tmux new-session -A -s ${target} sh -lc '${setPath}claude; exec ${login} -l'`,
        ];
      case 'sh':
      default:
        return ['sh', '-lc', `${setPath}exec tmux new-session -A -s ${target} sh -l`];
    }
  }

  switch (opts.shell) {
    case 'bash':
      return opts.hasBash ? ['bash', '-l'] : ['sh', '-l'];
    case 'claude':
      return ['sh', '-lc', `${setPath}claude; exec ${login} -l`];
    case 'sh':
    default:
      return ['sh', '-l'];
  }
}
