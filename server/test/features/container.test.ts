// OWNER: B2. buildContainerSpec / workspaceMountFor / specHash — pure, no docker host.
// v0.2 contract: one auth volume per agent mounted at <home>/.porterclaude/agents/<id>, the
// agent's own paths reached through symlinks (PORTERCLAUDE_AGENT_LINKS), the private history
// volume nested INSIDE the agent volume, and the tools volume + entrypoint in EVERY session
// (docs/design/backend.md v0.2 §12.3, api.md v0.2 "Container contract").
import { describe, expect, it } from 'vitest';
import {
  buildContainerSpec,
  composeToolsPath,
  DEFAULT_CONTAINER_PATH,
  imagePathFromEnv,
  SESSION_PIDS_LIMIT,
  specHash,
  workspaceMountFor,
} from '../../src/sessions/container.js';
import { CONTAINER_LABELS } from '../../src/sessions/model.js';
import { generalConfig, sessionConfig, TEST_HOST_ID } from './helpers.js';
import { BUILTIN_AGENTS } from '../../src/agents/builtin.js';
import type { AgentDefinition } from '../../src/agents/model.js';

const general = generalConfig();

const agent = (id: string): AgentDefinition => {
  const found = BUILTIN_AGENTS.find((a) => a.id === id);
  if (!found) throw new Error(`no built-in agent '${id}'`);
  return found;
};

const agents = [agent('claude')];

/** the agent dir of the claude agent with the default settings */
const CLAUDE_DIR = '/home/dev/.porterclaude/agents/claude';

function recipeSpec(overrides = {}, defs: AgentDefinition[] = agents, imageCmd?: string[] | null) {
  const session = sessionConfig(overrides);
  return buildContainerSpec({
    session,
    general,
    agents: defs,
    resolvedImage: 'porterclaude/node:latest',
    imageType: 'recipe',
    ...(imageCmd === undefined ? {} : { imageCmd }),
  });
}

function customSpec(overrides = {}, defs: AgentDefinition[] = agents) {
  const session = sessionConfig({ image: { type: 'custom', ref: 'nginx:1.27' }, ...overrides });
  return buildContainerSpec({
    session,
    general,
    agents: defs,
    resolvedImage: 'nginx:1.27',
    imageType: 'custom',
  });
}

