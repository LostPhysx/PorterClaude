// OWNER: B2. The six-row terminal command matrix + shell-quoting safety.
import { describe, expect, it } from 'vitest';
import type { ContainerInspect } from '../../src/backends/types.js';
import { SessionService } from '../../src/sessions/service.js';
import { TerminalService, buildTerminalCommand } from '../../src/terminals/service.js';
import { tmuxSessionName } from '../../src/util/slug.js';
import {
  containerSummary,
  imageInspect,
  serviceDeps,
  sessionConfig,
  stubBackend,
  stubBackendManager,
  stubConfigStore,
} from './helpers.js';

describe('buildTerminalCommand', () => {
  it('tmux + bash', () => {
    expect(buildTerminalCommand({ shell: 'bash', name: 'main', tmux: true, hasBash: true })).toEqual([
      'sh',
      '-lc',
      "exec tmux new-session -A -s 'pc_main' bash -l",
    ]);
  });

  it('tmux + claude', () => {
    expect(buildTerminalCommand({ shell: 'agent', agentCommand: ['claude'], name: 'main', tmux: true, hasBash: true })).toEqual([
      'sh',
      '-lc',
      "exec tmux new-session -A -s 'pc_main' sh -lc 'claude; exec bash -l'",
    ]);
  });

  it('tmux + bash falls back to sh -l when the image has no bash (BE-3)', () => {
    expect(buildTerminalCommand({ shell: 'bash', name: 'main', tmux: true, hasBash: false })).toEqual([
      'sh',
      '-lc',
      "exec tmux new-session -A -s 'pc_main' sh -l",
    ]);
  });

  it('tmux + claude falls back to sh -l after claude when the image has no bash (BE-3)', () => {
    expect(buildTerminalCommand({ shell: 'agent', agentCommand: ['claude'], name: 'main', tmux: true, hasBash: false })).toEqual([
      'sh',
      '-lc',
      "exec tmux new-session -A -s 'pc_main' sh -lc 'claude; exec sh -l'",
    ]);
  });

  it('no tmux + claude falls back to sh -l when the image has no bash (BE-3)', () => {
    expect(buildTerminalCommand({ shell: 'agent', agentCommand: ['claude'], name: 'main', tmux: false, hasBash: false })).toEqual([
      'sh',
      '-lc',
      'claude; exec sh -l',
    ]);
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

  it('no tmux + claude', () => {
    expect(buildTerminalCommand({ shell: 'agent', agentCommand: ['claude'], name: 'main', tmux: false, hasBash: true })).toEqual([
      'sh',
      '-lc',
      'claude; exec bash -l',
    ]);
  });

  it('no tmux + sh', () => {
    expect(buildTerminalCommand({ shell: 'sh', name: 'main', tmux: false, hasBash: true })).toEqual([
      'sh',
      '-l',
    ]);
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
});

// BE-6: a custom image keeps claude in the read-only tools volume, and a non-root image
// cannot persist PATH in any rc file - so the exec carries the PATH itself and the command
// re-exports it after the login shell sourced /etc/profile (which resets PATH on Debian).
describe('terminal PATH for custom images (BE-6)', () => {
  const PREFIX = "PATH='/opt/porterclaude/bin:/home/dev/.local/bin':$PATH; export PATH; ";

  it('injects the tools PATH into the tmux rows', () => {
    const opts = { name: 'main', tmux: true, hasBash: true, pathPrefix: ['/opt/porterclaude/bin', '/home/dev/.local/bin'] };
    expect(buildTerminalCommand({ ...opts, shell: 'bash' })[2]).toBe(
      `${PREFIX}exec tmux new-session -A -s 'pc_main' bash -l`,
    );
    expect(buildTerminalCommand({ ...opts, shell: 'sh' })[2]).toBe(
      `${PREFIX}exec tmux new-session -A -s 'pc_main' sh -l`,
    );
    // the pane command is a login shell too, so it re-exports the PATH as well
    expect(buildTerminalCommand({ ...opts, shell: 'agent' as const, agentCommand: ['claude'] })[2]).toBe(
      `${PREFIX}exec tmux new-session -A -s 'pc_main' sh -lc '${PREFIX}claude; exec bash -l'`,
    );
  });

  it('injects the tools PATH into the no-tmux claude row', () => {
    expect(
      buildTerminalCommand({
        shell: 'agent', agentCommand: ['claude'],
        name: 'main',
        tmux: false,
        hasBash: true,
        pathPrefix: ['/opt/porterclaude/bin', '/home/dev/.local/bin'],
      })[2],
    ).toBe(`${PREFIX}claude; exec bash -l`);
  });

  it('changes nothing without a prefix (recipe images ship claude on the PATH)', () => {
    expect(buildTerminalCommand({ shell: 'agent', agentCommand: ['claude'], name: 'main', tmux: false, hasBash: true })[2]).toBe(
      'claude; exec bash -l',
    );
    expect(buildTerminalCommand({ shell: 'bash', name: 'm', tmux: true, hasBash: true, pathPrefix: [] })[2]).toBe(
      "exec tmux new-session -A -s 'pc_m' bash -l",
    );
  });
});

describe('TerminalService.open PATH handling (BE-6)', () => {
  function makeTerminals(custom: boolean) {
    const session = custom
      ? sessionConfig({ name: 'usr', image: { type: 'custom', ref: 'alpine:3.20' }, user: '1000:1000' })
      : sessionConfig({ name: 'usr' });
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
        env: ['PATH=/usr/bin:/bin'],
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
        labels: { 'porterclaude.managed': 'true', 'porterclaude.session': 'usr' },
      }),
    );
    const deps = serviceDeps({ config: cfg.store, backends: stubBackendManager(sb.backend) });
    const sessions = new SessionService(deps);
    return { terminals: new TerminalService(deps, sessions), sb };
  }

  it('sets PATH in the exec env and in the command for a custom image', async () => {
    const { terminals, sb } = makeTerminals(true);
    await terminals.open({ session: 'usr', shell: 'agent', agentId: 'claude', name: 'main', cols: 80, rows: 24 });
    const exec = sb.log.find((c) => c.method === 'execCreate')!.args[0] as {
      env?: Record<string, string>;
      cmd: string[];
      user?: string;
    };
    expect(exec.env?.PATH).toBe('/opt/porterclaude/bin:/home/dev/.local/bin:/usr/bin:/bin');
    // OPS-7: the re-export after /etc/profile carries the image's own PATH entries too,
    // otherwise a golang/rust custom image loses its toolchain in every terminal.
    expect(exec.cmd[2]).toContain(
      "PATH='/opt/porterclaude/bin:/home/dev/.local/bin:/usr/bin:/bin':$PATH",
    );
    expect(exec.user).toBe('1000:1000');
  });

  // INT-06: only an explicit pane close reaches this; a reload must never call it.
  it('kills the tmux session of a closed pane', async () => {
    const { terminals, sb } = makeTerminals(false);
    await expect(terminals.killTmuxSession('usr', 'usr-bash-2')).resolves.toBe(true);
    const exec = sb.log.filter((c) => c.method === 'runExec').pop()!.args[1] as string[];
    expect(exec[2]).toContain('tmux kill-session -t');
    expect(exec[2]).toContain("'pc_usr-bash-2'");
  });

  it('swallows a kill for a session that is not running', async () => {
    const { terminals } = makeTerminals(false);
    await expect(terminals.killTmuxSession('gone', 'main')).resolves.toBe(false);
  });

  it('leaves a recipe session alone', async () => {
    const { terminals, sb } = makeTerminals(false);
    await terminals.open({ session: 'usr', shell: 'agent', agentId: 'claude', name: 'main', cols: 80, rows: 24 });
    const exec = sb.log.find((c) => c.method === 'execCreate')!.args[0] as {
      env?: Record<string, string>;
      cmd: string[];
    };
    expect(exec.env?.PATH).toBeUndefined();
    expect(exec.cmd[2]).not.toContain('PATH=');
  });
});
