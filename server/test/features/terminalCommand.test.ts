// OWNER: B2. The six-row terminal command matrix + shell-quoting safety, and the v0.2
// agent resolution of TerminalService.open (an agent that is not mounted is refused).
import { describe, expect, it } from 'vitest';
import type { ContainerInspect } from '../../src/backends/types.js';
import { SessionService } from '../../src/sessions/service.js';
import { TerminalService, buildTerminalCommand } from '../../src/terminals/service.js';
import { TERMINAL_CLOSE } from '../../src/terminals/protocol.js';
import { tmuxSessionName } from '../../src/util/slug.js';
import {
  containerSummary,
  hostConfig,
  imageInspect,
  serviceDeps,
  sessionConfig,
  stubBackend,
  stubHostManager,
  stubHosts,
  stubConfigStore,
} from './helpers.js';

/** POSIX single-quoting, the rule every argv element of an agent goes through. */
const q = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * The text of a `sh -lc` script a shell would PARSE: everything inside single quotes (and
 * every backslash-escaped character, which is what `'''` produces) is data, not syntax.
 */
function outsideQuotes(script: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    if (quoted) {
      if (ch === "'") quoted = false;
      continue;
    }
    if (ch === "'") {
      quoted = true;
      continue;
    }
    if (ch === '\\') {
      i += 1; // the next character is literal
      continue;
    }
    out += ch;
  }
  return out;
}

describe('buildTerminalCommand', () => {
  it('tmux + bash', () => {
    expect(buildTerminalCommand({ shell: 'bash', name: 'main', tmux: true, hasBash: true })).toEqual([
      'sh',
      '-lc',
      "exec tmux new-session -A -s 'pc_main' bash -l",
    ]);
  });

  it('tmux + agent (every argv element shell quoted)', () => {
    expect(
      buildTerminalCommand({ shell: 'agent', agentCommand: ['claude'], name: 'main', tmux: true, hasBash: true }),
    ).toEqual(['sh', '-lc', `exec tmux new-session -A -s 'pc_main' sh -lc ${q("'claude'; exec bash -l")}`]);
  });

  it('tmux + agent falls back to sh -l after the agent when the image has no bash (BE-3)', () => {
    expect(
      buildTerminalCommand({ shell: 'agent', agentCommand: ['claude'], name: 'main', tmux: true, hasBash: false }),
    ).toEqual(['sh', '-lc', `exec tmux new-session -A -s 'pc_main' sh -lc ${q("'claude'; exec sh -l")}`]);
  });

  it('no tmux + agent falls back to sh -l when the image has no bash (BE-3)', () => {
    expect(
      buildTerminalCommand({ shell: 'agent', agentCommand: ['claude'], name: 'main', tmux: false, hasBash: false }),
    ).toEqual(['sh', '-lc', "'claude'; exec sh -l"]);
  });

  it('tmux + sh', () => {
    expect(buildTerminalCommand({ shell: 'sh', name: 'main', tmux: true, hasBash: true })).toEqual([
      'sh',
      '-lc',
      "exec tmux new-session -A -s 'pc_main' sh -l",
    ]);
  });

  it('no tmux + bash (and the sh fallback when bash is missing)', () => {
    expect(buildTerminalCommand({ shell: 'bash', name: 'main', tmux: false, hasBash: true })).toEqual([
      'bash',
      '-l',
    ]);
    expect(buildTerminalCommand({ shell: 'bash', name: 'main', tmux: false, hasBash: false })).toEqual([
      'sh',
      '-l',
    ]);
  });

  it('no tmux + agent', () => {
    expect(
      buildTerminalCommand({ shell: 'agent', agentCommand: ['claude'], name: 'main', tmux: false, hasBash: true }),
    ).toEqual(['sh', '-lc', "'claude'; exec bash -l"]);
  });

  it('no tmux + sh', () => {
    expect(buildTerminalCommand({ shell: 'sh', name: 'main', tmux: false, hasBash: true })).toEqual([
      'sh',
      '-l',
    ]);
  });

  it('passes the agent args through, each of them quoted', () => {
    const cmd = buildTerminalCommand({
      shell: 'agent',
      agentCommand: ['opencode', 'run', '--model', 'claude-sonnet'],
      name: 'main',
      tmux: false,
      hasBash: true,
    });
    expect(cmd[2]).toBe("'opencode' 'run' '--model' 'claude-sonnet'; exec bash -l");
  });

  it('uses the tmux session name pc_<name> so a reconnect reattaches', () => {
    const cmd = buildTerminalCommand({ shell: 'bash', name: 'web-claude-2', tmux: true, hasBash: true });
    expect(cmd[2]).toContain("-s 'pc_web-claude-2'");
  });

  it.each([
    "evil'; touch /tmp/pwn; '",
    'name with spaces',
    'a"b`c$d',
    '../../etc/passwd',
  ])('cannot break out of sh -lc: %s', (name) => {
    const cmd = buildTerminalCommand({ shell: 'bash', name, tmux: true, hasBash: true });
    const script = cmd[2] ?? '';
    const target = tmuxSessionName(name);

    // the sanitised session name only ever contains characters that are inert in sh
    expect(target).toMatch(/^pc_[A-Za-z0-9_-]{1,40}$/);
    // ... and it appears exactly once, single-quoted, inside the command
    expect(script).toBe(`exec tmux new-session -A -s '${target}' bash -l`);
    // nothing outside the quotes can start a new command
    expect(script.replace(`'${target}'`, '')).not.toMatch(/[;&|`$"]/);
  });

  // an AgentDefinition is user-supplied config (POST /api/agents): a hostile command or
  // argument must never be able to leave the `sh -lc` string - not at the outer level and
  // not at the nested tmux-pane level, where the outer shell would otherwise consume the
  // quoting and hand the inner shell a string it re-parses.
  it.each([
    ["evil'; touch /tmp/pwn; #", ['--x']],
    ['claude', ["'; rm -rf / #"]],
    ['a b c', ['$(id)', '`id`']],
    ['x; touch /tmp/pwn', []],
  ])('cannot break out with a hostile agent command %j %j', (command, args) => {
    const argv = [command, ...args];
    const pane = `${argv.map(q).join(' ')}; exec bash -l`;

    // no tmux: the pane command IS the exec command
    expect(buildTerminalCommand({ shell: 'agent', agentCommand: argv, name: 'main', tmux: false, hasBash: true })[2]).toBe(
      pane,
    );
    // tmux: the pane command is quoted AS A WHOLE for the outer shell
    expect(buildTerminalCommand({ shell: 'agent', agentCommand: argv, name: 'main', tmux: true, hasBash: true })[2]).toBe(
      `exec tmux new-session -A -s 'pc_main' sh -lc ${q(pane)}`,
    );

    // and nothing of the payload ends up OUTSIDE the quotes, where a shell would run it
    for (const tmux of [false, true]) {
      const script =
        buildTerminalCommand({ shell: 'agent', agentCommand: argv, name: 'main', tmux, hasBash: true })[2] ?? '';
      expect(outsideQuotes(script)).not.toMatch(/touch|rm -rf|\$\(|`|\bid\b/);
    }
  });
});