describe('buildContainerSpec', () => {
  it('names the container pc-<slug> and sets every label, host and agents included', () => {
    const spec = recipeSpec();
    expect(spec.name).toBe('pc-web');
    expect(spec.labels?.[CONTAINER_LABELS.managed]).toBe('true');
    expect(spec.labels?.[CONTAINER_LABELS.session]).toBe('web');
    expect(spec.labels?.[CONTAINER_LABELS.host]).toBe(TEST_HOST_ID);
    expect(spec.labels?.[CONTAINER_LABELS.agents]).toBe('claude');
    expect(spec.labels?.[CONTAINER_LABELS.imageType]).toBe('recipe');
    expect(spec.labels?.[CONTAINER_LABELS.recipe]).toBe('node');
    expect(spec.labels?.[CONTAINER_LABELS.createdAt]).toBe('2026-01-01T00:00:00.000Z');
    expect(spec.labels?.[CONTAINER_LABELS.specHash]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mounts one auth volume per agent at the agent dir, plus the workspace', () => {
    const mounts = recipeSpec({}, [agent('claude'), agent('opencode')]).mounts ?? [];
    expect(mounts).toContainEqual({
      type: 'volume',
      source: 'porterclaude-auth-claude',
      target: CLAUDE_DIR,
      readOnly: false,
    });
    expect(mounts).toContainEqual({
      type: 'volume',
      source: 'porterclaude-auth-opencode',
      target: '/home/dev/.porterclaude/agents/opencode',
      readOnly: false,
    });
    expect(mounts).toContainEqual({
      type: 'volume',
      source: 'porterclaude-ws-web',
      target: '/workspace',
      readOnly: false,
    });
    // v0.1's shared login volumes are gone for good
    expect(mounts.some((m) => m.source === 'porterclaude-claude')).toBe(false);
    expect(mounts.some((m) => m.source === 'porterclaude-claude-home')).toBe(false);
  });

  it('mounts NOTHING agent related for a session without agents', () => {
    const mounts = recipeSpec({}, []).mounts ?? [];
    expect(mounts.some((m) => m.source.startsWith('porterclaude-auth-'))).toBe(false);
    expect(recipeSpec({}, []).labels?.[CONTAINER_LABELS.agents]).toBe('');
    expect(recipeSpec({}, []).env?.PORTERCLAUDE_AGENT_IDS).toBe('');
  });

  it('mounts the tools volume read-only and sets the entrypoint for BOTH image types', () => {
    for (const spec of [recipeSpec(), customSpec()]) {
      expect(spec.entrypoint).toEqual(['/opt/porterclaude/entrypoint.sh']);
      expect(spec.mounts).toContainEqual({
        type: 'volume',
        source: 'porterclaude-tools',
        target: '/opt/porterclaude',
        readOnly: true,
      });
      expect(spec.env?.PORTERCLAUDE_TOOLS).toBe('/opt/porterclaude');
      expect(spec.env?.PORTERCLAUDE_HOME).toBe('/home/dev');
    }
  });

  it('repeats the image CMD for recipes (php still starts supervisord) and idles custom images', () => {
    // The engine drops the image Cmd as soon as the create request sets an Entrypoint, so a
    // recipe that is not given its own CMD back would idle instead of serving (v2-O1.md 1).
    const php = ['supervisord', '-n', '-c', '/etc/supervisor/supervisord.conf'];
    expect(recipeSpec({}, agents, php).cmd).toEqual(php);
    // an image without a CMD, and the pre-inspect callers, still idle
    expect(recipeSpec({}, agents, []).cmd).toEqual(['sleep', 'infinity']);
    expect(recipeSpec({}, agents, null).cmd).toEqual(['sleep', 'infinity']);
    expect(recipeSpec().cmd).toEqual(['sleep', 'infinity']);
    // a custom image idles even when it declares a CMD of its own
    expect(customSpec().cmd).toEqual(['sleep', 'infinity']);
    expect(customSpec().labels?.[CONTAINER_LABELS.recipe]).toBeUndefined();
  });

  it('folds the cmd into the spec hash, so a recipe whose CMD changed needs a recreate', () => {
    const a = recipeSpec({}, agents, ['supervisord', '-n']);
    const b = recipeSpec({}, agents, ['sleep', 'infinity']);
    expect(a.labels?.[CONTAINER_LABELS.specHash]).not.toBe(b.labels?.[CONTAINER_LABELS.specHash]);
  });

  it('pins HOME to the container home for every session (BE-4)', () => {
    // Docker would otherwise inherit HOME from the image (/root for root images) and the
    // agents would write their credentials outside the shared auth volumes.
    expect(customSpec().env?.HOME).toBe('/home/dev');
    expect(recipeSpec().env?.HOME).toBe('/home/dev');
  });

  it('lets an explicit session env override the pinned HOME', () => {
    expect(customSpec({ env: { HOME: '/root' } }).env?.HOME).toBe('/root');
  });

  it('describes the agent symlinks in PORTERCLAUDE_AGENT_LINKS / _IDS / _HOST', () => {
    const spec = recipeSpec({}, [agent('claude')]);
    expect(spec.env?.PORTERCLAUDE_AGENT_IDS).toBe('claude');
    expect(spec.env?.PORTERCLAUDE_HOST).toBe(TEST_HOST_ID);
    expect(spec.env?.PORTERCLAUDE_AGENT_LINKS).toBe(
      `/home/dev/.claude|${CLAUDE_DIR}/claude|dir;/home/dev/.claude.json|${CLAUDE_DIR}/claude.json|file`,
    );
  });

  it('merges the agent env first and lets the session env win', () => {
    const withEnv: AgentDefinition = { ...agent('claude'), env: { AGENT_FLAG: '1', FOO: 'agent' } };
    const spec = recipeSpec({ env: { FOO: 'user' } }, [withEnv]);
    expect(spec.env?.AGENT_FLAG).toBe('1');
    expect(spec.env?.FOO).toBe('user');
  });

  it('adds one history volume per agent WITH a historyPath, nested inside its auth volume', () => {
    const shared = recipeSpec({ shareHistory: true }, [agent('claude'), agent('codex')]).mounts ?? [];
    expect(shared.some((m) => m.source.startsWith('porterclaude-hist-'))).toBe(false);

    const isolated = recipeSpec({ shareHistory: false }, [agent('claude'), agent('codex')]).mounts ?? [];
    // claude keeps the v0.1 volume name so an upgraded session keeps its history
    expect(isolated).toContainEqual({
      type: 'volume',
      source: 'porterclaude-hist-web',
      target: `${CLAUDE_DIR}/claude/projects`,
      readOnly: false,
    });
    expect(isolated).toContainEqual({
      type: 'volume',
      source: 'porterclaude-hist-web-codex',
      target: '/home/dev/.porterclaude/agents/codex/codex/sessions',
      readOnly: false,
    });
    // NEVER at ~/.claude/projects: that path is a symlink the bootstrap creates, and docker
    // resolves mount targets before the bootstrap runs
    expect(isolated.some((m) => m.target === '/home/dev/.claude/projects')).toBe(false);
  });

  it('gives an agent without a historyPath no history volume', () => {
    const mounts = recipeSpec({ shareHistory: false }, [agent('opencode')]).mounts ?? [];
    expect(mounts.some((m) => m.source.startsWith('porterclaude-hist-'))).toBe(false);
  });

  it('sets the session env, working dir, init and pids limit', () => {
    const spec = recipeSpec({ env: { FOO: 'bar' } });
    expect(spec.env).toMatchObject({
      PORTERCLAUDE_SESSION: 'web',
      TERM: 'xterm-256color',
      FOO: 'bar',
    });
    expect(spec.workingDir).toBe('/workspace');
    expect(spec.init).toBe(true);
    expect(spec.resources?.pidsLimit).toBe(SESSION_PIDS_LIMIT);
  });

  it('translates limits and the restart policy', () => {
    const spec = recipeSpec({ limits: { cpus: 2, memoryMb: 4096 }, autoStart: true });
    expect(spec.resources?.cpus).toBe(2);
    expect(spec.resources?.memoryMb).toBe(4096);
    expect(spec.restartPolicy).toBe('unless-stopped');
    expect(recipeSpec({ autoStart: false }).restartPolicy).toBe('no');
  });

  it('maps ports and keeps an omitted hostPort omitted', () => {
    const spec = recipeSpec({ ports: [{ containerPort: 3000, protocol: 'tcp' }] });
    expect(spec.ports).toEqual([{ containerPort: 3000, protocol: 'tcp' }]);
    expect(spec.ports?.[0] && 'hostPort' in spec.ports[0]).toBe(false);
  });

  it('passes the session network / user through', () => {
    const spec = recipeSpec({ network: 'proxy', user: '1001:1001' });
    expect(spec.networks).toEqual(['proxy']);
    expect(spec.user).toBe('1001:1001');
  });

  it('appends extraMounts after the managed mounts', () => {
    const spec = recipeSpec({
      extraMounts: [{ type: 'volume', source: 'cache', target: '/cache', readOnly: false }],
    });
    expect(spec.mounts?.at(-1)).toEqual({
      type: 'volume',
      source: 'cache',
      target: '/cache',
      readOnly: false,
    });
  });

  it('honours a per-host volumePrefix and containerHome (host overrides)', () => {
    const edge = generalConfig({ volumePrefix: 'edge-', containerHome: '/root' });
    const spec = buildContainerSpec({
      session: sessionConfig({ hostId: 'edge' }),
      general: edge,
      agents,
      resolvedImage: 'porterclaude/node:latest',
      imageType: 'recipe',
    });
    expect(spec.mounts).toContainEqual({
      type: 'volume',
      source: 'edge-auth-claude',
      target: '/root/.porterclaude/agents/claude',
      readOnly: false,
    });
    expect(spec.mounts).toContainEqual({
      type: 'volume',
      source: 'edge-ws-web',
      target: '/workspace',
      readOnly: false,
    });
    expect(spec.labels?.[CONTAINER_LABELS.host]).toBe('edge');
  });
});

describe('workspaceMountFor', () => {
  it('uses porterclaude-ws-<slug> by default and honours an explicit volume', () => {
    expect(workspaceMountFor(sessionConfig(), general)).toEqual({
      type: 'volume',
      source: 'porterclaude-ws-web',
      target: '/workspace',
      readOnly: false,
    });
    expect(
      workspaceMountFor(sessionConfig({ workspace: { type: 'volume', volume: 'mine' } }), general).source,
    ).toBe('mine');
  });

  it('binds absolute host paths and resolves relative ones under workspacesRoot', () => {
    expect(
      workspaceMountFor(sessionConfig({ workspace: { type: 'bind', hostPath: '/srv/x' } }), general),
    ).toEqual({ type: 'bind', source: '/srv/x', target: '/workspace', readOnly: false });
    expect(
      workspaceMountFor(sessionConfig({ workspace: { type: 'bind', hostPath: 'proj' } }), general).source,
    ).toBe('/srv/porterclaude/workspaces/proj');
  });

  // INT-03: path.posix.join does not confine, so '../../../etc' used to be bind-mounted
  // as /etc while the config claimed a path "under workspacesRoot". The API schema rejects
  // such a path today, so these bypass it — exactly like a config.json stored before the
  // rule existed, which is what this second line of defence is for.
  const storedBind = (hostPath: string) => ({
    ...sessionConfig(),
    workspace: { type: 'bind' as const, hostPath },
  });

  it('refuses a relative host path that escapes workspacesRoot', () => {
    for (const hostPath of ['../../../etc', 'a/../../..', '..']) {
      expect(() => workspaceMountFor(storedBind(hostPath), general)).toThrowError(/escapes the workspaces root/);
    }
  });

  it('keeps a relative path that stays inside, and normalises it', () => {
    expect(workspaceMountFor(storedBind('a/../proj/'), general).source).toBe('/srv/porterclaude/workspaces/proj');
  });

  it('still allows any absolute host path (single admin user)', () => {
    expect(workspaceMountFor(storedBind('/etc'), general).source).toBe('/etc');
  });

  it('gives a git workspace a named volume', () => {
    const mount = workspaceMountFor(
      sessionConfig({ workspace: { type: 'git', url: 'https://example.com/x.git' } }),
      general,
    );
    expect(mount).toEqual({
      type: 'volume',
      source: 'porterclaude-ws-web',
      target: '/workspace',
      readOnly: false,
    });
  });
});

describe('specHash', () => {
  it('is invariant to key order', () => {
    const a = recipeSpec({ env: { A: '1', B: '2' } });
    const b = recipeSpec({ env: { B: '2', A: '1' } });
    expect(specHash(a)).toBe(specHash(b));
  });

  it('ignores non-recreate fields (labels, spec-hash label, created-at)', () => {
    const spec = recipeSpec();
    const before = specHash(spec);
    const mutated = {
      ...spec,
      labels: { ...spec.labels, [CONTAINER_LABELS.createdAt]: '2030-01-01T00:00:00.000Z', extra: 'x' },
    };
    expect(specHash(mutated)).toBe(before);
  });

  it('changes when the image, mounts, env, ports, limits, user or network change', () => {
    const base = specHash(recipeSpec());
    const variants = [
      buildContainerSpec({
        session: sessionConfig(),
        general,
        agents,
        resolvedImage: 'porterclaude/node:other',
        imageType: 'recipe',
      }),
      recipeSpec({ shareHistory: false }),
      recipeSpec({ env: { FOO: 'bar' } }),
      recipeSpec({ ports: [{ containerPort: 3000, protocol: 'tcp' }] }),
      recipeSpec({ limits: { cpus: 4 } }),
      recipeSpec({ user: '1001' }),
      recipeSpec({ network: 'proxy' }),
      recipeSpec({ extraMounts: [{ type: 'volume', source: 'c', target: '/c', readOnly: false }] }),
    ];
    for (const variant of variants) expect(specHash(variant)).not.toBe(base);
  });

  // enabling an agent on the host must make its sessions ask for a recreate: the new agent
  // only appears once the container carries its auth mount (api.md v0.2 Sessions)
  it('changes when the AGENT SET changes and is stable while it does not', () => {
    const one = recipeSpec({}, [agent('claude')]);
    const two = recipeSpec({}, [agent('claude'), agent('opencode')]);
    expect(specHash(two)).not.toBe(specHash(one));
    expect(specHash(recipeSpec({}, [agent('claude')]))).toBe(specHash(one));
  });

  it('is stable across repeated builds of the same config', () => {
    expect(recipeSpec().labels?.[CONTAINER_LABELS.specHash]).toBe(
      recipeSpec().labels?.[CONTAINER_LABELS.specHash],
    );
  });
});

// BE-6: a non-root image cannot persist PATH in any rc file (docker creates <containerHome>
// as root:root), so the tools PATH has to live in the container env where every `docker exec`
// inherits it. v0.2 does that for RECIPES TOO — the agents live in the tools volume for both.
describe('container PATH (BE-6)', () => {
  it('prepends the tools bin dir to the image PATH', () => {
    const session = sessionConfig({ image: { type: 'custom', ref: 'alpine:3.20' } });
    const spec = buildContainerSpec({
      session,
      general,
      agents,
      resolvedImage: 'alpine:3.20',
      imageType: 'custom',
      imageEnvPath: '/usr/sbin:/usr/bin:/sbin:/bin',
    });
    expect(spec.env?.PATH).toBe(
      '/opt/porterclaude/bin:/home/dev/.local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    );
  });

  it('falls back to the docker default PATH when the image declares none', () => {
    expect(customSpec().env?.PATH).toBe(
      `/opt/porterclaude/bin:/home/dev/.local/bin:${DEFAULT_CONTAINER_PATH}`,
    );
  });

  it('sets PATH for recipe images as well (v0.2: agents come from the tools volume)', () => {
    const spec = buildContainerSpec({
      session: sessionConfig(),
      general,
      agents,
      resolvedImage: 'porterclaude/node:latest',
      imageType: 'recipe',
      imageEnvPath: '/usr/local/bin:/usr/bin',
    });
    expect(spec.env?.PATH).toBe('/opt/porterclaude/bin:/home/dev/.local/bin:/usr/local/bin:/usr/bin');
  });

  it('lets a user-supplied PATH win', () => {
    expect(customSpec({ env: { PATH: '/only/mine' } }).env?.PATH).toBe('/only/mine');
  });

  it('does not duplicate the prefix when the image PATH already contains it', () => {
    expect(composeToolsPath(general, '/opt/porterclaude/bin:/usr/bin')).toBe(
      '/opt/porterclaude/bin:/home/dev/.local/bin:/usr/bin',
    );
  });

  it('imagePathFromEnv recovers the image PATH, so the spec hash of a running container is stable', () => {
    const session = sessionConfig({ image: { type: 'custom', ref: 'alpine:3.20' } });
    const build = (imageEnvPath?: string | null) =>
      buildContainerSpec({
        session,
        general,
        agents,
        resolvedImage: 'alpine:3.20',
        imageType: 'custom',
        ...(imageEnvPath === undefined ? {} : { imageEnvPath }),
      });
    const created = build('/usr/local/go/bin:/usr/bin');
    const containerEnv = Object.entries(created.env ?? {}).map(([k, v]) => `${k}=${v}`);
    const recovered = imagePathFromEnv(containerEnv, general);
    expect(recovered).toBe('/usr/local/go/bin:/usr/bin');
    expect(specHash(build(recovered))).toBe(specHash(created));
    // and without the recovery the hash would differ - which is what made every
    // custom-image session report needsRecreate forever
    expect(specHash(build())).not.toBe(specHash(created));
  });

  it('imagePathFromEnv returns null when there is no PATH at all', () => {
    expect(imagePathFromEnv(['FOO=bar'], general)).toBeNull();
  });
});
