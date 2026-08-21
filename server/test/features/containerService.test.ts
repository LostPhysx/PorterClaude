// OWNER: B2. ContainerService against stubbed DockerBackends (no docker host). v0.2: the
// service is host- and agent-aware, so the expectations below describe the per-agent auth
// volumes, the porterclaude.host/agents labels and the multi-host list.
import { describe, expect, it, vi } from 'vitest';
import { AppError, DockerApiError } from '../../src/http/errors.js';
import { CONTAINER_LABELS, ContainerConfigSchema, ContainerInputSchema } from '../../src/containers/model.js';
import type { ContainerInspect } from '../../src/backends/types.js';
import { buildContainerSpec } from '../../src/containers/container.js';
import { ContainerService } from '../../src/containers/service.js';
import { BUILTIN_AGENTS } from '../../src/agents/builtin.js';
import { SecretBox } from '../../src/config/crypto.js';
import { ProfileConfigSchema, type ProfileConfig } from '../../src/profiles/model.js';
import {
  containerConfig,
  containerInput,
  containerSummary,
  generalConfig,
  hostConfig,
  imageInspect,
  legacyContainerSummary,
  otherHostConfig,
  serviceDeps,
  stubAgentRegistry,
  stubBackend,
  stubHostManager,
  stubHosts,
  stubConfigStore,
  TEST_INSTANCE_ID,
} from './helpers.js';

/** the agents a default test host resolves to (hostConfig enables `claude`) */
const claudeAgent = BUILTIN_AGENTS.filter((a) => a.id === 'claude');

function makeService(opts: {
  containers?: ReturnType<typeof containerConfig>[];
  backend?: ReturnType<typeof stubBackend> | null;
  host?: ReturnType<typeof hostConfig>;
} = {}) {
  const cfg = stubConfigStore(opts.containers ?? []);
  const sb = opts.backend === undefined ? stubBackend() : opts.backend;
  const hosts = stubHostManager(sb ? sb.backend : null, opts.host ? { host: opts.host } : {});
  const service = new ContainerService(serviceDeps({ config: cfg.store, hosts }));
  return { service, cfg, sb };
}

/** a stub whose container inspect reports `imageId` (the stub default is 'sha256:img'). */
function backendRunningImage(imageId: string) {
  return stubBackend({
    inspectContainer: async (id: string) =>
      ({
        id,
        name: 'pc-web',
        image: imageId,
        imageId,
        state: 'running',
        running: true,
        startedAt: new Date().toISOString(),
        labels: {},
        env: [],
        mounts: [],
        ports: [],
        raw: {},
      }) satisfies ContainerInspect,
  });
}

describe('the workspace hostPath rule (INT-03)', () => {
  it('rejects .. segments on the way in but still loads an already stored one', () => {
    const bad = { type: 'bind', hostPath: '../../../etc' };
    expect(
      ContainerInputSchema.safeParse({ name: 'web', image: { type: 'recipe', recipe: 'node' }, workspace: bad })
        .success,
    ).toBe(false);
    expect(
      ContainerConfigSchema.safeParse({ ...containerConfig({ name: 'web' }), workspace: bad }).success,
    ).toBe(true);
  });
});

