// OWNER: B2. Turns "session + shell" into a live ExecStream. No websocket knowledge here.
//
// v0.2: everything is resolved through the SESSION'S host (`requireRunningContainer` returns
// the hostId), and `shell:'agent'` runs an agent the CONTAINER really mounts - the agent set
// of the running container (`porterclaude.agents` / PORTERCLAUDE_AGENT_IDS), NOT the
// configured `agents ?? host.agents.enabled`, which drifts as soon as an agent is enabled on
// the host after the container was created. An agent that is not mounted has no auth volume
// and no symlink, so starting it anyway would silently hand the user a fresh, unauthenticated
// instance. That is `agent_not_available` / close 4410.
import type { ServiceDeps } from '../context.js';
import type { DockerBackend, ExecStream } from '../backends/types.js';
import type { GeneralConfig } from '../config/schema.js';
import type { SessionService } from '../sessions/service.js';
import { composeToolsPath } from '../sessions/container.js';
import type { AgentDefinition } from '../agents/model.js';
import { agentCommandLine } from '../agents/model.js';
import { toAppError } from '../http/errors.js';
import { shortId } from '../util/ids.js';
import { shQuote, tmuxSessionName } from '../util/slug.js';
import type { TerminalShell } from './protocol.js';
import { TerminalRefusal } from './protocol.js';

export interface OpenTerminalInput {
  session: string;
  shell: TerminalShell;
  /** required exactly when `shell === 'agent'` (terminals/protocol.ts parseTerminalShell) */
  agentId?: string | null;
  /** stable pane name -> tmux session pc_<name> */
  name: string;
  cols: number;
  rows: number;
}

export interface OpenTerminalResult {
  terminalId: string;
  stream: ExecStream;
  containerId: string;
  /** the host the session runs on (goes into the `ready` frame) */
  hostId: string;
  /** the agent this pane started, null for a plain shell */
  agentId: string | null;
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
    // a stored session whose host is gone/unsupported is a 4411, not a 404 of the session
    this.assertHostUsable(input.session);
    const { containerId, config, hostId, containerAgents } = await this.sessions.requireRunningContainer(
      input.session,
    );
    const general = this.deps.hosts.settingsFor(hostId);
    const backend = this.backendFor(hostId);

    // `agent:<id>` must be one of the agents THIS CONTAINER mounts (buildContainerSpec put an
    // auth volume and the agent symlinks into it for exactly those).
    let agentCommand: string[] | null = null;
    let agentId: string | null = null;
    if (input.shell === 'agent') {
      const def = this.requireMountedAgent(input, config, containerAgents);
      agentId = def.id;
      agentCommand = agentCommandLine(def);
    }

    const tmux = await this.hasTmux(backend, containerId);
    const reattached = tmux ? await this.tmuxSessionExists(backend, containerId, input.name) : false;
    // bash matters with AND without tmux: the tools entrypoint installs tmux into images
    // that have no bash at all (alpine), where `tmux new-session ... bash -l` dies instantly.
    const hasBash = await this.hasBash(backend, containerId);

    // v0.2 delivers the agents through the tools volume for RECIPES TOO, so the tools PATH is
    // composed for every session. The exec inherits the CONTAINER env (buildContainerSpec
    // pins PATH there), but a container created before that - or one whose /etc/profile
    // resets PATH, which Debian's does - would still not find the agents, and a non-root
    // image cannot persist PATH in an rc file it may not write. So the exec gets the tools
    // PATH explicitly AND the command re-exports it after the login shell sourced its
    // profiles. The re-export carries the WHOLE composed PATH, tools prefix *and* the image's
    // own entries (/usr/local/go/bin & co): /etc/profile replaces PATH wholesale, so re-adding
    // only the tools dirs would leave a golang or rust session without its toolchain (OPS-7).
    const toolsPath = await this.toolsPath(backend, containerId, general);

    const cmd = buildTerminalCommand({
      shell: input.shell,
      name: input.name,
      tmux,
      hasBash,
      ...(agentCommand ? { agentCommand } : {}),
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
      {
        terminalId,
        session: input.session,
        hostId,
        shell: input.shell,
        agentId,
        name: input.name,
        tmux,
        reattached,
      },
      'terminal opened',
    );
    return { terminalId, stream, containerId, hostId, agentId, tmux, reattached };
  }

  /**
   * A session pinned to a host that no longer exists (deleted with force=1) or to a
   * connection type this version cannot talk to (tcp/ssh) can never get a terminal - both
   * are `host_unavailable` (close 4411), a terminal condition the client must not retry.
   */
  private assertHostUsable(session: string): void {
    const stored = this.deps.config.getSession(session);
    if (!stored) return; // orphan container: the session service finds its host by scanning
    if (!this.deps.hosts.get(stored.hostId)) {
      throw TerminalRefusal.hostUnavailable(
        `the host '${stored.hostId}' of session '${session}' no longer exists`,
      );
    }
    this.backendFor(stored.hostId);
  }

