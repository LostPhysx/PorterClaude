// OWNER: B2. SessionService against a stubbed DockerBackend (no docker host).
import { describe, expect, it } from 'vitest';
import { AppError, DockerApiError } from '../../src/http/errors.js';
import { CONTAINER_LABELS, SessionConfigSchema, SessionInputSchema } from '../../src/sessions/model.js';
import type { ContainerInspect } from '../../src/backends/types.js';
import { buildContainerSpec } from '../../src/sessions/container.js';
import { SessionService } from '../../src/sessions/service.js';
import {
  containerSummary,
  generalConfig,
  imageInspect,
  serviceDeps,
  sessionConfig,
  sessionInput,
  stubBackend,
  stubBackendManager,
  stubConfigStore,
} from './helpers.js';

function makeService(opts: {
  sessions?: ReturnType<typeof sessionConfig>[];
  backend?: ReturnType<typeof stubBackend> | null;
} = {}) {
  const cfg = stubConfigStore(opts.sessions ?? []);
  const sb = opts.backend === undefined ? stubBackend() : opts.backend;
  const manager = stubBackendManager(sb ? sb.backend : null);
  const service = new SessionService(serviceDeps({ config: cfg.store, backends: manager }));
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
      SessionInputSchema.safeParse({ name: 'web', image: { type: 'recipe', recipe: 'node' }, workspace: bad })
        .success,
    ).toBe(false);
    expect(
      SessionConfigSchema.safeParse({ ...sessionConfig({ name: 'web' }), workspace: bad }).success,
    ).toBe(true);
  });
});