describe('ContainerService.create', () => {
  it('creates volumes, then the container, then starts it, and persists only afterwards', async () => {
    const { service, cfg, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());

    const view = await service.create(containerInput({ name: 'web' }));

    const order = sb!.calls.filter((c) =>
      ['createVolume', 'createContainer', 'startContainer'].includes(c),
    );
    expect(order[order.length - 3]).toBe('createVolume');
    expect(order[order.length - 2]).toBe('createContainer');
    expect(order[order.length - 1]).toBe('startContainer');
    expect(sb!.calls.indexOf('createContainer')).toBeLessThan(sb!.calls.indexOf('startContainer'));

    // v0.2: one auth volume per resolved agent + the workspace volume, before the container
    const volumes = sb!.log.filter((c) => c.method === 'createVolume').map((c) => c.args[0] as { name: string; labels?: Record<string, string> });
    expect(volumes.map((v) => v.name)).toEqual(['porterclaude-auth-claude', 'porterclaude-ws-web']);
    expect(volumes[0]?.labels).toMatchObject({ 'porterclaude.managed': 'true', 'porterclaude.agent': 'claude' });

    // ...and the container carries the host + agents contract
    const spec = sb!.log.find((c) => c.method === 'createContainer')!.args[0] as {
      labels?: Record<string, string>;
      env?: Record<string, string>;
    };
    expect(spec.labels?.[CONTAINER_LABELS.host]).toBe('default');
    expect(spec.labels?.[CONTAINER_LABELS.agents]).toBe('claude');
    expect(spec.env?.PORTERCLAUDE_HOST).toBe('default');

    expect(cfg.containers.get('web')).toBeTruthy();
    expect(cfg.containers.get('web')?.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(view.name).toBe('web');
  });

  // v2-O1.md 1: the engine drops the image Cmd once the create request sets an Entrypoint,
  // so the server has to read it off the image and pass it back — otherwise the php recipe
  // reaches entrypoint.sh with no argv and idles instead of starting supervisord.
  it('passes the image CMD back explicitly when it sets the bootstrap entrypoint', async () => {
    const php = ['supervisord', '-n', '-c', '/etc/supervisor/supervisord.conf'];
    const { service, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect({ cmd: php }));

    await service.create(containerInput({ name: 'web' }));

    const spec = sb!.log.find((c) => c.method === 'createContainer')!.args[0] as {
      cmd?: string[];
      entrypoint?: string[];
    };
    expect(spec.entrypoint).toEqual(['/opt/porterclaude/entrypoint.sh']);
    expect(spec.cmd).toEqual(php);
  });

  it('idles a container whose image declares no CMD', async () => {
    const { service, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());

    await service.create(containerInput({ name: 'web' }));

    const spec = sb!.log.find((c) => c.method === 'createContainer')!.args[0] as { cmd?: string[] };
    expect(spec.cmd).toEqual(['sleep', 'infinity']);
  });

  it('does not persist and rolls the container back when the config write fails', async () => {
    const { service, cfg, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());
    (cfg.store as unknown as { putContainer: () => Promise<never> }).putContainer = () => {
      throw new Error('disk full');
    };

    await expect(service.create(containerInput({ name: 'web' }))).rejects.toThrow('disk full');
    expect(sb!.calls).toContain('removeContainer');
    expect(cfg.containers.has('web')).toBe(false);
    // BE-9: the volume created for that container goes with it
    expect(sb!.log.filter((c) => c.method === 'removeVolume').map((c) => c.args[0])).toEqual([
      'porterclaude-ws-web',
    ]);
  });

  it('refuses a duplicate name (stored config)', async () => {
    const { service } = makeService({ containers: [containerConfig({ name: 'web' })] });
    await expect(service.create(containerInput({ name: 'web' }))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses a duplicate name (existing container)', async () => {
    const { service, sb } = makeService();
    sb!.containers.push(containerSummary());
    await expect(service.create(containerInput({ name: 'web' }))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('reports a clear conflict when the recipe image is not built', async () => {
    const { service } = makeService();
    await expect(service.create(containerInput({ name: 'web' }))).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('not built'),
    });
  });

  it('pulls a custom image that is missing locally', async () => {
    const { service, sb } = makeService();
    await service.create(containerInput({ name: 'web', image: { type: 'custom', ref: 'nginx:1.27' } }));
    expect(sb!.calls).toContain('pullImage');
  });

  // BE-9: a failed create must not leave porterclaude-ws-<slug> behind
  it('creates no workspace volume when the image cannot be resolved', async () => {
    const { service, sb } = makeService();
    await expect(service.create(containerInput({ name: 'web' }))).rejects.toMatchObject({ code: 'conflict' });
    const created = sb!.log
      .filter((c) => c.method === 'createVolume')
      .map((c) => (c.args[0] as { name: string }).name);
    expect(created).not.toContain('porterclaude-ws-web');
    expect(sb!.calls).not.toContain('createContainer');
  });

  it('removes the volumes it just created when the container create fails', async () => {
    const sb = stubBackend({
      createContainer: async () => {
        throw new Error('invalid container name');
      },
    });
    const { service } = makeService({ backend: sb });
    sb.images.set('porterclaude/node:latest', imageInspect());

    await expect(
      service.create(containerInput({ name: 'web', shareHistory: false })),
    ).rejects.toThrow('invalid container name');

    const removed = sb.log.filter((c) => c.method === 'removeVolume').map((c) => c.args[0]);
    expect(removed).toEqual(['porterclaude-ws-web', 'porterclaude-hist-web']);
  });

  it('keeps a workspace volume that already existed', async () => {
    const sb = stubBackend({
      createContainer: async () => {
        throw new Error('boom');
      },
    });
    const { service } = makeService({ backend: sb });
    sb.images.set('porterclaude/node:latest', imageInspect());
    sb.volumes.push({ name: 'porterclaude-ws-web', driver: 'local', labels: {} });

    await expect(service.create(containerInput({ name: 'web' }))).rejects.toThrow('boom');
    expect(sb.calls).not.toContain('removeVolume');
  });
});

describe('ContainerService.update / recreate', () => {
  it('stops, removes and recreates the container without removing volumes', async () => {
    const stored = containerConfig({ name: 'web' });
    const { service, sb } = makeService({ containers: [stored] });
    sb!.images.set('porterclaude/node:latest', imageInspect());
    sb!.containers.push(containerSummary());

    await service.update('web', containerInput({ name: 'web', env: { FOO: 'bar' } }));

    expect(sb!.calls).toContain('stopContainer');
    expect(sb!.calls).toContain('removeContainer');
    expect(sb!.calls.indexOf('removeContainer')).toBeLessThan(sb!.calls.indexOf('createContainer'));
    const remove = sb!.log.find((c) => c.method === 'removeContainer');
    expect((remove?.args[1] as { removeVolumes?: boolean }).removeVolumes).toBe(false);
    expect(sb!.calls).not.toContain('removeVolume');
  });

  it('rejects a renamed container', async () => {
    const { service } = makeService({ containers: [containerConfig({ name: 'web' })] });
    await expect(service.update('web', containerInput({ name: 'other' }))).rejects.toBeInstanceOf(AppError);
  });

  it('recreate keeps the stored config', async () => {
    const stored = containerConfig({ name: 'web', env: { KEEP: '1' } });
    const { service, cfg, sb } = makeService({ containers: [stored] });
    sb!.images.set('porterclaude/node:latest', imageInspect());
    await service.recreate('web');
    expect(cfg.containers.get('web')?.env).toEqual({ KEEP: '1' });
  });
});

describe('ContainerService.remove', () => {
  it('never removes an auth volume and only drops the container volumes on request', async () => {
    const { service, cfg, sb } = makeService({ containers: [containerConfig({ name: 'web' })] });
    sb!.containers.push(containerSummary());

    await service.remove('web', { removeVolumes: true });

    const removed = sb!.log.filter((c) => c.method === 'removeVolume').map((c) => c.args[0]);
    expect(removed).toEqual(['porterclaude-ws-web', 'porterclaude-hist-web']);
    // deleting an auth volume would drop the login of EVERY container on the host
    expect(removed).not.toContain('porterclaude-auth-claude');
    expect(removed).not.toContain('porterclaude-tools');
    expect(cfg.containers.has('web')).toBe(false);
  });

  it('removes one history volume per agent that declares a historyPath', async () => {
    const host = hostConfig({ agents: { enabled: ['claude', 'codex', 'opencode'] } });
    const { service, sb } = makeService({ containers: [containerConfig({ name: 'web' })], host });
    sb!.containers.push(containerSummary());

    await service.remove('web', { removeVolumes: true });

    const removed = sb!.log.filter((c) => c.method === 'removeVolume').map((c) => c.args[0]);
    // claude keeps the v0.1 name; opencode declares no history, so it has no volume
    expect(removed).toEqual(['porterclaude-ws-web', 'porterclaude-hist-web', 'porterclaude-hist-web-codex']);
  });

  it('keeps the volumes by default', async () => {
    const { service, sb } = makeService({ containers: [containerConfig({ name: 'web' })] });
    sb!.containers.push(containerSummary());
    await service.remove('web');
    expect(sb!.calls).not.toContain('removeVolume');
  });

  it('404s for an unknown container', async () => {
    const { service } = makeService();
    await expect(service.remove('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('ContainerService.list', () => {
  it('merges stored configs with live containers', async () => {
    const { service, sb } = makeService({ containers: [containerConfig({ name: 'web' })] });
    sb!.containers.push(containerSummary());
    const [view] = await service.list();
    expect(view?.status).toBe('running');
    expect(view?.containerId).toBe('c1');
    expect(view?.containerName).toBe('pc-web');
    expect(view?.orphan).toBe(false);
    expect(view?.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('adopts managed containers with no stored config as orphans', async () => {
    const { service, sb } = makeService();
    sb!.containers.push(containerSummary({ labels: { ...containerSummary().labels, 'porterclaude.container': 'ghost' } }));
    const views = await service.list();
    expect(views).toHaveLength(1);
    expect(views[0]?.name).toBe('ghost');
    expect(views[0]?.orphan).toBe(true);
  });

  it('flags needsRecreate when the container spec-hash differs', async () => {
    const stored = containerConfig({ name: 'web' });
    const { service, sb } = makeService({ containers: [stored] });
    sb!.containers.push(
      containerSummary({
        labels: { ...containerSummary().labels, [CONTAINER_LABELS.specHash]: 'stale' },
      }),
    );
    const [view] = await service.list();
    expect(view?.needsRecreate).toBe(true);
  });

  it('does not flag needsRecreate when the hash matches', async () => {
    const stored = containerConfig({ name: 'web' });
    const spec = buildContainerSpec({
      agents: claudeAgent,
      container: stored,
      general: generalConfig(),
      resolvedImage: 'porterclaude/node:latest',
      imageType: 'recipe',
      instanceId: TEST_INSTANCE_ID,
    });
    const { service, sb } = makeService({ containers: [stored] });
    sb!.containers.push(
      containerSummary({
        labels: {
          ...containerSummary().labels,
          [CONTAINER_LABELS.specHash]: spec.labels?.[CONTAINER_LABELS.specHash] ?? '',
        },
      }),
    );
    const [view] = await service.list();
    expect(view?.needsRecreate).toBe(false);
  });

  // INT-01: a recipe rebuild untags the image the container runs, so docker answers a
  // bare digest for it. The view must still name the recipe image and say "outdated".
  it('reports the stable image ref plus imageOutdated after a rebuild', async () => {
    const { service, sb } = makeService({
      containers: [containerConfig({ name: 'web' })],
      backend: backendRunningImage('sha256:8d4d875a6431'),
    });
    sb!.containers.push(containerSummary({ image: 'sha256:8d4d875a6431', imageId: 'sha256:8d4d875a6431' }));
    sb!.images.set('porterclaude/node:latest', imageInspect({ id: 'sha256:rebuilt' }));

    const [view] = await service.list();
    expect(view?.resolvedImage).toBe('porterclaude/node:latest');
    expect(view?.containerImage).toBe('sha256:8d4d875a6431');
    expect(view?.imageOutdated).toBe(true);
  });

  it('does not flag imageOutdated while the container runs the current image', async () => {
    const { service, sb } = makeService({
      containers: [containerConfig({ name: 'web' })],
      backend: backendRunningImage('sha256:current'),
    });
    sb!.containers.push(containerSummary({ imageId: 'sha256:current' }));
    sb!.images.set('porterclaude/node:latest', imageInspect({ id: 'sha256:current' }));

    const [view] = await service.list();
    expect(view?.imageOutdated).toBe(false);
    expect(view?.resolvedImage).toBe('porterclaude/node:latest');
  });

  it('never flags imageOutdated for a definition with no container', async () => {
    const { service, sb } = makeService({ containers: [containerConfig({ name: 'web' })] });
    sb!.images.set('porterclaude/node:latest', imageInspect({ id: 'sha256:rebuilt' }));
    const [view] = await service.list();
    expect(view?.status).toBe('absent');
    expect(view?.imageOutdated).toBe(false);
    expect(view?.containerImage).toBeNull();
  });

  // INT-03: such a config can exist (it was accepted before the rule); listing must not
  // blow up because buildContainerSpec now refuses to mount it.
  it('keeps listing a container whose stored hostPath escapes workspacesRoot', async () => {
    const stored = { ...containerConfig({ name: 'web' }), workspace: { type: 'bind' as const, hostPath: '../../etc' } };
    const { service, sb } = makeService({ containers: [stored] });
    sb!.containers.push(containerSummary());

    const [view] = await service.list();
    expect(view?.name).toBe('web');
    expect(view?.needsRecreate).toBe(true);
    expect(view?.warnings.join(' ')).toContain('escapes the workspaces root');
  });

  it('degrades to stored configs + a warning when the backend is unreachable', async () => {
    const failing = stubBackend({
      listContainers: async () => {
        throw new DockerApiError('connect ECONNREFUSED', 502);
      },
    });
    const { service } = makeService({ containers: [containerConfig({ name: 'web' })], backend: failing });
    const views = await service.list();
    expect(views).toHaveLength(1);
    expect(views[0]?.status).toBe('absent');
    expect(views[0]?.warnings.join(' ')).toContain('docker backend unavailable');
  });

  it('degrades when no backend is configured at all', async () => {
    const { service } = makeService({ containers: [containerConfig({ name: 'web' })], backend: null });
    const views = await service.list();
    expect(views[0]?.status).toBe('absent');
    expect(views[0]?.warnings.length).toBeGreaterThan(0);
  });
});

describe('ContainerService.reconcile / requireRunningContainer', () => {
  it('reports known, running, orphans and missing', async () => {
    const { service, sb } = makeService({
      containers: [containerConfig({ name: 'web' }), containerConfig({ name: 'gone' })],
    });
    sb!.containers.push(containerSummary());
    sb!.containers.push(
      containerSummary({
        id: 'c2',
        name: 'pc-ghost',
        names: ['pc-ghost'],
        state: 'exited',
        labels: { 'porterclaude.managed': 'true', 'porterclaude.container': 'ghost' },
      }),
    );
    const report = await service.reconcile();
    expect(report).toEqual({ known: 2, running: 1, orphans: ['ghost'], adopted: [], missing: ['gone'] });
  });

  it('resolves a running container for the session layer', async () => {
    const { service, sb } = makeService({ containers: [containerConfig({ name: 'web' })] });
    sb!.containers.push(containerSummary());
    await expect(service.requireRunningContainer('web')).resolves.toMatchObject({ containerId: 'c1' });
  });

  it('throws not_found for an unknown container and conflict for a stopped one', async () => {
    const { service, sb } = makeService({ containers: [containerConfig({ name: 'web' })] });
    await expect(service.requireRunningContainer('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.requireRunningContainer('web')).rejects.toMatchObject({ code: 'conflict' });

    sb!.containers.push(containerSummary({ state: 'exited' }));
    await expect(service.requireRunningContainer('web')).rejects.toMatchObject({ code: 'conflict' });
  });
});

// ---------------------------------------------------------------------------
// v0.3: `porterclaude.session` -> `porterclaude.container`. Every container that exists on a
// live engine today carries ONLY the old label, and discovery matches on it. Writing the new
// one is not enough — all three read sites go through `containerLabelOf`, which falls back to
// the legacy key. `legacyContainerSummary` is deliberately NOT named `<prefix><name>`, so
// matchContainer's second fallback (match by derived name) cannot mask a missing read.
// ---------------------------------------------------------------------------
describe('ContainerService legacy porterclaude.session label (v0.2 containers)', () => {
  it('matches a stored definition to its pre-v0.3 container instead of reporting it absent', async () => {
    const { service, sb } = makeService({ containers: [containerConfig({ name: 'web' })] });
    sb!.containers.push(legacyContainerSummary('web'));

    const [view] = await service.list();
    expect(view?.name).toBe('web');
    expect(view?.status).toBe('running');
    expect(view?.containerId).toBe('c-legacy-web');
    expect(view?.orphan).toBe(false);
  });

  it('names an unstored pre-v0.3 container from the legacy label, not from its docker name', async () => {
    const { service, sb } = makeService();
    sb!.containers.push(legacyContainerSummary('web'));

    const [view] = await service.list();
    // the docker name is `renamed-web`: only the legacy label can produce `web`
    expect(view?.name).toBe('web');
    expect(view?.orphan).toBe(true);
  });

  it('reconciles and adopts a pre-v0.3 container under its label name', async () => {
    const { service, cfg, sb } = makeService();
    sb!.containers.push(legacyContainerSummary('web'));

    expect((await service.reconcile()).orphans).toEqual(['web']);

    const report = await service.reconcile({ adopt: true });
    expect(report.adopted).toEqual(['web']);
    expect([...cfg.containers.keys()]).toEqual(['web']);
    // ...and the stored definition is no longer reported as missing on the next pass
    expect((await service.reconcile()).missing).toEqual([]);
  });
});

describe('ContainerService.logs / stop / start', () => {
  it('reads container logs', async () => {
    const { service, sb } = makeService({ containers: [containerConfig({ name: 'web' })] });
    sb!.containers.push(containerSummary());
    await expect(service.logs('web', { tail: 10 })).resolves.toBe('log output');
    const call = sb!.log.find((c) => c.method === 'containerLogs');
    expect(call?.args[1]).toMatchObject({ tail: 10, timestamps: false });
  });

  it('stops a running container and starts a stopped one', async () => {
    const { service, sb } = makeService({ containers: [containerConfig({ name: 'web' })] });
    sb!.containers.push(containerSummary());
    await service.stop('web');
    expect(sb!.calls).toContain('stopContainer');

    sb!.containers[0] = containerSummary({ state: 'exited' });
    await service.start('web');
    expect(sb!.calls).toContain('startContainer');
  });
});

describe('ContainerService private history (BE-2)', () => {
  const initMounts = (sb: ReturnType<typeof stubBackend>) =>
    sb.log
      .filter((c) => c.method === 'createContainer')
      .map((c) => c.args[0] as { name: string; mounts?: Array<{ source: string; target: string }> });

  it('pre-creates the agent history dir with the auth volume ownership before the managed container', async () => {
    const { service, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());

    await service.create(containerInput({ name: 'web', shareHistory: false }));

    const created = initMounts(sb!);
    expect(created).toHaveLength(2);
    const init = created[0]!;
    const container = created[1]!;
    expect(init.name).toMatch(/^porterclaude-histinit-/);
    expect(container.name).toBe('pc-web');

    // the AUTH volume is mounted at its REAL path so docker's empty-volume seeding keeps the
    // recipe's uid-1000 ownership; the history volume gets a scratch path
    expect(init.mounts).toContainEqual({
      type: 'volume',
      source: 'porterclaude-auth-claude',
      target: '/home/dev/.porterclaude/agents/claude',
      readOnly: false,
    });
    expect(init.mounts).toContainEqual({
      type: 'volume',
      source: 'porterclaude-hist-web',
      target: '/pc-hist-0',
      readOnly: false,
    });

    const spec = sb!.log.find((c) => c.method === 'createContainer')!.args[0] as {
      user?: string;
      cmd?: string[];
      labels?: Record<string, string>;
    };
    expect(spec.user).toBe('0:0');
    // the directory that is created is the one INSIDE the auth volume, never the ~/ symlink
    expect(spec.cmd?.[0]).toContain('mkdir -p \'/home/dev/.porterclaude/agents/claude/claude/projects\'');
    expect(spec.cmd?.[0]).toContain("chown \"$own\"");
    // must never look like a managed container to reconcile/list
    expect(spec.labels?.['porterclaude.managed']).toBeUndefined();

    // and the helper container is cleaned up again
    expect(sb!.calls.filter((c) => c === 'removeContainer')).toHaveLength(1);
  });

  it('does not run the volume-init container for shared-history containers', async () => {
    const { service, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());
    await service.create(containerInput({ name: 'web' }));
    expect(initMounts(sb!).map((c) => c.name)).toEqual(['pc-web']);
    expect(sb!.calls).not.toContain('waitContainer');
  });

  it('turns a failing volume-init into a warning instead of failing the create', async () => {
    const sb = stubBackend({ waitContainer: async () => ({ statusCode: 7 }) });
    const { service } = makeService({ backend: sb });
    sb.images.set('porterclaude/node:latest', imageInspect());

    const view = await service.create(containerInput({ name: 'web', shareHistory: false }));
    expect(view.warnings.join(' ')).toContain('private history volume failed');
  });

  it('repairs the agent dirs, symlinks and history dir on every start (root exec)', async () => {
    const { service, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());
    await service.create(containerInput({ name: 'web' }));

    const exec = sb!.log.find(
      (c) => c.method === 'runExec' && String((c.args[1] as string[])[2]).includes('.porterclaude/agents'),
    );
    expect(exec).toBeTruthy();
    expect((exec!.args[2] as { user?: string }).user).toBe('0');
    const script = (exec!.args[1] as string[])[2] ?? '';
    // the agent dir is created and handed to the owner of the container home
    expect(script).toContain("chown -R \"$own\" '/home/dev/.porterclaude/agents/claude'");
    // the ~/ paths are (re-)linked into the auth volume - the entrypoint does the same from
    // the inside, but a container created by an older tools volume needs the outside repair
    expect(script).toContain(
      "ln -sfn '/home/dev/.porterclaude/agents/claude/claude' '/home/dev/.claude'",
    );
    expect(script).toContain(
      "ln -sfn '/home/dev/.porterclaude/agents/claude/claude.json' '/home/dev/.claude.json'",
    );
    // ...and the shared history directory exists (inside the auth volume)
    expect(script).toContain("mkdir -p '/home/dev/.porterclaude/agents/claude/claude/projects'");

    // an image that SHIPS ~/.claude (the v0.1 recipes do) would shadow the auth volume:
    // its content is copied into the still empty volume and the path becomes the symlink
    expect(script).toContain("cp -a '/home/dev/.claude'/. '/home/dev/.porterclaude/agents/claude/claude'/");
    expect(script).toContain("rm -rf '/home/dev/.claude'");
  });

  it('never turns an agent path outside the container home into an rm -rf', async () => {
    // an AgentDefinition is user-supplied config: only paths BELOW <containerHome> may be
    // replaced, so a definition sharing `~` (or `/`) can never wipe the home
    const hostile = {
      ...BUILTIN_AGENTS[0]!,
      id: 'hostile',
      sharedPaths: [{ path: '~', kind: 'dir' as const }],
      historyPath: null,
    };
    const agents = stubAgentRegistry([hostile]);
    const cfg = stubConfigStore([]);
    const sb = stubBackend();
    sb.images.set('porterclaude/node:latest', imageInspect());
    const service = new ContainerService(
      serviceDeps({
        config: cfg.store,
        hosts: stubHostManager(sb.backend, { host: hostConfig({ agents: { enabled: ['hostile'] } }) }),
        agents,
      }),
    );

    await service.create(containerInput({ name: 'web' }));
    const script = sb.log
      .filter((c) => c.method === 'runExec')
      .map((c) => String((c.args[1] as string[])[2]))
      .find((sc) => sc.includes('.porterclaude/agents'));
    expect(script).toBeTruthy();
    expect(script).not.toContain('rm -rf');
  });
});

describe('ContainerService orphan adoption (BE-5)', () => {
  const ghost = () =>
    containerSummary({
      id: 'c9',
      name: 'pc-ghost',
      names: ['pc-ghost'],
      state: 'exited',
      labels: {
        'porterclaude.managed': 'true',
        'porterclaude.container': 'ghost',
        'porterclaude.image-type': 'recipe',
        'porterclaude.recipe': 'node',
      },
    });

  it('starts an orphan (container without stored config) and adopts it', async () => {
    const { service, cfg, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());
    sb!.containers.push(ghost());

    const view = await service.start('ghost');
    expect(sb!.calls).toContain('startContainer');
    expect(cfg.containers.has('ghost')).toBe(true);
    expect(view.orphan).toBe(false);
  });

  it('recreates an orphan instead of 404ing', async () => {
    const { service, cfg, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());
    sb!.containers.push(ghost());

    await service.recreate('ghost');
    expect(cfg.containers.get('ghost')?.image).toEqual({ type: 'recipe', recipe: 'node' });
    expect(sb!.calls).toContain('removeContainer');
    expect(sb!.calls).toContain('createContainer');
  });

  it('updates an orphan instead of 404ing', async () => {
    const { service, cfg, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());
    sb!.containers.push(ghost());

    await service.update('ghost', containerInput({ name: 'ghost', env: { FOO: 'bar' } }));
    expect(cfg.containers.get('ghost')?.env).toEqual({ FOO: 'bar' });
  });

  it('still 404s when neither a config nor a container exists', async () => {
    const { service } = makeService();
    await expect(service.start('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.recreate('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.update('nope', containerInput({ name: 'nope' }))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  // BE-7: the startup reconcile must NOT rewrite an orphan into a reconstructed
  // definition behind the user's back - the orphan flag is the only signal they get.
  it('reconcile reports orphans without adopting them by default', async () => {
    const { service, cfg, sb } = makeService();
    sb!.containers.push(ghost());
    const report = await service.reconcile();
    expect(report.orphans).toEqual(['ghost']);
    expect(cfg.containers.has('ghost')).toBe(false);
    const [view] = await service.list();
    expect(view?.orphan).toBe(true);
  });

  it('reconcile({adopt:true}) (the explicit route) adopts orphans so they become manageable', async () => {
    const { service, cfg, sb } = makeService();
    sb!.containers.push(ghost());
    const report = await service.reconcile({ adopt: true });
    // BE-10: an adopted container is reported as `adopted`, not as a (still) orphan
    expect(report.adopted).toEqual(['ghost']);
    expect(report.orphans).toEqual([]);
    expect(report.known).toBe(1);
    expect(cfg.containers.has('ghost')).toBe(true);
    const [view] = await service.list();
    expect(view?.orphan).toBe(false);
    // a freshly adopted definition describes THAT container: no recreate nag
    expect(view?.needsRecreate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BE-7: adoption must not lose ports/env/limits/mounts/network/restart policy
// ---------------------------------------------------------------------------
describe('ContainerService orphan reconstruction (BE-7)', () => {
  const orphanContainer = () =>
    containerSummary({
      id: 'c9',
      name: 'pc-qa-shared',
      names: ['pc-qa-shared'],
      image: 'alpine:3.20',
      state: 'running',
      labels: {
        'porterclaude.managed': 'true',
        'porterclaude.container': 'qa-shared',
        'porterclaude.image-type': 'custom',
        // inherited from the IMAGE (docker merges image labels into the container's): a
        // custom ref that points at a recipe image carries it, and it must not win
        'porterclaude.recipe': 'base',
        'porterclaude.spec-hash': 'old-hash',
      },
      ports: [{ containerPort: 3000, protocol: 'tcp', hostPort: 32774 }],
    });

  const richInspect = {
    id: 'c9',
    name: 'pc-qa-shared',
    image: 'alpine:3.20',
    imageId: 'sha256:img',
    state: 'running' as const,
    running: true,
    startedAt: new Date().toISOString(),
    labels: orphanContainer().labels,
    env: [
      'PATH=/opt/porterclaude/bin:/home/dev/.local/bin:/usr/bin:/bin',
      'IMAGE_ONLY=1',
      'PORTERCLAUDE_SESSION=qa-shared',
      'PORTERCLAUDE_HOST=default',
      'PORTERCLAUDE_AGENT_IDS=claude',
      'PORTERCLAUDE_TOOLS=/opt/porterclaude',
      'PORTERCLAUDE_HOME=/home/dev',
      'HOME=/home/dev',
      'TERM=xterm-256color',
      'FOO=bar',
    ],
    mounts: [
      {
        type: 'volume',
        name: 'porterclaude-auth-claude',
        destination: '/home/dev/.porterclaude/agents/claude',
        readOnly: false,
      },
      { type: 'volume', name: 'porterclaude-tools', destination: '/opt/porterclaude', readOnly: true },
      { type: 'volume', name: 'porterclaude-ws-qa-shared', destination: '/workspace', readOnly: false },
      { type: 'bind', source: '/srv/media', destination: '/media', readOnly: true },
    ],
    ports: [{ containerPort: 3000, protocol: 'tcp' as const, hostPort: 32774 }],
    user: '1000:1000',
    raw: {
      HostConfig: {
        PortBindings: { '3000/tcp': [{ HostIp: '', HostPort: '32774' }] },
        NanoCpus: 1_500_000_000,
        Memory: 512 * 1024 * 1024,
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: 'pcnet',
      },
    },
  };

  function makeOrphanService() {
    const sb = stubBackend({ inspectContainer: async () => richInspect });
    const made = makeService({ backend: sb });
    sb.containers.push(orphanContainer());
    sb.images.set('alpine:3.20', imageInspect({ tags: ['alpine:3.20'], env: ['IMAGE_ONLY=1'] }));
    return made;
  }

  it('keeps a custom container custom even when the IMAGE carries a porterclaude.recipe label', async () => {
    // docker merges the image labels into the container's, so a custom ref that happens to
    // be a recipe image reports porterclaude.recipe - the image-type label decides
    const { service } = makeOrphanService();
    const [view] = await service.list();
    expect(view?.image).toEqual({ type: 'custom', ref: 'alpine:3.20' });
  });

  it('reconstructs env, ports, limits, extra mounts, network and the restart policy', async () => {
    const { service } = makeOrphanService();
    const [view] = await service.list();

    expect(view?.orphan).toBe(true);
    expect(view?.name).toBe('qa-shared');
    expect(view?.image).toEqual({ type: 'custom', ref: 'alpine:3.20' });
    // the image's own env and everything buildContainerSpec sets is subtracted
    expect(view?.env).toEqual({ FOO: 'bar' });
    expect(view?.ports).toEqual([{ containerPort: 3000, protocol: 'tcp', hostPort: 32774 }]);
    expect(view?.limits).toEqual({ cpus: 1.5, memoryMb: 512 });
    expect(view?.extraMounts).toEqual([
      { type: 'bind', source: '/srv/media', target: '/media', readOnly: true },
    ]);
    expect(view?.network).toBe('pcnet');
    expect(view?.autoStart).toBe(true);
    expect(view?.user).toBe('1000:1000');
    expect(view?.workspace).toEqual({ type: 'volume', volume: 'porterclaude-ws-qa-shared' });
    expect(view?.shareHistory).toBe(true);
  });

  it('persists the full definition when the orphan is adopted, so Recreate keeps the ports', async () => {
    const { service, cfg } = makeOrphanService();
    await service.start('qa-shared');
    const stored = cfg.containers.get('qa-shared');
    expect(stored?.ports).toEqual([{ containerPort: 3000, protocol: 'tcp', hostPort: 32774 }]);
    expect(stored?.env).toEqual({ FOO: 'bar' });
    expect(stored?.limits).toEqual({ cpus: 1.5, memoryMb: 512 });
    expect(stored?.network).toBe('pcnet');
  });

  it('does not nag with needsRecreate right after adopting', async () => {
    const { service } = makeOrphanService();
    await service.start('qa-shared');
    const [view] = await service.list();
    expect(view?.orphan).toBe(false);
    expect(view?.needsRecreate).toBe(false);
  });

  it('keeps autoStart false when the container has no restart policy', async () => {
    const sb = stubBackend({
      inspectContainer: async () => ({ ...richInspect, raw: { HostConfig: { RestartPolicy: { Name: 'no' } } } }),
    });
    const { service } = makeService({ backend: sb });
    sb.containers.push(orphanContainer());
    const [view] = await service.list();
    expect(view?.autoStart).toBe(false);
    expect(view?.limits).toEqual({});
    // no HostConfig.PortBindings: fall back to the runtime bindings rather than dropping them
    expect(view?.ports).toEqual([{ containerPort: 3000, protocol: 'tcp', hostPort: 32774 }]);
  });
});

// ---------------------------------------------------------------------------
// BE-6: non-root custom images need <containerHome> chowned from the outside
// ---------------------------------------------------------------------------
describe('ContainerService custom-image bootstrap (BE-6)', () => {
  function homeExecs(sb: ReturnType<typeof stubBackend>) {
    return sb.log.filter((c) => c.method === 'runExec');
  }

  it('chowns the container home and re-runs the tools bootstrap for a non-root custom image', async () => {
    const { service, sb } = makeService();
    sb!.images.set('alpine:3.20', imageInspect({ tags: ['alpine:3.20'], env: ['PATH=/usr/bin:/bin'] }));

    await service.create(
      containerInput({ name: 'usr', image: { type: 'custom', ref: 'alpine:3.20' }, user: '1000:1000' }),
    );

    const chown = homeExecs(sb!).find((c) => String((c.args[1] as string[])[2]).includes('chown'));
    expect(chown).toBeTruthy();
    expect((chown!.args[2] as { user?: string }).user).toBe('0');
    expect((chown!.args[1] as string[])[2]).toContain("'/home/dev'");

    const boot = homeExecs(sb!).find((c) =>
      String((c.args[1] as string[])[2]).includes('--porterclaude-bootstrap'),
    );
    expect(boot).toBeTruthy();
    // runs as the container user (no user override), so the files land with the right owner
    expect((boot!.args[2] as { user?: string }).user).toBeUndefined();

    // and the container itself carries the tools PATH
    const spec = sb!.log.find((c) => c.method === 'createContainer')!.args[0] as {
      env?: Record<string, string>;
    };
    expect(spec.env?.PATH).toBe('/opt/porterclaude/bin:/home/dev/.local/bin:/usr/bin:/bin');
  });

  it('installs the root-only tools bits (profile.d snippet + /usr/local/bin/claude)', async () => {
    const { service, sb } = makeService();
    sb!.images.set('alpine:3.20', imageInspect({ tags: ['alpine:3.20'], env: ['PATH=/usr/bin:/bin'] }));

    await service.create(
      containerInput({ name: 'usr', image: { type: 'custom', ref: 'alpine:3.20' }, user: '1000:1000' }),
    );

    const script = homeExecs(sb!)
      .map((c) => ({ script: String((c.args[1] as string[])[2]), opts: c.args[2] as { user?: string } }))
      .find((c) => c.script.includes('/etc/profile.d/porterclaude.sh'));
    expect(script).toBeTruthy();
    expect(script!.opts.user).toBe('0'); // only uid 0 can write either path
    // a login shell whose /etc/profile hard-sets PATH (alpine, debian) still finds claude
    expect(script!.script).toContain('export PATH="/opt/porterclaude/bin:/home/dev/.local/bin:$PATH"');
    // ...but only once: the container env and $HOME/.profile carry the prefix as well
    expect(script!.script).toContain('*":/opt/porterclaude/bin:"*) ;;');
    // and so does an exec that starts from the standard PATH
    expect(script!.script).toContain('exec "/opt/porterclaude/bin/claude" "$@"');
    expect(script!.script).toContain('/usr/local/bin/claude');
    // marker guard: never clobber a claude binary or profile snippet the image shipped
    expect(script!.script).toContain('grep -q "porterclaude (generated)"');
  });

  it('re-runs the bootstrap on restart, but never adopts an orphan doing so', async () => {
    const stored = containerConfig({
      name: 'usr',
      image: { type: 'custom', ref: 'alpine:3.20' },
      user: '1000:1000',
    });
    const container = containerSummary({
      id: 'c-usr',
      name: 'pc-usr',
      names: ['pc-usr'],
      image: 'alpine:3.20',
      labels: { 'porterclaude.managed': 'true', 'porterclaude.container': 'usr' },
    });

    const withConfig = makeService({ containers: [stored] });
    withConfig.sb!.containers.push(container);
    await withConfig.service.restart('usr');
    expect(withConfig.sb!.calls).toContain('restartContainer');
    expect(
      homeExecs(withConfig.sb!).some((c) =>
        String((c.args[1] as string[])[2]).includes('/etc/profile.d/porterclaude.sh'),
      ),
    ).toBe(true);

    // the same container without a stored config: restart must not persist a definition
    const orphaned = makeService();
    orphaned.sb!.containers.push(container);
    await orphaned.service.restart('usr');
    expect(orphaned.sb!.calls).toContain('restartContainer');
    expect(orphaned.cfg.containers.has('usr')).toBe(false);
  });

  it('does not touch the home of a root custom image or of a recipe container', async () => {
    const { service, sb } = makeService();
    sb!.images.set('alpine:3.20', imageInspect({ tags: ['alpine:3.20'] }));
    sb!.images.set('porterclaude/node:latest', imageInspect());

    await service.create(containerInput({ name: 'root-img', image: { type: 'custom', ref: 'alpine:3.20' } }));
    await service.create(containerInput({ name: 'web' }));

    const chowns = homeExecs(sb!).filter((c) =>
      String((c.args[1] as string[])[2]).includes('chmod u+rwx'),
    );
    expect(chowns).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// v0.2: N hosts. Container NAMES stay globally unique, everything else is per host.
// ---------------------------------------------------------------------------
describe('ContainerService across hosts', () => {
  const EDGE = 'edge';

  function makeHosts(opts: { edge?: ReturnType<typeof stubBackend> | null; containers?: ReturnType<typeof containerConfig>[] } = {}) {
    const home = stubBackend();
    const edge = opts.edge === undefined ? stubBackend() : opts.edge;
    const cfg = stubConfigStore(
      opts.containers ?? [containerConfig({ name: 'web' }), containerConfig({ name: 'api', hostId: EDGE })],
    );
    const hosts = stubHosts([
      { host: hostConfig(), backend: home.backend },
      {
        host: otherHostConfig({ agents: { enabled: ['claude', 'opencode'] } }),
        backend: edge ? edge.backend : null,
        // a per-host override: everything this host creates carries its own prefix
        general: generalConfig({ volumePrefix: 'edge-' }),
      },
    ]);
    const service = new ContainerService(serviceDeps({ config: cfg.store, hosts }));
    home.images.set('porterclaude/node:latest', imageInspect());
    if (edge) edge.images.set('porterclaude/node:latest', imageInspect());
    return { service, cfg, home, edge };
  }

  const edgeContainer = () =>
    containerSummary({
      id: 'c-edge',
      name: 'pc-api',
      names: ['pc-api'],
      labels: {
        'porterclaude.managed': 'true',
        'porterclaude.container': 'api',
        'porterclaude.host': EDGE,
        'porterclaude.agents': 'claude,opencode',
      },
    });

  it('lists the containers of every host with their host name', async () => {
    const { service, home, edge } = makeHosts();
    home.containers.push(containerSummary());
    edge!.containers.push(edgeContainer());

    const views = await service.list();
    expect(views.map((v) => v.name)).toEqual(['api', 'web']);
    expect(views.find((v) => v.name === 'api')).toMatchObject({
      hostId: EDGE,
      hostName: 'Edge box',
      hostMissing: false,
      status: 'running',
      resolvedAgents: ['claude', 'opencode'],
    });
    expect(views.find((v) => v.name === 'web')).toMatchObject({
      hostId: 'default',
      hostName: 'Local docker',
      resolvedAgents: ['claude'],
    });
  });

  // B-5: `?hostId=` filters the RESULT, not the scan. Narrowing the scan to one host left the
  // same-engine dedupe with a single scan, so a label-less container was reported under EVERY
  // host filter (and adopted by whichever host was filtered).
  it('filters by hostId but still scans the other hosts (same-engine dedupe)', async () => {
    const { service, home, edge } = makeHosts();
    home.containers.push(containerSummary());
    edge!.containers.push(edgeContainer());

    const views = await service.list({ hostId: EDGE });
    expect(views.map((v) => v.name)).toEqual(['api']);
    expect(home.calls).toContain('listContainers');
  });

  it('assigns a label-less container of a SHARED engine to one host under every filter', async () => {
    // one engine, two hosts: both scans see the same container ids
    const engine = stubBackend();
    engine.images.set('porterclaude/node:latest', imageInspect());
    engine.containers.push(
      containerSummary({
        id: 'c-orph',
        name: 'pc-orph',
        names: ['pc-orph'],
        labels: { 'porterclaude.managed': 'true', 'porterclaude.container': 'orph' },
      }),
    );
    const cfg = stubConfigStore([]);
    const hosts = stubHosts([
      { host: hostConfig(), backend: engine.backend },
      { host: otherHostConfig(), backend: engine.backend },
    ]);
    const service = new ContainerService(serviceDeps({ config: cfg.store, hosts }));

    // the orphan belongs to exactly ONE host - the default one (no stored definition, same prefix)
    expect((await service.list()).map((v) => [v.name, v.hostId])).toEqual([['orph', 'default']]);
    expect((await service.list({ hostId: 'default' })).map((v) => v.name)).toEqual(['orph']);
    expect(await service.list({ hostId: EDGE })).toEqual([]);

    // ...and a filtered reconcile of the OTHER host must not adopt it
    const report = await service.reconcile({ adopt: true, hostId: EDGE });
    expect(report.adopted).toEqual([]);
    expect(cfg.store.getContainer('orph')).toBeFalsy();

    const own = await service.reconcile({ adopt: true, hostId: 'default' });
    expect(own.adopted).toEqual(['orph']);
    expect(cfg.store.getContainer('orph')?.hostId).toBe('default');
  });

  it('degrades only the containers of a failing host', async () => {
    const failing = stubBackend({
      listContainers: async () => {
        throw new DockerApiError('connect ECONNREFUSED', 502);
      },
    });
    const { service, home } = makeHosts({ edge: failing });
    home.containers.push(containerSummary());

    const views = await service.list();
    const api = views.find((v) => v.name === 'api');
    const web = views.find((v) => v.name === 'web');
    expect(api?.status).toBe('absent');
    expect(api?.warnings.join(' ')).toContain('docker backend unavailable');
    // the other host is completely unaffected
    expect(web?.status).toBe('running');
    expect(web?.warnings).toEqual([]);
  });

  it('still deletes a container whose host is gone (nothing to talk to)', async () => {
    const cfg = stubConfigStore([containerConfig({ name: 'orphaned', hostId: 'deleted-host' })]);
    const sb = stubBackend();
    const hosts = stubHosts([{ host: hostConfig(), backend: sb.backend }]);
    const service = new ContainerService(serviceDeps({ config: cfg.store, hosts }));

    await service.remove('orphaned', { removeVolumes: true });
    expect(cfg.containers.has('orphaned')).toBe(false);
    // ...and nothing was attempted on the surviving host
    expect(sb.calls).not.toContain('removeContainer');
    expect(sb.calls).not.toContain('removeVolume');
  });

  it('marks a container whose host is gone as hostMissing and read-only', async () => {
    const cfg = stubConfigStore([containerConfig({ name: 'orphaned', hostId: 'deleted-host' })]);
    const sb = stubBackend();
    const hosts = stubHosts([{ host: hostConfig(), backend: sb.backend }]);
    const service = new ContainerService(serviceDeps({ config: cfg.store, hosts }));

    const [view] = await service.list();
    expect(view).toMatchObject({
      name: 'orphaned',
      hostId: 'deleted-host',
      hostName: 'deleted-host',
      hostMissing: true,
      status: 'absent',
      resolvedAgents: [],
    });
    expect(view?.warnings.join(' ')).toContain('no longer exists');
  });

  it('creates on the requested host, with that host s settings and backend', async () => {
    const { service, home, edge } = makeHosts({ containers: [] });

    await service.create(containerInput({ name: 'api', hostId: EDGE }));

    expect(edge!.calls).toContain('createContainer');
    expect(home.calls).not.toContain('createContainer');
    const volumes = edge!.log
      .filter((c) => c.method === 'createVolume')
      .map((c) => (c.args[0] as { name: string }).name);
    // the host override applies to every volume it creates, and BOTH its agents get one
    expect(volumes).toEqual(['edge-auth-claude', 'edge-auth-opencode', 'edge-ws-api']);
    const spec = edge!.log.find((c) => c.method === 'createContainer')!.args[0] as {
      labels?: Record<string, string>;
    };
    expect(spec.labels?.[CONTAINER_LABELS.host]).toBe(EDGE);
    expect(spec.labels?.[CONTAINER_LABELS.agents]).toBe('claude,opencode');
  });

  it('creates on the DEFAULT host when the input omits one', async () => {
    const { service, home, edge } = makeHosts({ containers: [] });
    await service.create(containerInput({ name: 'api' }));
    expect(home.calls).toContain('createContainer');
    expect(edge!.calls).not.toContain('createContainer');
  });

  // container names are unique ACROSS hosts - that is what lets the session websocket route
  // container -> host with nothing but the name (api.md v0.2)
  it('409s a name that is already used on ANOTHER host', async () => {
    const { service } = makeHosts();
    await expect(service.create(containerInput({ name: 'web', hostId: EDGE }))).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('409s a name taken by a container of the target host', async () => {
    const { service, edge } = makeHosts({ containers: [] });
    edge!.containers.push(edgeContainer());
    await expect(service.create(containerInput({ name: 'api', hostId: EDGE }))).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('404s an unknown host on create', async () => {
    const { service } = makeHosts({ containers: [] });
    await expect(service.create(containerInput({ name: 'api', hostId: 'nope' }))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('422s a PUT that moves the container to another host (the host is immutable)', async () => {
    const { service } = makeHosts();
    await expect(
      service.update('web', containerInput({ name: 'web', hostId: EDGE })),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('accepts a PUT that repeats the stored hostId', async () => {
    const { service, home } = makeHosts();
    home.containers.push(containerSummary());
    await expect(service.update('web', containerInput({ name: 'web', hostId: 'default' }))).resolves.toMatchObject({
      hostId: 'default',
    });
  });

  it('uses the container host for start/stop/logs, never the default one', async () => {
    const { service, home, edge } = makeHosts();
    edge!.containers.push(edgeContainer());
    await service.stop('api');
    expect(edge!.calls).toContain('stopContainer');
    expect(home.calls).not.toContain('stopContainer');

    await service.logs('api', { tail: 5 });
    expect(edge!.calls).toContain('containerLogs');
  });

  it('requireRunningContainer answers the container host', async () => {
    const { service, edge } = makeHosts();
    edge!.containers.push(edgeContainer());
    await expect(service.requireRunningContainer('api')).resolves.toMatchObject({
      containerId: 'c-edge',
      hostId: EDGE,
    });
  });

  it('reconciles every host, and only one when asked', async () => {
    const { service, home, edge } = makeHosts();
    home.containers.push(containerSummary());
    edge!.containers.push(edgeContainer());
    edge!.containers.push(
      containerSummary({
        id: 'c-ghost',
        name: 'pc-ghost',
        names: ['pc-ghost'],
        state: 'exited',
        labels: { 'porterclaude.managed': 'true', 'porterclaude.container': 'ghost', 'porterclaude.host': EDGE },
      }),
    );

    const all = await service.reconcile();
    expect(all).toMatchObject({ known: 2, running: 2, orphans: ['ghost'], missing: [] });

    const onlyHome = await service.reconcile({ hostId: 'default' });
    expect(onlyHome).toMatchObject({ known: 1, running: 1, orphans: [], missing: [] });
  });

  it('skips an unreachable host during reconcile instead of failing', async () => {
    const failing = stubBackend({
      listContainers: async () => {
        throw new DockerApiError('connect ECONNREFUSED', 502);
      },
    });
    const { service, home } = makeHosts({ edge: failing });
    home.containers.push(containerSummary());
    const report = await service.reconcile();
    // the dead host contributes nothing at all - not even its stored definition as "missing"
    expect(report).toMatchObject({ running: 1, orphans: [], missing: [] });
  });

  it('adopts an orphan with the host and agents from its labels', async () => {
    const { service, cfg, edge } = makeHosts({ containers: [] });
    edge!.containers.push(edgeContainer());

    const report = await service.reconcile({ adopt: true });
    expect(report.adopted).toEqual(['api']);
    const stored = cfg.containers.get('api');
    expect(stored?.hostId).toBe(EDGE);
    expect(stored?.agents).toEqual(['claude', 'opencode']);
  });

  it('falls back to the listing host when a v0.1 container carries no host label', async () => {
    const { service, cfg, edge } = makeHosts({ containers: [] });
    edge!.containers.push(
      containerSummary({
        id: 'c-old',
        name: 'pc-legacy',
        names: ['pc-legacy'],
        labels: { 'porterclaude.managed': 'true', 'porterclaude.container': 'legacy' },
      }),
    );
    await service.reconcile({ adopt: true });
    const stored = cfg.containers.get('legacy');
    expect(stored?.hostId).toBe(EDGE);
    // no agents label: the container inherits whatever the host enables
    expect(stored?.agents).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// v0.2: which agents a container mounts
// ---------------------------------------------------------------------------
describe('ContainerService.resolveAgents', () => {
  it('inherits the host set, honours an explicit list and drops unknown ids', async () => {
    const host = hostConfig({ agents: { enabled: ['claude', 'opencode'] } });
    const { service } = makeService({ host, containers: [] });

    expect(service.resolveAgents(containerConfig({ name: 'a' })).map((a) => a.id)).toEqual([
      'claude',
      'opencode',
    ]);
    expect(
      service.resolveAgents(containerConfig({ name: 'b', agents: ['opencode'] })).map((a) => a.id),
    ).toEqual(['opencode']);
    expect(
      service.resolveAgents(containerConfig({ name: 'c', agents: ['opencode', 'ghost'] })).map((a) => a.id),
    ).toEqual(['opencode']);
    expect(service.resolveAgents(containerConfig({ name: 'd', agents: [] }))).toEqual([]);
  });

  // B-8: resolveAgents DROPS unknown ids, so a typo used to be stored and echoed back in
  // `agents` forever while nothing was ever mounted. PUT /api/hosts/:id/agents 422s the same
  // input, so creating/updating a container must too.
  it('422s an unknown agent id on create and update instead of silently dropping it', async () => {
    const { service, cfg, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());
    await expect(
      service.create(containerInput({ name: 'web', agents: ['claude', 'nope'] })),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(cfg.store.getContainer('web')).toBeFalsy();

    await service.create(containerInput({ name: 'web', agents: ['claude'] }));
    await expect(
      service.update('web', containerInput({ name: 'web', agents: ['ghost'] })),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(cfg.store.getContainer('web')?.agents).toEqual(['claude']);

    // null (inherit the host) and an empty list stay legal
    await service.update('web', containerInput({ name: 'web', agents: null }));
    expect(cfg.store.getContainer('web')?.agents).toBeNull();
  });

  it('sorts by id so the spec hash does not depend on the config order', async () => {
    const host = hostConfig({ agents: { enabled: ['opencode', 'claude'] } });
    const { service } = makeService({ host, containers: [] });
    expect(service.resolveAgents(containerConfig({ name: 'a' })).map((a) => a.id)).toEqual([
      'claude',
      'opencode',
    ]);
  });

  // B-2: resolvedAgents is "what the container really mounts" (api.md), so a host-level
  // enable does NOT appear in it until the container is recreated - the session would refuse
  // that agent with 4410, and the UI must not offer a pane for it.
  it('makes a container that mounts a new agent report needsRecreate without claiming it', async () => {
    const stored = containerConfig({ name: 'web' });
    const spec = buildContainerSpec({
      agents: claudeAgent,
      container: stored,
      general: generalConfig(),
      resolvedImage: 'porterclaude/node:latest',
      imageType: 'recipe',
      instanceId: TEST_INSTANCE_ID,
    });
    // the container was created with claude only; the host now also enables opencode
    const { service, sb } = makeService({
      containers: [stored],
      host: hostConfig({ agents: { enabled: ['claude', 'opencode'] } }),
    });
    sb!.containers.push(
      containerSummary({
        labels: {
          ...containerSummary().labels,
          [CONTAINER_LABELS.agents]: spec.labels?.[CONTAINER_LABELS.agents] ?? '',
          [CONTAINER_LABELS.specHash]: spec.labels?.[CONTAINER_LABELS.specHash] ?? '',
        },
      }),
    );
    const [view] = await service.list();
    expect(view?.resolvedAgents).toEqual(['claude']);
    expect(view?.needsRecreate).toBe(true);
  });

  it('falls back to the configured agents for a v0.1 container (no label, no env)', async () => {
    const { service, sb } = makeService({
      containers: [containerConfig({ name: 'web' })],
      host: hostConfig({ agents: { enabled: ['claude', 'opencode'] } }),
    });
    sb!.containers.push(containerSummary());
    const [view] = await service.list();
    expect(view?.resolvedAgents).toEqual(['claude', 'opencode']);
  });

  it('requireRunningContainer reports the agents of the container, not of the config', async () => {
    const { service, sb } = makeService({
      containers: [containerConfig({ name: 'web' })],
      host: hostConfig({ agents: { enabled: ['claude', 'opencode'] } }),
    });
    sb!.containers.push(
      containerSummary({
        labels: { ...containerSummary().labels, [CONTAINER_LABELS.agents]: 'claude' },
      }),
    );
    await expect(service.requireRunningContainer('web')).resolves.toMatchObject({
      containerAgents: ['claude'],
    });
  });
});


// ---------------------------------------------------------------------------
// INT2-2: a host whose tools volume was never synced can only produce
// crash-looping containers (tini: exec <toolsMount>/entrypoint.sh failed)
// ---------------------------------------------------------------------------
describe('ContainerService tools-volume gate (INT2-2) - fallback without a preparer', () => {
  function toolsService(
    answer: 'ready' | 'unsynced' | 'unknown',
    opts: { containers?: ReturnType<typeof containerConfig>[] } = {},
  ) {
    const cfg = stubConfigStore(opts.containers ?? []);
    const sb = stubBackend();
    sb.images.set('porterclaude/node:latest', imageInspect());
    const probes: Array<{ hostId: string; probeImage?: string }> = [];
    const service = new ContainerService(
      serviceDeps({ config: cfg.store, hosts: stubHostManager(sb.backend) }),
      {
        toolsReadiness: async (hostId: string, o?: { probeImage?: string }) => {
          probes.push({ hostId, probeImage: o?.probeImage });
          return answer;
        },
      },
    );
    return { service, sb, cfg, probes };
  }

  it('refuses to create a container on a host whose tools volume was never synced', async () => {
    // v0.2.2: this is the FALLBACK path - a probe that can only answer readiness (no
    // ensureToolsSynced) cannot fix anything, so refusing is still the honest answer. The
    // real ImageService implements the preparer half; see the block below.
    const { service, sb, cfg, probes } = toolsService('unsynced');

    await expect(service.create(containerInput({ name: 'web' }))).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'tools_not_synced', hostId: 'default', toolsVolume: 'porterclaude-tools' },
    });
    await expect(service.create(containerInput({ name: 'web' }))).rejects.toThrow(/tools sync/i);

    // nothing was created on the engine and nothing was stored: no empty tools volume, no
    // container that restarts forever, no 201 with warnings:[]
    expect(sb.calls).not.toContain('createContainer');
    expect(sb.calls).not.toContain('createVolume');
    expect(cfg.containers.size).toBe(0);
    // the probe gets an image that provably exists on THAT engine (the container's own)
    expect(probes[0]).toEqual({ hostId: 'default', probeImage: 'porterclaude/node:latest' });
  });

  it('creates as before when the probe cannot tell (unknown never blocks)', async () => {
    const { service, sb } = toolsService('unknown');
    const view = await service.create(containerInput({ name: 'web' }));
    expect(view.name).toBe('web');
    expect(view.warnings).toEqual([]);
    expect(sb.calls).toContain('createContainer');
  });

  it('creates without a probe at all (the gate is optional)', async () => {
    const { service, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());
    await expect(service.create(containerInput({ name: 'web' }))).resolves.toMatchObject({ name: 'web' });
  });

  it('warns instead of refusing when an EXISTING container is started', async () => {
    const { service, sb } = toolsService('unsynced', { containers: [containerConfig({ name: 'web' })] });
    sb.containers.push(containerSummary({ state: 'exited' }));

    const view = await service.start('web');
    expect(sb.calls).toContain('startContainer');
    expect(view.warnings.join(' ')).toMatch(/has not been synced yet/);
    expect(view.warnings.join(' ')).toMatch(/porterclaude-tools/);
  });

  it('says nothing when the volume is ready', async () => {
    const { service, sb } = toolsService('ready', { containers: [containerConfig({ name: 'web' })] });
    sb.containers.push(containerSummary({ state: 'exited' }));
    expect((await service.start('web')).warnings).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// v0.2.2: "just do it" - a host that is not ready is PREPARED, not refused. The user
// typed a form; losing it to send them to another screen is the bug being fixed here.
// ---------------------------------------------------------------------------
describe('ContainerService preparation (v0.2.2)', () => {
  type Job = { id: string; kind: string; target: string; status: string; error: string | null };

  /**
   * The jobs are GATED: `awaitJob` blocks until the test calls `release()`. Without that the
   * whole preparation runs to completion inside the first `await` of create(), and the
   * intermediate phases (which are exactly what the UI renders) could never be observed.
   */
  function preparerService(
    opts: {
      tools?: 'ready' | 'unsynced' | 'unknown';
      imageBuilt?: boolean;
      buildFails?: boolean;
      containers?: ReturnType<typeof containerConfig>[];
    } = {},
  ) {
    const cfg = stubConfigStore(opts.containers ?? []);
    const sb = stubBackend();
    let toolsAnswer = opts.tools ?? 'unsynced';
    if (opts.imageBuilt !== false) sb.images.set('porterclaude/node:latest', imageInspect());

    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const started: string[] = [];
    const jobs = new Map<string, Job>();
    let seq = 0;
    const record = (kind: string, target: string, ok: boolean): Job => {
      seq += 1;
      const job: Job = { id: `job${seq}`, kind, target, status: ok ? 'success' : 'error', error: ok ? null : 'boom' };
      jobs.set(job.id, job);
      return job;
    };

    const service = new ContainerService(
      serviceDeps({ config: cfg.store, hosts: stubHostManager(sb.backend) }),
      {
        toolsReadiness: async () => toolsAnswer,
        ensureRecipeImage: async (_hostId: string, recipe: string) => {
          started.push(`build:${recipe}`);
          if (sb.images.has('porterclaude/node:latest')) return null;
          if (!opts.buildFails) sb.images.set('porterclaude/node:latest', imageInspect());
          return record('build', recipe, !opts.buildFails);
        },
        ensureToolsSynced: async (_hostId: string, probeImage?: string) => {
          started.push(`sync:${probeImage ?? '-'}`);
          if (toolsAnswer !== 'unsynced') return null;
          toolsAnswer = 'ready';
          return record('tools-sync', 'porterclaude-tools', true);
        },
        awaitJob: async (id: string) => {
          await gate;
          return jobs.get(id) ?? null;
        },
      },
    );
    return { service, sb, cfg, started, release: () => release() };
  }

  it('stores the definition and syncs the tools volume instead of refusing the create', async () => {
    const { service, sb, cfg, started, release } = preparerService({ tools: 'unsynced' });

    const view = await service.create(containerInput({ name: 'web' }));

    // the answer comes back immediately, and NOTHING the user typed is lost
    expect(view.preparing).toMatchObject({ phase: 'syncing-tools' });
    expect(view.preparing?.detail).toMatch(/tools volume/);
    expect(view.preparing?.jobs).toEqual([
      { id: 'job1', kind: 'tools-sync', target: 'porterclaude-tools' },
    ]);
    expect(cfg.containers.has('web')).toBe(true);
    expect(sb.calls).not.toContain('createContainer');

    release();
    await vi.waitFor(() => expect(sb.calls).toContain('createContainer'));
    await vi.waitFor(async () => expect((await service.get('web')).preparing).toBeNull());
    expect(started).toEqual(['sync:porterclaude/node:latest']);
    expect((await service.get('web')).warnings).toEqual([]);
  });

  it('builds a recipe image that does not exist yet, then syncs, then creates', async () => {
    const { service, sb, started, release } = preparerService({ imageBuilt: false, tools: 'unsynced' });

    const view = await service.create(containerInput({ name: 'web' }));
    expect(view.preparing).toMatchObject({ phase: 'building-image' });
    expect(view.preparing?.detail).toMatch(/building the 'node' image/);

    release();
    await vi.waitFor(() => expect(sb.calls).toContain('createContainer'));
    expect(started).toEqual(['build:node', 'sync:porterclaude/node:latest']);
  });

  it('keeps the definition (with a warning) when the preparation fails, so Start can retry', async () => {
    const { service, sb, cfg, release } = preparerService({ imageBuilt: false, buildFails: true });

    await service.create(containerInput({ name: 'web' }));
    release();
    await vi.waitFor(async () => expect((await service.get('web')).warnings.length).toBe(1));

    const view = await service.get('web');
    expect(view.preparing).toBeNull();
    expect(view.status).toBe('absent');
    expect(view.warnings[0]).toMatch(/building the 'node' image failed: boom/);
    // the definition is still there - that is the whole point
    expect(cfg.containers.has('web')).toBe(true);
    expect(sb.calls).not.toContain('createContainer');
  });

  it('does not prepare at all when the host is already ready (still fully synchronous)', async () => {
    const { service, sb, started } = preparerService({ tools: 'ready' });
    const view = await service.create(containerInput({ name: 'web' }));
    expect(view.preparing).toBeNull();
    expect(started).toEqual([]);
    expect(sb.calls).toContain('createContainer');
  });

  it('a second call while a preparation runs does not start a second build', async () => {
    const { service, started, release } = preparerService({ imageBuilt: false });

    await service.create(containerInput({ name: 'web' }));
    // both of these land while the first preparation is still waiting on the gate
    await service.start('web');
    await service.start('web');
    expect(started.filter((s) => s.startsWith('build:'))).toEqual(['build:node']);

    release();
  });

  it('start prepares an unsynced host instead of only warning about it', async () => {
    const { service, sb, release } = preparerService({
      tools: 'unsynced',
      containers: [containerConfig({ name: 'web' })],
    });
    sb.containers.push(containerSummary({ state: 'exited' }));

    const view = await service.start('web');
    expect(view.preparing).toMatchObject({ phase: 'syncing-tools' });
    expect(sb.calls).not.toContain('startContainer');

    release();
    await vi.waitFor(() => expect(sb.calls).toContain('startContainer'));
    await vi.waitFor(async () => expect((await service.get('web')).preparing).toBeNull());
    expect((await service.get('web')).warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// INT2-3: a `kind:file` shared path is a symlink into the auth volume, so the
// source has to exist - a dangling link kills aider on every start
// ---------------------------------------------------------------------------
describe('ContainerService file-kind agent paths (INT2-3)', () => {
  function aiderScript(sb: ReturnType<typeof stubBackend>): string {
    return (
      sb.log
        .filter((c) => c.method === 'runExec')
        .map((c) => String((c.args[1] as string[])[2]))
        .find((sc) => sc.includes('.porterclaude/agents')) ?? ''
    );
  }

  async function createWithAider() {
    const cfg = stubConfigStore([]);
    const sb = stubBackend();
    sb.images.set('porterclaude/node:latest', imageInspect());
    const service = new ContainerService(
      serviceDeps({
        config: cfg.store,
        hosts: stubHostManager(sb.backend, { host: hostConfig({ agents: { enabled: ['aider'] } }) }),
        agents: stubAgentRegistry(BUILTIN_AGENTS),
      }),
    );
    await service.create(containerInput({ name: 'web' }));
    return { sb, script: aiderScript(sb) };
  }

  it('seeds the link source of a file path so the symlink is never dangling', async () => {
    const { script } = await createWithAider();
    const conf = "'/home/dev/.porterclaude/agents/aider/aider.conf.yml'";
    // the link itself ...
    expect(script).toContain(`ln -sfn ${conf} '/home/dev/.aider.conf.yml'`);
    // ... and the file it points at, with the same `{}` seed the entrypoint writes: an empty
    // (or missing) YAML makes aider die with FileNotFoundError / "NoneType instead of dict"
    expect(script).toContain(`if [ ! -e ${conf} ]; then`);
    expect(script).toContain(`printf '%s\\n' '{}' > ${conf}`);
    expect(script).toContain(`elif [ -f ${conf} ] && [ ! -s ${conf} ]; then`);
    // the second file path of aider is seeded too
    expect(script).toContain(
      `printf '%s\\n' '{}' > '/home/dev/.porterclaude/agents/aider/aider.model.settings.yml'`,
    );
  });

  it('creates a dir path as a directory, never as a seeded file', async () => {
    const { script } = await createWithAider();
    expect(script).toContain(`mkdir -p '/home/dev/.porterclaude/agents/aider/aider'`);
    expect(script).not.toContain(`> '/home/dev/.porterclaude/agents/aider/aider' `);
  });

  it('seeds a non-structured file path with an empty file', async () => {
    const plain = {
      ...BUILTIN_AGENTS[0]!,
      id: 'plain',
      sharedPaths: [{ path: '~/.plainrc', kind: 'file' as const }],
      historyPath: null,
    };
    const cfg = stubConfigStore([]);
    const sb = stubBackend();
    sb.images.set('porterclaude/node:latest', imageInspect());
    const service = new ContainerService(
      serviceDeps({
        config: cfg.store,
        hosts: stubHostManager(sb.backend, { host: hostConfig({ agents: { enabled: ['plain'] } }) }),
        agents: stubAgentRegistry([plain]),
      }),
    );
    await service.create(containerInput({ name: 'web' }));
    const script = aiderScript(sb);
    expect(script).toContain(`: > '/home/dev/.porterclaude/agents/plain/plainrc'`);
    expect(script).not.toContain("'{}'");
  });

  it('still migrates a real file the image shipped instead of seeding over it', async () => {
    // the seed runs AFTER the replace block, so `cp -a <target> <source>` wins
    const { script } = await createWithAider();
    const cp = script.indexOf("cp -a '/home/dev/.aider.conf.yml'");
    const seed = script.indexOf("printf '%s\\n' '{}' > '/home/dev/.porterclaude/agents/aider/aider.conf.yml'");
    expect(cp).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(cp);
  });
});

// ---------------------------------------------------------------------------
// QA R1-INT2-5 / R2-INT2-6: two PorterClaude INSTALLS on one engine. Every container this
// install creates carries porterclaude.instance=<config.instanceId>; a container labelled
// for another install must be invisible here (it was listed as an adoptable orphan, with a
// session that opened into it), while an UNLABELLED container - a v0.1 / v0.2.0 container
// of THIS install - must stay visible.
// ---------------------------------------------------------------------------
describe('cross-instance isolation on a shared engine', () => {
  const foreign = () =>
    containerSummary({
      id: 'c-foreign',
      name: 'qa-a1',
      names: ['qa-a1'],
      labels: {
        'porterclaude.managed': 'true',
        'porterclaude.container': 'a1',
        [CONTAINER_LABELS.instance]: 'pc-someone-else',
      },
    });

  const legacy = () =>
    containerSummary({
      id: 'c-legacy',
      name: 'pc-old',
      names: ['pc-old'],
      labels: { 'porterclaude.managed': 'true', 'porterclaude.container': 'old' },
    });

  const mine = () =>
    containerSummary({
      id: 'c-mine',
      name: 'pc-ghost',
      names: ['pc-ghost'],
      labels: {
        'porterclaude.managed': 'true',
        'porterclaude.container': 'ghost',
        [CONTAINER_LABELS.instance]: TEST_INSTANCE_ID,
      },
    });

  it('labels every container and volume it creates with the instance id', async () => {
    const { service, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());

    await service.create(containerInput({ name: 'web' }));

    const spec = sb!.log.find((c) => c.method === 'createContainer')!.args[0] as {
      labels?: Record<string, string>;
    };
    expect(spec.labels?.[CONTAINER_LABELS.instance]).toBe(TEST_INSTANCE_ID);
    const volumes = sb!.log
      .filter((c) => c.method === 'createVolume')
      .map((c) => c.args[0] as { name: string; labels?: Record<string, string> });
    expect(volumes.length).toBeGreaterThan(0);
    for (const volume of volumes) {
      expect(volume.labels?.[CONTAINER_LABELS.instance], volume.name).toBe(TEST_INSTANCE_ID);
    }
  });

  it('lists its own and unlabelled containers, never another install\'s', async () => {
    const { service, sb } = makeService();
    sb!.containers.push(foreign(), legacy(), mine());

    const views = await service.list();
    expect(views.map((v) => v.name).sort()).toEqual(['ghost', 'old']);
    expect(views.every((v) => v.orphan)).toBe(true);
  });

  it('never adopts another install\'s container', async () => {
    const { service, cfg, sb } = makeService();
    sb!.containers.push(foreign());

    const report = await service.reconcile({ adopt: true });
    expect(report).toMatchObject({ orphans: [], adopted: [], missing: [] });
    expect([...cfg.containers.keys()]).toEqual([]);
  });

  it('does not resolve a foreign container by name (no session into it, no remove)', async () => {
    const { service, sb } = makeService();
    sb!.containers.push(foreign());

    await expect(service.requireRunningContainer('a1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.remove('a1')).rejects.toMatchObject({ code: 'not_found' });
    expect(sb!.calls).not.toContain('removeContainer');
  });

  it('still refuses to create a container whose NAME a foreign container occupies', async () => {
    const { service, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());
    sb!.containers.push(
      containerSummary({
        id: 'c-clash',
        name: 'pc-web',
        names: ['pc-web'],
        labels: {
          'porterclaude.managed': 'true',
          'porterclaude.container': 'web',
          [CONTAINER_LABELS.instance]: 'pc-someone-else',
        },
      }),
    );

    await expect(service.create(containerInput({ name: 'web' }))).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(sb!.calls).not.toContain('createContainer');
  });
});


// ---------------------------------------------------------------------------
// v0.4 (#2): the managed settings applier. A container's profile becomes
// /etc/claude-code/managed-settings.json, written by one root exec in afterStart.
// ---------------------------------------------------------------------------
describe('ContainerService profile managed settings (v0.4 #2)', () => {
  const MANAGED_PATH = '/etc/claude-code/managed-settings.json';

  function profileConfig(secrets: SecretBox, overrides: Partial<ProfileConfig> = {}): ProfileConfig {
    return ProfileConfigSchema.parse({
      id: 'zai',
      name: 'Z.ai',
      agents: {
        claude: {
          loginSet: null,
          env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
          envSecretsEnc: { ANTHROPIC_AUTH_TOKEN: secrets.encrypt('sk-secret-token') },
          settings: { model: 'glm-4.6', permissions: { defaultMode: 'acceptEdits' } },
        },
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    });
  }

  /** a stored+running container, restarted (restart() runs afterStart with the stored cfg) */
  function profileService(opts: { profile?: ProfileConfig | null; profileId?: string | null; backend?: ReturnType<typeof stubBackend> } = {}) {
    const secrets = new SecretBox('test-master-secret');
    const profile = opts.profile === undefined ? profileConfig(secrets) : opts.profile;
    const profileId = opts.profileId === undefined ? (profile ? profile.id : null) : opts.profileId;
    const stored = containerConfig({ name: 'web', profileId });
    const cfg = stubConfigStore([stored]);
    (cfg.store as unknown as { getProfile: (id: string) => ProfileConfig | null }).getProfile = (id) =>
      profile && profile.id === id ? profile : null;
    const sb = opts.backend ?? stubBackend();
    sb.containers.push(containerSummary({ id: 'c-web', name: 'pc-web', names: ['pc-web'] }));
    const hosts = stubHostManager(sb.backend);
    const service = new ContainerService({ ...serviceDeps({ config: cfg.store, hosts }), secrets });
    return { service, sb, secrets, profile };
  }

  function managedExecs(sb: ReturnType<typeof stubBackend>) {
    return sb.log
      .filter((c) => c.method === 'runExec' && String((c.args[1] as string[])[2]).includes(MANAGED_PATH))
      .map((c) => ({ script: String((c.args[1] as string[])[2]), opts: c.args[2] as { user?: string } }));
  }

  /** the JSON the script carries: `printf '%s' '<b64>' | base64 -d` */
  function decodePayload(script: string): Record<string, unknown> {
    const match = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(script);
    expect(match).toBeTruthy();
    return JSON.parse(Buffer.from(match![1] as string, 'base64').toString('utf8'));
  }

  it('writes the composed settings with one root exec', async () => {
    const { service, sb } = profileService();
    await service.restart('web');

    const execs = managedExecs(sb);
    expect(execs).toHaveLength(1);
    const { script, opts } = execs[0]!;
    expect(opts.user).toBe('0'); // only uid 0 can write /etc
    expect(script).toContain("mkdir -p '/etc/claude-code'");
    expect(script).toContain(`base64 -d > '${MANAGED_PATH}'`);
    expect(script).toContain(`chmod 0600 '${MANAGED_PATH}'`);
    expect(script).toContain(`chown "$own" '${MANAGED_PATH}'`);

    const payload = decodePayload(script);
    expect(payload.model).toBe('glm-4.6');
    expect(payload.permissions).toEqual({ defaultMode: 'acceptEdits' });
    expect(payload.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-secret-token',
    });
  });

  it('ships the DECRYPTED secret, never the stored enc:v1 blob', async () => {
    const { service, sb } = profileService();
    await service.restart('web');

    const script = managedExecs(sb)[0]!.script;
    expect(script).not.toContain('enc:v1:');
    const raw = JSON.stringify(decodePayload(script));
    expect(raw).toContain('sk-secret-token');
    expect(raw).not.toContain('enc:v1:');
  });

  it('removes a stale file when the profile no longer sets anything', async () => {
    const empty = ProfileConfigSchema.parse({
      id: 'zai',
      name: 'Z.ai',
      agents: { claude: {} },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const { service, sb } = profileService({ profile: empty });
    await service.restart('web');

    const execs = managedExecs(sb);
    expect(execs).toHaveLength(1);
    expect(execs[0]!.script).toContain(`rm -f '${MANAGED_PATH}'`);
    expect(execs[0]!.script).not.toContain('base64 -d');
  });

  it('does nothing at all for a container without a profile', async () => {
    const { service, sb } = profileService({ profile: null, profileId: null });
    await service.restart('web');
    expect(managedExecs(sb)).toHaveLength(0);
  });

  it('turns a failing exec into a warning instead of failing the start', async () => {
    const failing = stubBackend({
      runExec: async (containerId: string, cmd: string[]) =>
        String(cmd[2]).includes(MANAGED_PATH)
          ? { exitCode: 1, stdout: '', stderr: 'cannot create /etc/claude-code' }
          : { exitCode: 0, stdout: '', stderr: '' },
    });
    const { service } = profileService({ backend: failing });

    const view = await service.restart('web');
    expect(view.warnings.join(' ')).toContain('applying the profile settings failed');
    expect(view.warnings.join(' ')).toContain('cannot create /etc/claude-code');
  });

  // A dangling profile means the profile is GONE — so the file it wrote (old API key, old
  // base URL) must be cleared, not left in place. Managed settings outrank everything the
  // user can set, so leaving it would keep routing that container through a provider whose
  // profile no longer exists.
  it('clears the settings and warns when the profileId dangles', async () => {
    const { service, sb } = profileService({ profile: null, profileId: 'gone' });
    const view = await service.restart('web');

    const execs = managedExecs(sb);
    expect(execs).toHaveLength(1);
    expect(execs[0]!.script).toContain(`rm -f '${MANAGED_PATH}'`);
    expect(execs[0]!.script).not.toContain('base64 -d');
    expect(view.warnings.join(' ')).toContain("profile 'gone' no longer exists");
  });

  it('clears a stale settings file after the profile was detached from the container', async () => {
    // the container still runs the pre-detach container (needsRecreate), so its label still
    // says `porterclaude.profile` while the stored config says null
    const secrets = new SecretBox('test-master-secret');
    const stored = containerConfig({ name: 'web', profileId: null });
    const cfg = stubConfigStore([stored]);
    (cfg.store as unknown as { getProfile: () => null }).getProfile = () => null;
    const sb = stubBackend();
    sb.containers.push(containerSummary({ id: 'c-web', name: 'pc-web', names: ['pc-web'] }));
    // the running container still carries the label it was CREATED with; the stub's inspect
    // is generic, so the label is bolted on here
    const inspect = sb.backend.inspectContainer.bind(sb.backend);
    sb.backend.inspectContainer = async (id: string) => ({
      ...(await inspect(id)),
      labels: { 'porterclaude.profile': 'work' },
    });
    const service = new ContainerService({
      ...serviceDeps({ config: cfg.store, hosts: stubHostManager(sb.backend) }),
      secrets,
    });

    await service.restart('web');
    const execs = managedExecs(sb);
    expect(execs).toHaveLength(1);
    expect(execs[0]!.script).toContain(`rm -f '${MANAGED_PATH}'`);
  });
});

// ---------------------------------------------------------------------------
// v0.4 (#3): PLUGIN SYNC. Files belong to the LOGIN SET (installed by execs into the
// mounted volume, recorded in a marker at the top of it), enablement belongs to the
// PROFILE (`enabledPlugins` in the managed settings — no exec at all).
// ---------------------------------------------------------------------------
describe('ContainerService profile plugin sync (v0.4 #3)', () => {
  const MARKER = '/home/dev/.porterclaude/agents/claude/.porterclaude-plugins.json';
  const MANAGED_PATH = '/etc/claude-code/managed-settings.json';

  interface ExecCall {
    cmd: string[];
    opts?: { user?: string; timeoutMs?: number };
  }

  function pluginProfile(
    overrides: {
      id?: string;
      loginSet?: string | null;
      plugins?: string[];
      marketplaces?: Array<{ name: string; source: string }>;
    } = {},
  ): ProfileConfig {
    return ProfileConfigSchema.parse({
      id: overrides.id ?? 'zai',
      name: 'Z.ai',
      agents: {
        claude: {
          loginSet: overrides.loginSet ?? null,
          plugins: (overrides.plugins ?? ['fmt@acme']).map((ref) => ({ ref })),
          marketplaces: overrides.marketplaces ?? [],
        },
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }

  /**
   * A restartable stored container plus a backend whose runExec is scripted: the marker
   * `cat` answers with `marker`, and a `claude plugin install <ref>` listed in
   * `failInstalls` fails the way an unreachable marketplace does.
   */
  function pluginService(
    opts: {
      profile?: ProfileConfig | null;
      marker?: { syncedAt: string; installed: string[] } | null;
      failInstalls?: string[];
      /** what `claude plugin install --help` advertises (2.1.224 advertises NEITHER) */
      cliFlags?: { yes?: boolean; scope?: boolean };
    } = {},
  ) {
    const profile = opts.profile === undefined ? pluginProfile() : opts.profile;
    const calls: ExecCall[] = [];
    const backend = stubBackend({
      runExec: async (_id: string, cmd: string[], execOpts?: { user?: string; timeoutMs?: number }) => {
        calls.push({ cmd, opts: execOpts });
        if (cmd[0] === 'sh' && String(cmd[2]).startsWith('cat ')) {
          return { exitCode: 0, stdout: opts.marker ? JSON.stringify(opts.marker) : '', stderr: '' };
        }
        if (cmd[0] === 'claude' && cmd[1] === 'plugin' && cmd[3] === '--help') {
          const f = opts.cliFlags ?? {};
          const optionLines = [
            '  --config <key=value>  Set a userConfig option',
            '  -h, --help            Display help for command',
            ...(f.scope ? ['  -s, --scope <scope>   Installation scope (default: "user")'] : []),
            ...(f.yes ? ['  -y, --yes             Skip confirmation prompts'] : []),
          ].join('\n');
          const help = 'Usage: claude plugin install [options] <plugin>\n\nOptions:\n' + optionLines + '\n';
          return { exitCode: 0, stdout: help, stderr: '' };
        }
        if (cmd[0] === 'claude' && (opts.failInstalls ?? []).includes(String(cmd[3]))) {
          return { exitCode: 1, stdout: '', stderr: 'marketplace not found' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const stored = containerConfig({ name: 'web', profileId: profile ? profile.id : null });
    const cfg = stubConfigStore([stored]);
    (cfg.store as unknown as { getProfile: (id: string) => ProfileConfig | null }).getProfile = (id) =>
      profile && profile.id === id ? profile : null;
    backend.containers.push(containerSummary({ id: 'c-web', name: 'pc-web', names: ['pc-web'] }));
    const hosts = stubHostManager(backend.backend);
    const secrets = new SecretBox('test-master-secret');
    const service = new ContainerService({ ...serviceDeps({ config: cfg.store, hosts }), secrets });
    return { service, calls, backend };
  }

  /** the install/uninstall execs — NOT the `--help` capability probe that precedes them */
  const pluginExecs = (calls: ExecCall[]) =>
    calls.filter((c) => c.cmd[0] === 'claude' && c.cmd[1] === 'plugin' && !c.cmd.includes('--help'));
  const helpProbes = (calls: ExecCall[]) => calls.filter((c) => c.cmd.includes('--help'));
  const markerWrites = (calls: ExecCall[]) =>
    calls.filter(
      (c) => c.cmd[0] === 'sh' && String(c.cmd[2]).includes(MARKER) && String(c.cmd[2]).includes('base64 -d'),
    );

  function decodeScriptPayload(script: string): Record<string, unknown> {
    const match = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(script);
    expect(match).toBeTruthy();
    return JSON.parse(Buffer.from(match![1] as string, 'base64').toString('utf8'));
  }

  it('fast path: an up-to-date marker costs zero plugin execs', async () => {
    const { service, calls } = pluginService({
      marker: { syncedAt: '2026-01-01T00:00:00.000Z', installed: ['fmt@acme'] },
    });
    await service.restart('web');

    expect(pluginExecs(calls)).toHaveLength(0);
    expect(markerWrites(calls)).toHaveLength(0);
    // exactly one marker read, and no network at all
    expect(calls.filter((c) => c.cmd[0] === 'sh' && String(c.cmd[2]).startsWith('cat '))).toHaveLength(1);
  });

  it('installs a missing ref as the CONTAINER USER, never as uid 0', async () => {
    const { service, calls } = pluginService({ marker: null });
    await service.restart('web');

    const execs = pluginExecs(calls);
    expect(execs).toHaveLength(1);
    // NO -y: claude 2.1.224's `plugin install` does not advertise it and commander rejects
    // unknown options, so passing it unconditionally failed EVERY install — found by pointing
    // the #4 probe at a real container. The flags are measured per run, see the next test.
    expect(execs[0]!.cmd).toEqual(['claude', 'plugin', 'install', 'fmt@acme']);
    expect(execs[0]!.opts?.user).toBeUndefined(); // root-owned ~/.claude breaks the next /login
    expect(execs[0]!.opts?.timeoutMs).toBe(180_000);

    const writes = markerWrites(calls);
    expect(writes).toHaveLength(1);
    expect(decodeScriptPayload(writes[0]!.cmd[2] as string).installed).toEqual(['fmt@acme']);
  });

  it('passes only the flags the installed CLI advertises', async () => {
    // a build that DOES advertise them gets them...
    const rich = pluginService({ marker: null, cliFlags: { yes: true, scope: true } });
    await rich.service.restart('web');
    expect(pluginExecs(rich.calls)[0]!.cmd).toEqual([
      'claude', 'plugin', 'install', 'fmt@acme', '--scope', 'user', '-y',
    ]);

    // ...and a build whose help cannot be read at all falls back to the bare command, which
    // is the only form that works everywhere
    const blind = pluginService({ marker: null, cliFlags: {} });
    await blind.service.restart('web');
    expect(pluginExecs(blind.calls)[0]!.cmd).toEqual(['claude', 'plugin', 'install', 'fmt@acme']);

    // the capability probe itself is read-only and runs once
    expect(helpProbes(blind.calls).map((c) => c.cmd)).toEqual([
      ['claude', 'plugin', 'install', '--help'],
    ]);
  });

  it('uninstalls a dropped ref on a PRIVATE login set', async () => {
    const { service, calls } = pluginService({
      profile: pluginProfile({ loginSet: null, plugins: ['fmt@acme'] }),
      marker: { syncedAt: 'x', installed: ['fmt@acme', 'old@acme'] },
    });
    await service.restart('web');

    // the FULL ref, not the bare name: that is the form the plugin docs' own example uses,
    // and it disambiguates two marketplaces shipping the same plugin name
    expect(pluginExecs(calls).map((c) => c.cmd)).toEqual([['claude', 'plugin', 'uninstall', 'old@acme']]);
    expect(decodeScriptPayload(markerWrites(calls)[0]!.cmd[2] as string).installed).toEqual(['fmt@acme']);
  });

  it('never uninstalls on a SHARED login set — it only forgets the ref', async () => {
    for (const loginSet of ['default', 'team']) {
      const { service, calls } = pluginService({
        profile: pluginProfile({ loginSet, plugins: ['fmt@acme'] }),
        marker: { syncedAt: 'x', installed: ['fmt@acme', 'old@acme'] },
      });
      await service.restart('web');

      expect(pluginExecs(calls)).toHaveLength(0);
      expect(decodeScriptPayload(markerWrites(calls)[0]!.cmd[2] as string).installed).toEqual(['fmt@acme']);
    }
  });

  it('turns a failing install into a warning and does not record the ref', async () => {
    const { service, calls } = pluginService({
      profile: pluginProfile({ plugins: ['fmt@acme', 'bad@acme'] }),
      marker: null,
      failInstalls: ['bad@acme'],
    });

    const view = await service.restart('web');
    expect(view.warnings.join(' ')).toContain("installing the plugin 'bad@acme' failed");
    expect(view.warnings.join(' ')).toContain('marketplace not found');
    expect(decodeScriptPayload(markerWrites(calls)[0]!.cmd[2] as string).installed).toEqual(['fmt@acme']);
  });

  it('does nothing at all without a profile, or with an empty plugin list', async () => {
    const none = pluginService({ profile: null });
    await none.service.restart('web');
    expect(pluginExecs(none.calls)).toHaveLength(0);
    expect(none.calls.some((c) => String(c.cmd[2] ?? '').includes(MARKER))).toBe(false);

    const empty = pluginService({ profile: pluginProfile({ plugins: [] }) });
    await empty.service.restart('web');
    expect(pluginExecs(empty.calls)).toHaveLength(0);
    expect(empty.calls.some((c) => String(c.cmd[2] ?? '').includes(MARKER))).toBe(false);
  });

  it('enables the plugins and declares the marketplaces in the managed settings', async () => {
    const { service, calls } = pluginService({
      profile: pluginProfile({
        plugins: ['fmt@acme', 'lint@acme'],
        marketplaces: [
          { name: 'acme', source: 'acme/plugins' },
          { name: 'internal', source: 'https://git.example.com/plugins.git' },
        ],
      }),
      marker: { syncedAt: 'x', installed: ['fmt@acme', 'lint@acme'] },
    });
    await service.restart('web');

    const managed = calls.find((c) => c.cmd[0] === 'sh' && String(c.cmd[2]).includes(MANAGED_PATH));
    expect(managed).toBeTruthy();
    const payload = decodeScriptPayload(managed!.cmd[2] as string);
    expect(payload.enabledPlugins).toEqual({ 'fmt@acme': true, 'lint@acme': true });
    expect(payload.extraKnownMarketplaces).toEqual({
      acme: { source: { source: 'github', repo: 'acme/plugins' } },
      internal: { source: { source: 'git', url: 'https://git.example.com/plugins.git' } },
    });
  });
});