// BE-6: the agents live in the read-only tools volume (v0.2: for recipes too), and a
// non-root image cannot persist PATH in any rc file - so the exec carries the PATH itself
// and the command re-exports it after the login shell sourced /etc/profile (which resets
// PATH on Debian).
describe('terminal PATH (BE-6)', () => {
  const PREFIX = "PATH='/opt/porterclaude/bin:/home/dev/.local/bin':$PATH; export PATH; ";

  it('injects the tools PATH into the tmux rows', () => {
    const opts = {
      name: 'main',
      tmux: true,
      hasBash: true,
      pathPrefix: ['/opt/porterclaude/bin', '/home/dev/.local/bin'],
    };
    expect(buildTerminalCommand({ ...opts, shell: 'bash' })[2]).toBe(
      `${PREFIX}exec tmux new-session -A -s 'pc_main' bash -l`,
    );
    expect(buildTerminalCommand({ ...opts, shell: 'sh' })[2]).toBe(
      `${PREFIX}exec tmux new-session -A -s 'pc_main' sh -l`,
    );
    // the pane command is a login shell too, so it re-exports the PATH as well
    expect(buildTerminalCommand({ ...opts, shell: 'agent' as const, agentCommand: ['claude'] })[2]).toBe(
      `${PREFIX}exec tmux new-session -A -s 'pc_main' sh -lc ${q(`${PREFIX}'claude'; exec bash -l`)}`,
    );
  });

  it('injects the tools PATH into the no-tmux agent row', () => {
    expect(
      buildTerminalCommand({
        shell: 'agent',
        agentCommand: ['claude'],
        name: 'main',
        tmux: false,
        hasBash: true,
        pathPrefix: ['/opt/porterclaude/bin', '/home/dev/.local/bin'],
      })[2],
    ).toBe(`${PREFIX}'claude'; exec bash -l`);
  });

  it('changes nothing without a prefix', () => {
    expect(
      buildTerminalCommand({ shell: 'agent', agentCommand: ['claude'], name: 'main', tmux: false, hasBash: true })[2],
    ).toBe("'claude'; exec bash -l");
    expect(buildTerminalCommand({ shell: 'bash', name: 'm', tmux: true, hasBash: true, pathPrefix: [] })[2]).toBe(
      "exec tmux new-session -A -s 'pc_m' bash -l",
    );
  });
});