describe('SessionService.create', () => {
  it('creates volumes, then the container, then starts it, and persists only afterwards', async () => {
    const { service, cfg, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());

    const view = await service.create(sessionInput({ name: 'web' }));

    const order = sb!.calls.filter((c) =>
      ['createVolume', 'createContainer', 'startContainer'].includes(c),
    );
    expect(order[order.length - 3]).toBe('createVolume');
    expect(order[order.length - 2]).toBe('createContainer');
    expect(order[order.length - 1]).toBe('startContainer');
    expect(sb!.calls.indexOf('createContainer')).toBeLessThan(sb!.calls.indexOf('startContainer'));

    // shared volumes + the workspace volume were ensured before the container was created
    const volumeNames = sb!.log.filter((c) => c.method === 'createVolume').map((c) => (c.args[0] as { name: string }).name);
    expect(volumeNames).toEqual(['porterclaude-claude', 'porterclaude-claude-home', 'porterclaude-ws-web']);

    expect(cfg.sessions.get('web')).toBeTruthy();
    expect(cfg.sessions.get('web')?.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(view.name).toBe('web');
  });

  it('does not persist and rolls the container back when the config write fails', async () => {
    const { service, cfg, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());
    (cfg.store as unknown as { putSession: () => Promise<never> }).putSession = () => {
      throw new Error('disk full');
    };

    await expect(service.create(sessionInput({ name: 'web' }))).rejects.toThrow('disk full');
    expect(sb!.calls).toContain('removeContainer');
    expect(cfg.sessions.has('web')).toBe(false);
    // BE-9: the volume created for that session goes with it
    expect(sb!.log.filter((c) => c.method === 'removeVolume').map((c) => c.args[0])).toEqual([
      'porterclaude-ws-web',
    ]);
  });

  it('refuses a duplicate name (stored config)', async () => {
    const { service } = makeService({ sessions: [sessionConfig({ name: 'web' })] });
    await expect(service.create(sessionInput({ name: 'web' }))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses a duplicate name (existing container)', async () => {
    const { service, sb } = makeService();
    sb!.containers.push(containerSummary());
    await expect(service.create(sessionInput({ name: 'web' }))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('reports a clear conflict when the recipe image is not built', async () => {
    const { service } = makeService();
    await expect(service.create(sessionInput({ name: 'web' }))).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('not built'),
    });
  });

  it('pulls a custom image that is missing locally', async () => {
    const { service, sb } = makeService();
    await service.create(sessionInput({ name: 'web', image: { type: 'custom', ref: 'nginx:1.27' } }));
    expect(sb!.calls).toContain('pullImage');
  });

  // BE-9: a failed create must not leave porterclaude-ws-<slug> behind
  it('creates no session volume when the image cannot be resolved', async () => {
    const { service, sb } = makeService();
    await expect(service.create(sessionInput({ name: 'web' }))).rejects.toMatchObject({ code: 'conflict' });
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
      service.create(sessionInput({ name: 'web', shareHistory: false })),
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

    await expect(service.create(sessionInput({ name: 'web' }))).rejects.toThrow('boom');
    expect(sb.calls).not.toContain('removeVolume');
  });
});

describe('SessionService.update / recreate', () => {
  it('stops, removes and recreates the container without removing volumes', async () => {
    const stored = sessionConfig({ name: 'web' });
    const { service, sb } = makeService({ sessions: [stored] });
    sb!.images.set('porterclaude/node:latest', imageInspect());
    sb!.containers.push(containerSummary());

    await service.update('web', sessionInput({ name: 'web', env: { FOO: 'bar' } }));

    expect(sb!.calls).toContain('stopContainer');
    expect(sb!.calls).toContain('removeContainer');
    expect(sb!.calls.indexOf('removeContainer')).toBeLessThan(sb!.calls.indexOf('createContainer'));
    const remove = sb!.log.find((c) => c.method === 'removeContainer');
    expect((remove?.args[1] as { removeVolumes?: boolean }).removeVolumes).toBe(false);
    expect(sb!.calls).not.toContain('removeVolume');
  });

  it('rejects a renamed session', async () => {
    const { service } = makeService({ sessions: [sessionConfig({ name: 'web' })] });
    await expect(service.update('web', sessionInput({ name: 'other' }))).rejects.toBeInstanceOf(AppError);
  });

  it('recreate keeps the stored config', async () => {
    const stored = sessionConfig({ name: 'web', env: { KEEP: '1' } });
    const { service, cfg, sb } = makeService({ sessions: [stored] });
    sb!.images.set('porterclaude/node:latest', imageInspect());
    await service.recreate('web');
    expect(cfg.sessions.get('web')?.env).toEqual({ KEEP: '1' });
  });
});

describe('SessionService.remove', () => {
  it('never removes the shared volumes and only drops the session volumes on request', async () => {
    const { service, cfg, sb } = makeService({ sessions: [sessionConfig({ name: 'web' })] });
    sb!.containers.push(containerSummary());

    await service.remove('web', { removeVolumes: true });

    const removed = sb!.log.filter((c) => c.method === 'removeVolume').map((c) => c.args[0]);
    expect(removed).toEqual(['porterclaude-ws-web', 'porterclaude-hist-web']);
    expect(removed).not.toContain('porterclaude-claude');
    expect(removed).not.toContain('porterclaude-claude-home');
    expect(removed).not.toContain('porterclaude-tools');
    expect(cfg.sessions.has('web')).toBe(false);
  });

  it('keeps the volumes by default', async () => {
    const { service, sb } = makeService({ sessions: [sessionConfig({ name: 'web' })] });
    sb!.containers.push(containerSummary());
    await service.remove('web');
    expect(sb!.calls).not.toContain('removeVolume');
  });

  it('404s for an unknown session', async () => {
    const { service } = makeService();
    await expect(service.remove('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('SessionService.list', () => {
  it('merges stored configs with live containers', async () => {
    const { service, sb } = makeService({ sessions: [sessionConfig({ name: 'web' })] });
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
    sb!.containers.push(containerSummary({ labels: { ...containerSummary().labels, 'porterclaude.session': 'ghost' } }));
    const views = await service.list();
    expect(views).toHaveLength(1);
    expect(views[0]?.name).toBe('ghost');
    expect(views[0]?.orphan).toBe(true);
  });

  it('flags needsRecreate when the container spec-hash differs', async () => {
    const stored = sessionConfig({ name: 'web' });
    const { service, sb } = makeService({ sessions: [stored] });
    sb!.containers.push(
      containerSummary({
        labels: { ...containerSummary().labels, [CONTAINER_LABELS.specHash]: 'stale' },
      }),
    );
    const [view] = await service.list();
    expect(view?.needsRecreate).toBe(true);
  });

  it('does not flag needsRecreate when the hash matches', async () => {
    const stored = sessionConfig({ name: 'web' });
    const spec = buildContainerSpec({
      session: stored,
      general: generalConfig(),
      resolvedImage: 'porterclaude/node:latest',
      imageType: 'recipe',
    });
    const { service, sb } = makeService({ sessions: [stored] });
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
      sessions: [sessionConfig({ name: 'web' })],
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
      sessions: [sessionConfig({ name: 'web' })],
      backend: backendRunningImage('sha256:current'),
    });
    sb!.containers.push(containerSummary({ imageId: 'sha256:current' }));
    sb!.images.set('porterclaude/node:latest', imageInspect({ id: 'sha256:current' }));

    const [view] = await service.list();
    expect(view?.imageOutdated).toBe(false);
    expect(view?.resolvedImage).toBe('porterclaude/node:latest');
  });

  it('never flags imageOutdated for a session with no container', async () => {
    const { service, sb } = makeService({ sessions: [sessionConfig({ name: 'web' })] });
    sb!.images.set('porterclaude/node:latest', imageInspect({ id: 'sha256:rebuilt' }));
    const [view] = await service.list();
    expect(view?.status).toBe('absent');
    expect(view?.imageOutdated).toBe(false);
    expect(view?.containerImage).toBeNull();
  });

  // INT-03: such a config can exist (it was accepted before the rule); listing must not
  // blow up because buildContainerSpec now refuses to mount it.
  it('keeps listing a session whose stored hostPath escapes workspacesRoot', async () => {
    const stored = { ...sessionConfig({ name: 'web' }), workspace: { type: 'bind' as const, hostPath: '../../etc' } };
    const { service, sb } = makeService({ sessions: [stored] });
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
    const { service } = makeService({ sessions: [sessionConfig({ name: 'web' })], backend: failing });
    const views = await service.list();
    expect(views).toHaveLength(1);
    expect(views[0]?.status).toBe('absent');
    expect(views[0]?.warnings.join(' ')).toContain('docker backend unavailable');
  });

  it('degrades when no backend is configured at all', async () => {
    const { service } = makeService({ sessions: [sessionConfig({ name: 'web' })], backend: null });
    const views = await service.list();
    expect(views[0]?.status).toBe('absent');
    expect(views[0]?.warnings.length).toBeGreaterThan(0);
  });
});

describe('SessionService.reconcile / requireRunningContainer', () => {
  it('reports known, running, orphans and missing', async () => {
    const { service, sb } = makeService({
      sessions: [sessionConfig({ name: 'web' }), sessionConfig({ name: 'gone' })],
    });
    sb!.containers.push(containerSummary());
    sb!.containers.push(
      containerSummary({
        id: 'c2',
        name: 'pc-ghost',
        names: ['pc-ghost'],
        state: 'exited',
        labels: { 'porterclaude.managed': 'true', 'porterclaude.session': 'ghost' },
      }),
    );
    const report = await service.reconcile();
    expect(report).toEqual({ known: 2, running: 1, orphans: ['ghost'], adopted: [], missing: ['gone'] });
  });

  it('resolves a running container for the terminal layer', async () => {
    const { service, sb } = makeService({ sessions: [sessionConfig({ name: 'web' })] });
    sb!.containers.push(containerSummary());
    await expect(service.requireRunningContainer('web')).resolves.toMatchObject({ containerId: 'c1' });
  });

  it('throws not_found for an unknown session and conflict for a stopped one', async () => {
    const { service, sb } = makeService({ sessions: [sessionConfig({ name: 'web' })] });
    await expect(service.requireRunningContainer('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.requireRunningContainer('web')).rejects.toMatchObject({ code: 'conflict' });

    sb!.containers.push(containerSummary({ state: 'exited' }));
    await expect(service.requireRunningContainer('web')).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('SessionService.logs / stop / start', () => {
  it('reads container logs', async () => {
    const { service, sb } = makeService({ sessions: [sessionConfig({ name: 'web' })] });
    sb!.containers.push(containerSummary());
    await expect(service.logs('web', { tail: 10 })).resolves.toBe('log output');
    const call = sb!.log.find((c) => c.method === 'containerLogs');
    expect(call?.args[1]).toMatchObject({ tail: 10, timestamps: false });
  });

  it('stops a running container and starts a stopped one', async () => {
    const { service, sb } = makeService({ sessions: [sessionConfig({ name: 'web' })] });
    sb!.containers.push(containerSummary());
    await service.stop('web');
    expect(sb!.calls).toContain('stopContainer');

    sb!.containers[0] = containerSummary({ state: 'exited' });
    await service.start('web');
    expect(sb!.calls).toContain('startContainer');
  });
});

describe('SessionService private history (BE-2)', () => {
  const initMounts = (sb: ReturnType<typeof stubBackend>) =>
    sb.log
      .filter((c) => c.method === 'createContainer')
      .map((c) => c.args[0] as { name: string; mounts?: Array<{ source: string; target: string }> });

  it('pre-creates ~/.claude/projects with the shared volume ownership before the session container', async () => {
    const { service, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());

    await service.create(sessionInput({ name: 'web', shareHistory: false }));

    const created = initMounts(sb!);
    expect(created).toHaveLength(2);
    const init = created[0]!;
    const session = created[1]!;
    expect(init.name).toMatch(/^porterclaude-histinit-/);
    expect(session.name).toBe('pc-web');

    // the shared volume is mounted at its REAL path so docker's empty-volume seeding keeps
    // the recipe's uid-1000 ownership; the history volume gets a scratch path
    expect(init.mounts).toContainEqual({
      type: 'volume',
      source: 'porterclaude-claude',
      target: '/home/dev/.claude',
      readOnly: false,
    });
    expect(init.mounts).toContainEqual({
      type: 'volume',
      source: 'porterclaude-hist-web',
      target: '/pc-hist',
      readOnly: false,
    });

    const spec = sb!.log.find((c) => c.method === 'createContainer')!.args[0] as {
      user?: string;
      cmd?: string[];
      labels?: Record<string, string>;
    };
    expect(spec.user).toBe('0:0');
    expect(spec.cmd?.[0]).toContain('mkdir -p');
    expect(spec.cmd?.[0]).toContain("chown \"$own\"");
    // must never look like a session to reconcile/list
    expect(spec.labels?.['porterclaude.managed']).toBeUndefined();

    // and the helper container is cleaned up again
    expect(sb!.calls.filter((c) => c === 'removeContainer')).toHaveLength(1);
  });

  it('does not run the volume-init container for shared-history sessions', async () => {
    const { service, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());
    await service.create(sessionInput({ name: 'web' }));
    expect(initMounts(sb!).map((c) => c.name)).toEqual(['pc-web']);
    expect(sb!.calls).not.toContain('waitContainer');
  });

  it('turns a failing volume-init into a warning instead of failing the create', async () => {
    const sb = stubBackend({ waitContainer: async () => ({ statusCode: 7 }) });
    const { service } = makeService({ backend: sb });
    sb.images.set('porterclaude/node:latest', imageInspect());

    const view = await service.create(sessionInput({ name: 'web', shareHistory: false }));
    expect(view.warnings.join(' ')).toContain('private history volume failed');
  });

  it('repairs ~/.claude/projects ownership on every start', async () => {
    const { service, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());
    await service.create(sessionInput({ name: 'web' }));

    const exec = sb!.log.find(
      (c) => c.method === 'runExec' && String((c.args[1] as string[])[2]).includes('.claude/projects'),
    );
    expect(exec).toBeTruthy();
    expect((exec!.args[2] as { user?: string }).user).toBe('0');
    expect((exec!.args[1] as string[])[2]).toContain("chown \"$own\"");
  });
});

describe('SessionService orphan adoption (BE-5)', () => {
  const ghost = () =>
    containerSummary({
      id: 'c9',
      name: 'pc-ghost',
      names: ['pc-ghost'],
      state: 'exited',
      labels: {
        'porterclaude.managed': 'true',
        'porterclaude.session': 'ghost',
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
    expect(cfg.sessions.has('ghost')).toBe(true);
    expect(view.orphan).toBe(false);
  });

  it('recreates an orphan instead of 404ing', async () => {
    const { service, cfg, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());
    sb!.containers.push(ghost());

    await service.recreate('ghost');
    expect(cfg.sessions.get('ghost')?.image).toEqual({ type: 'recipe', recipe: 'node' });
    expect(sb!.calls).toContain('removeContainer');
    expect(sb!.calls).toContain('createContainer');
  });

  it('updates an orphan instead of 404ing', async () => {
    const { service, cfg, sb } = makeService();
    sb!.images.set('porterclaude/node:latest', imageInspect());
    sb!.containers.push(ghost());

    await service.update('ghost', sessionInput({ name: 'ghost', env: { FOO: 'bar' } }));
    expect(cfg.sessions.get('ghost')?.env).toEqual({ FOO: 'bar' });
  });

  it('still 404s when neither a config nor a container exists', async () => {
    const { service } = makeService();
    await expect(service.start('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.recreate('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.update('nope', sessionInput({ name: 'nope' }))).rejects.toMatchObject({
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
    expect(cfg.sessions.has('ghost')).toBe(false);
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
    expect(cfg.sessions.has('ghost')).toBe(true);
    const [view] = await service.list();
    expect(view?.orphan).toBe(false);
    // a freshly adopted definition describes THAT container: no recreate nag
    expect(view?.needsRecreate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BE-7: adoption must not lose ports/env/limits/mounts/network/restart policy
// ---------------------------------------------------------------------------
describe('SessionService orphan reconstruction (BE-7)', () => {
  const orphanContainer = () =>
    containerSummary({
      id: 'c9',
      name: 'pc-qa-shared',
      names: ['pc-qa-shared'],
      image: 'alpine:3.20',
      state: 'running',
      labels: {
        'porterclaude.managed': 'true',
        'porterclaude.session': 'qa-shared',
        'porterclaude.image-type': 'custom',
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
      'PORTERCLAUDE_TOOLS=/opt/porterclaude',
      'PORTERCLAUDE_HOME=/home/dev',
      'HOME=/home/dev',
      'TERM=xterm-256color',
      'FOO=bar',
    ],
    mounts: [
      { type: 'volume', name: 'porterclaude-claude', destination: '/home/dev/.claude', readOnly: false },
      { type: 'volume', name: 'porterclaude-claude-home', destination: '/home/dev/.claude-home', readOnly: false },
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
    const stored = cfg.sessions.get('qa-shared');
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
describe('SessionService custom-image bootstrap (BE-6)', () => {
  function homeExecs(sb: ReturnType<typeof stubBackend>) {
    return sb.log.filter((c) => c.method === 'runExec');
  }

  it('chowns the container home and re-runs the tools bootstrap for a non-root custom image', async () => {
    const { service, sb } = makeService();
    sb!.images.set('alpine:3.20', imageInspect({ tags: ['alpine:3.20'], env: ['PATH=/usr/bin:/bin'] }));

    await service.create(
      sessionInput({ name: 'usr', image: { type: 'custom', ref: 'alpine:3.20' }, user: '1000:1000' }),
    );

    const chown = homeExecs(sb!).find((c) => String((c.args[1] as string[])[2]).includes('chown'));
    expect(chown).toBeTruthy();
    expect((chown!.args[2] as { user?: string }).user).toBe('0');
    expect((chown!.args[1] as string[])[2]).toContain("'/home/dev'");

    const boot = homeExecs(sb!).find((c) =>
      String((c.args[1] as string[])[2]).includes('--porterclaude-bootstrap'),
    );
    expect(boot).toBeTruthy();
    // runs as the session user (no user override), so the files land with the right owner
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
      sessionInput({ name: 'usr', image: { type: 'custom', ref: 'alpine:3.20' }, user: '1000:1000' }),
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
    const stored = sessionConfig({
      name: 'usr',
      image: { type: 'custom', ref: 'alpine:3.20' },
      user: '1000:1000',
    });
    const container = containerSummary({
      id: 'c-usr',
      name: 'pc-usr',
      names: ['pc-usr'],
      image: 'alpine:3.20',
      labels: { 'porterclaude.managed': 'true', 'porterclaude.session': 'usr' },
    });

    const withConfig = makeService({ sessions: [stored] });
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
    expect(orphaned.cfg.sessions.has('usr')).toBe(false);
  });

  it('does not touch the home of a root custom image or of a recipe session', async () => {
    const { service, sb } = makeService();
    sb!.images.set('alpine:3.20', imageInspect({ tags: ['alpine:3.20'] }));
    sb!.images.set('porterclaude/node:latest', imageInspect());

    await service.create(sessionInput({ name: 'root-img', image: { type: 'custom', ref: 'alpine:3.20' } }));
    await service.create(sessionInput({ name: 'web' }));

    const chowns = homeExecs(sb!).filter((c) =>
      String((c.args[1] as string[])[2]).includes('chmod u+rwx'),
    );
    expect(chowns).toHaveLength(0);
  });
});