  /**
   * The definition of the agent a pane asked for, or `agent_not_available` (close 4410).
   *
   * The gate is the RUNNING CONTAINER's agent set (`porterclaude.agents` /
   * PORTERCLAUDE_AGENT_IDS), not `agents ?? host.agents.enabled`: enabling an agent on the
   * host does not retro-mount its auth volume into a container created earlier (that is the
   * `needsRecreate` case), so answering `ready` for it would start a fresh, UNAUTHENTICATED
   * instance in a container that has neither its login nor - for a built-in delivered through
   * the tools volume - its symlink. Only a v0.1 container that carries neither label nor env
   * falls back to the configured agents.
   *
   * The command line always comes from the registry, so an agent the container mounts but the
   * registry no longer defines (custom agent deleted with force) is refused as well instead of
   * being launched with a guessed argv.
   */
  private requireMountedAgent(
    input: OpenTerminalInput,
    config: { name: string; hostId: string; agents: string[] | null },
    containerAgents: string[] | null,
  ): AgentDefinition {
    const wanted = input.agentId ?? '';
    // the configured set is only the fallback, but resolving it still maps a dangling host
    // to 4411 before anything else
    const configured = this.resolveAgents(config);
    const mounted = containerAgents ?? configured.map((a) => a.id);
    const hint =
      'enable it on the host, sync the tools volume and recreate the session';
    if (!mounted.includes(wanted)) {
      const available = mounted.join(', ') || 'none';
      throw TerminalRefusal.agentNotAvailable(
        `agent '${wanted}' is not available in session '${input.session}' (mounted: ${available}); ` +
          hint,
      );
    }
    const def = configured.find((a) => a.id === wanted) ?? this.deps.agents.get(wanted);
    if (!def) {
      throw TerminalRefusal.agentNotAvailable(
        `agent '${wanted}' is mounted into session '${input.session}' but no longer defined; ` +
          're-create it under Agents or pick another pane',
      );
    }
    return def;
  }