describe('TerminalService.open', () => {
  function makeTerminals(
    opts: {
      custom?: boolean;
      hostAgents?: string[];
      sessionAgents?: string[] | null;
      /** what the CONTAINER really mounts: porterclaude.agents label (B-2) */
      containerAgents?: string[];
      /** ... or only PORTERCLAUDE_AGENT_IDS, for a container whose label was lost */
      containerAgentsEnv?: string[];
    } = {},
  ) {
    const session = opts.custom
      ? sessionConfig({
          name: 'usr',
          image: { type: 'custom', ref: 'alpine:3.20' },
          user: '1000:1000',
          agents: opts.sessionAgents ?? null,
        })
      : sessionConfig({ name: 'usr', agents: opts.sessionAgents ?? null });
    const cfg = stubConfigStore([session]);
    const sb = stubBackend({
      inspectContainer: async (id: string): Promise<ContainerInspect> => ({
        id,
        name: 'pc-usr',
        image: 'alpine:3.20',
        imageId: 'sha256:img',
        state: 'running',
        running: true,
        labels: {},
        env: [
          'PATH=/usr/bin:/bin',
          ...(opts.containerAgentsEnv ? [`PORTERCLAUDE_AGENT_IDS=${opts.containerAgentsEnv.join(',')}`] : []),
        ],
        mounts: [],
        ports: [],
        raw: {},
      }),
    });
    sb.images.set('alpine:3.20', imageInspect({ tags: ['alpine:3.20'] }));
    sb.containers.push(
      containerSummary({
        name: 'pc-usr',
        names: ['pc-usr'],
        labels: {
          'porterclaude.managed': 'true',
          'porterclaude.session': 'usr',
          ...(opts.containerAgents ? { 'porterclaude.agents': opts.containerAgents.join(',') } : {}),
        },
      }),
    );
    const host = hostConfig({ agents: { enabled: opts.hostAgents ?? ['claude'] } });
    const deps = serviceDeps({ config: cfg.store, hosts: stubHostManager(sb.backend, { host }) });
    const sessions = new SessionService(deps);
    return { terminals: new TerminalService(deps, sessions), sb, deps, cfg };
  }

  const execSpec = (sb: ReturnType<typeof stubBackend>) =>
    sb.log.find((c) => c.method === 'execCreate')!.args[0] as {
      env?: Record<string, string>;
      cmd: string[];
      user?: string;
    };

  it('runs the resolved agent command and carries the tools PATH (custom image)', async () => {
    const { terminals, sb } = makeTerminals({ custom: true });
    const opened = await terminals.open({
      session: 'usr',
      shell: 'agent',
      agentId: 'claude',
      name: 'main',
      cols: 80,
      rows: 24,
    });
    expect(opened.agentId).toBe('claude');
    expect(opened.hostId).toBe('default');

    const exec = execSpec(sb);
    expect(exec.env?.PATH).toBe('/opt/porterclaude/bin:/home/dev/.local/bin:/usr/bin:/bin');
    // OPS-7: the re-export after /etc/profile carries the image's own PATH entries too,
    // otherwise a golang/rust custom image loses its toolchain in every terminal.
    expect(exec.cmd[2]).toContain("PATH='/opt/porterclaude/bin:/home/dev/.local/bin:/usr/bin:/bin':$PATH");
    expect(exec.cmd[2]).toContain("'claude'");
    expect(exec.user).toBe('1000:1000');
  });

  // v0.2: recipes no longer bake an agent in, so they need the tools PATH as well
  it('carries the tools PATH for a RECIPE session too', async () => {
    const { terminals, sb } = makeTerminals();
    await terminals.open({ session: 'usr', shell: 'agent', agentId: 'claude', name: 'main', cols: 80, rows: 24 });
    const exec = execSpec(sb);
    expect(exec.env?.PATH).toBe('/opt/porterclaude/bin:/home/dev/.local/bin:/usr/bin:/bin');
    expect(exec.cmd[2]).toContain('/opt/porterclaude/bin');
  });

  it('refuses an agent the session does not mount (agent_not_available / 4410)', async () => {
    const { terminals } = makeTerminals({ hostAgents: ['claude'] });
    await expect(
      terminals.open({ session: 'usr', shell: 'agent', agentId: 'opencode', name: 'main', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({
      terminalCode: 'agent_not_available',
      closeCode: TERMINAL_CLOSE.agentNotAvailable,
    });
  });

  it('refuses an unknown agent id as well', async () => {
    const { terminals } = makeTerminals();
    await expect(
      terminals.open({ session: 'usr', shell: 'agent', agentId: 'nope', name: 'main', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ terminalCode: 'agent_not_available' });
  });

  it('opens an agent the SESSION pins explicitly even when the host enables more', async () => {
    const { terminals, sb } = makeTerminals({ hostAgents: ['claude', 'opencode'], sessionAgents: ['opencode'] });
    const opened = await terminals.open({
      session: 'usr',
      shell: 'agent',
      agentId: 'opencode',
      name: 'main',
      cols: 80,
      rows: 24,
    });
    expect(opened.agentId).toBe('opencode');
    expect(execSpec(sb).cmd[2]).toContain("'opencode'");
    // ...and the one it does NOT mount stays refused
    await expect(
      terminals.open({ session: 'usr', shell: 'agent', agentId: 'claude', name: 'main', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ terminalCode: 'agent_not_available' });
  });

  // B-2: the gate is what the CONTAINER mounts, not `agents ?? host.agents.enabled`.
  // Enabling an agent on the host does not retro-mount an auth volume into a container that
  // was created before that, so answering `ready` would start an UNAUTHENTICATED instance.
  it('refuses an agent enabled on the host AFTER the container was created', async () => {
    const { terminals } = makeTerminals({
      hostAgents: ['claude', 'opencode'], // enabled today ...
      containerAgents: ['claude'], // ... but the running container only mounts claude
    });
    await expect(
      terminals.open({ session: 'usr', shell: 'agent', agentId: 'opencode', name: 'main', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({
      terminalCode: 'agent_not_available',
      closeCode: TERMINAL_CLOSE.agentNotAvailable,
    });
    // the agent it really mounts still opens
    await expect(
      terminals.open({ session: 'usr', shell: 'agent', agentId: 'claude', name: 'main', cols: 80, rows: 24 }),
    ).resolves.toMatchObject({ agentId: 'claude' });
  });

  it('reads the mounted agents from PORTERCLAUDE_AGENT_IDS when the label is gone', async () => {
    const { terminals } = makeTerminals({ hostAgents: ['claude', 'opencode'], containerAgentsEnv: ['claude'] });
    await expect(
      terminals.open({ session: 'usr', shell: 'agent', agentId: 'opencode', name: 'main', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ terminalCode: 'agent_not_available' });
  });

  // the mirror image: an agent DROPPED from the host config is still mounted (and logged in)
  // in the running container, so its pane keeps working until the session is recreated.
  it('opens an agent the container mounts but the host no longer enables', async () => {
    const { terminals, sb } = makeTerminals({ hostAgents: ['claude'], containerAgents: ['claude', 'opencode'] });
    const opened = await terminals.open({
      session: 'usr',
      shell: 'agent',
      agentId: 'opencode',
      name: 'main',
      cols: 80,
      rows: 24,
    });
    expect(opened.agentId).toBe('opencode');
    expect(execSpec(sb).cmd[2]).toContain("'opencode'");
  });

  it('refuses an agent the container mounts but the registry no longer defines', async () => {
    const { terminals } = makeTerminals({ hostAgents: ['claude'], containerAgents: ['claude', 'ghost'] });
    await expect(
      terminals.open({ session: 'usr', shell: 'agent', agentId: 'ghost', name: 'main', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ terminalCode: 'agent_not_available' });
  });

  it('refuses a terminal on a session whose host is gone (host_unavailable / 4411)', async () => {
    const cfg = stubConfigStore([sessionConfig({ name: 'usr', hostId: 'ghost' })]);
    const sb = stubBackend();
    const deps = serviceDeps({ config: cfg.store, hosts: stubHosts([{ host: hostConfig(), backend: sb.backend }]) });
    const terminals = new TerminalService(deps, new SessionService(deps));
    await expect(
      terminals.open({ session: 'usr', shell: 'bash', name: 'main', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({
      terminalCode: 'host_unavailable',
      closeCode: TERMINAL_CLOSE.hostUnavailable,
    });
  });

  it('refuses a terminal on a host without a usable transport', async () => {
    const cfg = stubConfigStore([sessionConfig({ name: 'usr' })]);
    const deps = serviceDeps({
      config: cfg.store,
      hosts: stubHosts([{ host: hostConfig(), backend: null }]),
    });
    const terminals = new TerminalService(deps, new SessionService(deps));
    await expect(
      terminals.open({ session: 'usr', shell: 'bash', name: 'main', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'backend_not_configured' });
  });

  // INT-06: only an explicit pane close reaches this; a reload must never call it.
  it('kills the tmux session of a closed pane on the session host', async () => {
    const { terminals, sb } = makeTerminals();
    await expect(terminals.killTmuxSession('usr', 'usr-bash-2')).resolves.toBe(true);
    const exec = sb.log.filter((c) => c.method === 'runExec').pop()!.args[1] as string[];
    expect(exec[2]).toContain('tmux kill-session -t');
    expect(exec[2]).toContain("'pc_usr-bash-2'");
  });

  it('swallows a kill for a session that is not running', async () => {
    const { terminals } = makeTerminals();
    await expect(terminals.killTmuxSession('gone', 'main')).resolves.toBe(false);
  });
});
