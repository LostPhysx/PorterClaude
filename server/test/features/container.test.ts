// OWNER: B2. buildContainerSpec / workspaceMountFor / specHash — pure, no docker host.
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
import { generalConfig, sessionConfig } from './helpers.js';
import { BUILTIN_AGENTS } from '../../src/agents/builtin.js';

const general = generalConfig();
// TODO(B2): the v0.1 expectations below still describe the shared-claude-volume layout.
// Rewrite them against the v0.2 contract (agent auth volumes + symlinks, tools volume in
// every session, uniform entrypoint) — see docs/design/backend.md v0.2 §7/§12.
const agents = BUILTIN_AGENTS.filter((a) => a.id === 'claude');

function recipeSpec(overrides = {}) {
  const session = sessionConfig(overrides);
  return buildContainerSpec({
    session,
    general,
    agents,
    resolvedImage: 'porterclaude/node:latest',
    imageType: 'recipe',
  });
}

function customSpec(overrides = {}) {
  const session = sessionConfig({ image: { type: 'custom', ref: 'nginx:1.27' }, ...overrides });
  return buildContainerSpec({ session, general, agents, resolvedImage: 'nginx:1.27', imageType: 'custom' });
}

describe('buildContainerSpec', () => {
  it('names the container pc-<slug> and sets all five labels', () => {
    const spec = recipeSpec();
    expect(spec.name).toBe('pc-web');
    expect(spec.labels?.[CONTAINER_LABELS.managed]).toBe('true');
    expect(spec.labels?.[CONTAINER_LABELS.session]).toBe('web');
    expect(spec.labels?.[CONTAINER_LABELS.imageType]).toBe('recipe');
    expect(spec.labels?.[CONTAINER_LABELS.recipe]).toBe('node');
    expect(spec.labels?.[CONTAINER_LABELS.createdAt]).toBe('2026-01-01T00:00:00.000Z');
    expect(spec.labels?.[CONTAINER_LABELS.specHash]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mounts both shared claude volumes and the workspace volume', () => {
    const mounts = recipeSpec().mounts ?? [];
    expect(mounts).toContainEqual({
      type: 'volume',
      source: 'porterclaude-claude',
      target: '/home/dev/.claude',
      readOnly: false,
    });
    expect(mounts).toContainEqual({
      type: 'volume',
      source: 'porterclaude-claude-home',
      target: '/home/dev/.claude-home',
      readOnly: false,
    });
    expect(mounts).toContainEqual({
      type: 'volume',
      source: 'porterclaude-ws-web',
      target: '/workspace',
      readOnly: false,
    });
  });

  it('does not mount the tools volume or override the entrypoint for recipes', () => {
    const spec = recipeSpec();
    expect(spec.entrypoint).toBeUndefined();
    expect(spec.cmd).toBeUndefined();
    expect((spec.mounts ?? []).some((m) => m.source === 'porterclaude-tools')).toBe(false);
  });

  it('mounts the tools volume read-only and overrides the entrypoint for custom images', () => {
    const spec = customSpec();
    expect(spec.entrypoint).toEqual(['/opt/porterclaude/entrypoint.sh']);
    expect(spec.cmd).toEqual(['sleep', 'infinity']);
    expect(spec.mounts).toContainEqual({
      type: 'volume',
      source: 'porterclaude-tools',
      target: '/opt/porterclaude',
      readOnly: true,
    });
    expect(spec.env?.PORTERCLAUDE_TOOLS).toBe('/opt/porterclaude');
    expect(spec.env?.PORTERCLAUDE_HOME).toBe('/home/dev');
    expect(spec.labels?.[CONTAINER_LABELS.recipe]).toBeUndefined();
  });

  it('pins HOME to the container home for custom images only (BE-4)', () => {
    // Docker would otherwise inherit HOME from the image (/root for root images) and
    // claude would write credentials/history outside the shared volumes.
    expect(customSpec().env?.HOME).toBe('/home/dev');
    expect(recipeSpec().env?.HOME).toBeUndefined();
  });

  it('lets an explicit session env override the pinned HOME', () => {
    expect(customSpec({ env: { HOME: '/root' } }).env?.HOME).toBe('/root');
  });

  it('adds the history volume only when shareHistory is false', () => {
    const shared = recipeSpec().mounts ?? [];
    expect(shared.some((m) => m.source === 'porterclaude-hist-web')).toBe(false);

    const isolated = recipeSpec({ shareHistory: false }).mounts ?? [];
    expect(isolated).toContainEqual({
      type: 'volume',
      source: 'porterclaude-hist-web',
      target: '/home/dev/.claude/projects',
      readOnly: false,
    });
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

  it('is stable across repeated builds of the same config', () => {
    expect(recipeSpec().labels?.[CONTAINER_LABELS.specHash]).toBe(
      recipeSpec().labels?.[CONTAINER_LABELS.specHash],
    );
  });
});

// BE-6: a custom image that runs as a non-root user cannot persist PATH in any rc file
// (docker creates <containerHome> as root:root), so the tools PATH has to live in the
// container env where every `docker exec` inherits it.
describe('custom image PATH (BE-6)', () => {
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

  it('never touches PATH for recipe images (claude is installed in the image)', () => {
    expect(recipeSpec().env?.PATH).toBeUndefined();
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