  /** the agents a session is CONFIGURED for; a dangling host is a 4411, never a crash. */
  private resolveAgents(config: { name: string; hostId: string; agents: string[] | null }): AgentDefinition[] {
    try {
      return this.sessions.resolveAgents(config);
    } catch (err) {
      throw TerminalRefusal.hostUnavailable(
        `the host '${config.hostId}' of session '${config.name}' is unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** the session host's transport; an unknown/unsupported host becomes a 4411. */
  private backendFor(hostId: string): DockerBackend {
    try {
      return this.deps.hosts.backendFor(hostId);
    } catch (err) {
      const appErr = toAppError(err);
      if (appErr.code === 'not_implemented' || appErr.code === 'not_found') {
        throw TerminalRefusal.hostUnavailable(appErr.message);
      }
      throw err;
    }
  }

  /** `command -v tmux` probe, cached per container id. */
  async hasTmux(backend: DockerBackend, containerId: string): Promise<boolean> {
    return this.probe(backend, `${containerId}:tmux`, containerId, 'command -v tmux >/dev/null 2>&1');
  }

  /**
   * `<toolsMount>/bin:<home>/.local/bin:<container PATH>` of a session container, cached
   * like the capability probes. Reading the live container PATH keeps whatever the image put
   * there instead of replacing it with a guess.
   */
  async toolsPath(backend: DockerBackend, containerId: string, general: GeneralConfig): Promise<string> {
    const cached = this.paths.get(containerId);
    let current = cached && Date.now() - cached.at < PROBE_TTL_MS ? cached.value : undefined;
    if (current === undefined) {
      current = null;
      try {
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
  async hasBash(backend: DockerBackend, containerId: string): Promise<boolean> {
    return this.probe(backend, `${containerId}:bash`, containerId, 'command -v bash >/dev/null 2>&1');
  }

  /** true when a tmux session named pc_<name> already exists (drives `reattached`). */
  async tmuxSessionExists(
    backend: DockerBackend,
    containerId: string,
    terminalName: string,
  ): Promise<boolean> {
    const target = shQuote(tmuxSessionName(terminalName));
    try {
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

  /**
   * `tmux kill-session -t pc_<name>` — end the shell of a pane the USER closed.
   *
   * Without this a closed pane leaves a detached tmux session (and whatever ran in it)
   * alive in the container until it is restarted, and nothing in the UI can reach it any
   * more. Called ONLY on an explicit close (a `kill` message or close code 4001), never on
   * a reload or a dropped connection — those must keep the session so the next connect
   * re-attaches.
   *
   * Best effort by construction: it is called while the socket is going away, so a stopped
   * container, a missing tmux or a dead backend is logged and swallowed. Never throws.
   */
  async killTmuxSession(session: string, terminalName: string): Promise<boolean> {
    const target = shQuote(tmuxSessionName(terminalName));
    try {
      const { containerId, hostId } = await this.sessions.requireRunningContainer(session);
      const backend = this.deps.hosts.backendFor(hostId);
      const res = await backend.runExec(
        containerId,
        ['sh', '-lc', `tmux kill-session -t ${target} >/dev/null 2>&1 || true`],
        { timeoutMs: 10_000 },
      );
      this.deps.log.info({ session, name: terminalName, exitCode: res.exitCode }, 'tmux session killed');
      return res.exitCode === 0;
    } catch (err) {
      this.deps.log.debug({ err, session, name: terminalName }, 'killing the tmux session failed (ignored)');
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

  private async probe(
    backend: DockerBackend,
    key: string,
    containerId: string,
    script: string,
  ): Promise<boolean> {
    const cached = this.probes.get(key);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value;
    let value = false;
    try {
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
 * Command matrix (docs/design/backend.md v0.2 §8). `<login>` is `bash` when the container
 * has bash and `sh` otherwise — the tools entrypoint installs tmux into images that ship no
 * bash (alpine & co), so the fallback applies to the tmux rows too, otherwise tmux cannot
 * spawn its pane command and the exec exits immediately. `<agent>` is the shell-quoted
 * `agentCommandLine(def)` of the requested agent (v0.2 replaced the hard-wired `claude`):
 *   tmux + bash    sh -lc "exec tmux new-session -A -s pc_<name> <login> -l"
 *   tmux + agent   sh -lc "exec tmux new-session -A -s pc_<name> sh -lc <quoted '<agent>; exec <login> -l'>"
 *   tmux + sh      sh -lc "exec tmux new-session -A -s pc_<name> sh -l"
 *   no tmux bash   ["bash","-l"]  (-> ["sh","-l"] when bash is missing)
 *   no tmux agent  ["sh","-lc","<agent>; exec <login> -l"]
 *   no tmux sh     ["sh","-l"]
 *
 * The tmux session name is sanitised by tmuxSessionName() and then shell-quoted, so a
 * user-supplied pane name can never break out of the `sh -lc` string.
 *
 * `pathPrefix` (`<toolsMount>/bin`, `<containerHome>/.local/bin` and the image's own PATH
 * entries; v0.2 composes it for every session) is re-exported INSIDE the `sh -lc` command,
 * i.e. after the login
 * shell sourced /etc/profile - which on Debian & co unconditionally overwrites PATH and would
 * otherwise hide both the claude binaries of the tools volume and the image's toolchain
 * (/usr/local/go/bin & co) from an image that cannot persist an rc file.
 */
export function buildTerminalCommand(opts: {
  shell: TerminalShell;
  name: string;
  tmux: boolean;
  hasBash: boolean;
  /** argv of the agent; required when `shell === 'agent'` (agentCommandLine(def)) */
  agentCommand?: string[];
  /** extra PATH entries to re-export inside the command (custom images) */
  pathPrefix?: string[];
}): string[] {
  const target = shQuote(tmuxSessionName(opts.name));
  const login = opts.hasBash ? 'bash' : 'sh';
  // every argv element is shell quoted: an agent definition is user supplied config and
  // must never be able to break out of the `sh -lc` string.
  const agent = (opts.agentCommand ?? []).map((part) => shQuote(part)).join(' ');
  const prefix = (opts.pathPrefix ?? []).filter((p) => p.length > 0);
  const setPath = prefix.length ? `PATH=${shQuote(prefix.join(':'))}:$PATH; export PATH; ` : '';

  // What the tmux pane runs. It is nested inside the OUTER `sh -lc` string, so it is quoted
  // as a whole (shQuote) instead of being pasted in between two single quotes: the outer
  // shell would otherwise strip the quoting of the agent argv and hand the inner shell a
  // string it re-parses - which is exactly how a command like `x; touch /tmp/pwn` in an
  // AgentDefinition (user supplied config, POST /api/agents) would escape.
  const paneCommand = `${setPath}${agent}; exec ${login} -l`;

  if (opts.tmux) {
    switch (opts.shell) {
      case 'bash':
        return ['sh', '-lc', `${setPath}exec tmux new-session -A -s ${target} ${login} -l`];
      case 'agent':
        return [
          'sh',
          '-lc',
          `${setPath}exec tmux new-session -A -s ${target} sh -lc ${shQuote(paneCommand)}`,
        ];
      case 'sh':
      default:
        return ['sh', '-lc', `${setPath}exec tmux new-session -A -s ${target} sh -l`];
    }
  }

  switch (opts.shell) {
    case 'bash':
      return opts.hasBash ? ['bash', '-l'] : ['sh', '-l'];
    case 'agent':
      return ['sh', '-lc', paneCommand];
    case 'sh':
    default:
      return ['sh', '-l'];
  }
}
