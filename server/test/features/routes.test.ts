// OWNER: B2. The /api/sessions and /api/hosts/:hostId/images route tables (api.md v0.2),
// mounted on a bare express app with stubbed services so no B1 runtime code is required.
// v0.2: images/jobs/tools are HOST SCOPED (the router runs with mergeParams and hands the
// host id to every ImageService call); sessions stay flat because names are unique.
import { describe, expect, it, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AppContext } from '../../src/context.js';
import { AppError, toAppError } from '../../src/http/errors.js';
import { createSessionsRouter } from '../../src/sessions/routes.js';
import { createImagesRouter } from '../../src/images/routes.js';
import type { SessionView } from '../../src/sessions/model.js';

interface Recorded {
  method: string;
  args: unknown[];
}

const view = (name: string): SessionView => ({
  name,
  hostId: 'default',
  hostName: 'Local docker',
  hostMissing: false,
  agents: null,
  resolvedAgents: ['claude'],
  image: { type: 'recipe', recipe: 'node' },
  workspace: { type: 'volume' },
  env: {},
  ports: [],
  extraMounts: [],
  limits: {},
  shareHistory: true,
  autoStart: true,
  network: null,
  user: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'running',
  containerId: 'c1',
  containerName: `pc-${name}`,
  resolvedImage: 'porterclaude/node:latest',
  containerImage: 'porterclaude/node:latest',
  imageOutdated: false,
  startedAt: null,
  uptimeSec: null,
  runtimePorts: [],
  needsRecreate: false,
  orphan: false,
  warnings: [],
});

const job = {
  id: 'j1',
  hostId: 'default',
  kind: 'build' as const,
  target: 'node',
  status: 'running' as const,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: null,
  error: null,
  lineCount: 0,
};

let calls: Recorded[];

function makeApp() {
  calls = [];
  const rec = <T>(method: string, args: unknown[], value: T): T => {
    calls.push({ method, args });
    return value;
  };

  const ctx = {
    sessions: {
      list: async (opts: unknown) => rec('list', [opts], [view('web')]),
      get: async (name: string) => rec('get', [name], view(name)),
      create: async (input: unknown) => rec('create', [input], view('web')),
      update: async (name: string, input: unknown) => rec('update', [name, input], view(name)),
      remove: async (name: string, opts: unknown) => rec('remove', [name, opts], undefined),
      start: async (name: string) => rec('start', [name], view(name)),
      stop: async (name: string) => rec('stop', [name], view(name)),
      restart: async (name: string) => rec('restart', [name], view(name)),
      recreate: async (name: string) => rec('recreate', [name], view(name)),
      logs: async (name: string, opts: unknown) => rec('logs', [name, opts], 'hello'),
      reconcile: async (opts: unknown) =>
        rec('reconcile', [opts], { known: 1, running: 1, orphans: [], adopted: ['ghost'], missing: [] }),
    },
    images: {
      listImages: async (hostId: string) => rec('listImages', [hostId], []),
      recipeStatuses: async (hostId: string) => rec('recipeStatuses', [hostId], []),
      buildRecipe: async (hostId: string, name: string, opts: unknown) =>
        rec('buildRecipe', [hostId, name, opts], job),
      pull: async (hostId: string, image: string) => rec('pull', [hostId, image], job),
      toolsStatus: async (hostId: string) =>
        rec('toolsStatus', [hostId], { hostId, volume: 'porterclaude-tools', agents: [] }),
      syncTools: async (hostId: string, opts: unknown) => rec('syncTools', [hostId, opts], job),
      validateCustomImage: async (hostId: string, image: string) =>
        rec('validateCustomImage', [hostId, image], { image, ok: true }),
      listJobs: (hostId?: string) => rec('listJobs', [hostId], [job]),
      // a job of ANOTHER host does not exist for this one
      getJob: (id: string, hostId?: string) =>
        rec('getJob', [id, hostId], id === 'j1' && hostId === 'default' ? job : null),
      getJobLines: (id: string, since: number, hostId?: string) =>
        rec('getJobLines', [id, since, hostId], { lines: ['a'], nextIndex: 1 }),
      cancelJob: (id: string, hostId?: string) => rec('cancelJob', [id, hostId], job),
    },
  } as unknown as AppContext;

  const app = express();
  app.use(express.json());
  app.use('/api/sessions', createSessionsRouter(ctx));
  app.use('/api/hosts/:hostId/images', createImagesRouter(ctx));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'no such route' } });
  });
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction): void => {
      const appErr: AppError = toAppError(err);
      res.status(appErr.status).json(appErr.toBody());
    },
  );
  return app;
}

const body = { name: 'web', image: { type: 'recipe', recipe: 'node' } };

beforeEach(() => {
  calls = [];
});

describe('/api/sessions', () => {
  it('GET / lists sessions', async () => {
    const res = await request(makeApp()).get('/api/sessions').expect(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(calls.find((c) => c.method === 'list')?.args[0]).toBeUndefined();
  });

  it('GET /?hostId= filters by host (v0.2)', async () => {
    await request(makeApp()).get('/api/sessions?hostId=edge').expect(200);
    expect(calls.find((c) => c.method === 'list')?.args[0]).toEqual({ hostId: 'edge' });
  });

  it('POST / passes hostId and agents through (v0.2)', async () => {
    await request(makeApp())
      .post('/api/sessions')
      .send({ ...body, hostId: 'edge', agents: ['claude', 'opencode'] })
      .expect(201);
    expect(calls.find((c) => c.method === 'create')?.args[0]).toMatchObject({
      hostId: 'edge',
      agents: ['claude', 'opencode'],
    });
  });

  it('POST / rejects a hostId that is not a slug', async () => {
    const res = await request(makeApp())
      .post('/api/sessions')
      .send({ ...body, hostId: 'Not A Host' })
      .expect(422);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('POST / creates and answers 201 { session }', async () => {
    const res = await request(makeApp()).post('/api/sessions').send(body).expect(201);
    expect(res.body.session.name).toBe('web');
  });

  it('POST / rejects an invalid name with 422 validation_error', async () => {
    const res = await request(makeApp())
      .post('/api/sessions')
      .send({ ...body, name: 'QA Session' })
      .expect(422);
    expect(res.body.error.code).toBe('validation_error');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('POST /reconcile is not shadowed by /:name and adopts (BE-10)', async () => {
    const res = await request(makeApp()).post('/api/sessions/reconcile').expect(200);
    expect(res.body.report).toEqual({ known: 1, running: 1, orphans: [], adopted: ['ghost'], missing: [] });
    expect(calls.map((c) => c.method)).toEqual(['reconcile']);
    expect(calls[0]?.args[0]).toEqual({ adopt: true });
  });

  it('POST /reconcile?hostId= reconciles one host (v0.2)', async () => {
    await request(makeApp()).post('/api/sessions/reconcile?hostId=edge').expect(200);
    expect(calls[0]?.args[0]).toEqual({ adopt: true, hostId: 'edge' });
  });

  it('POST / rejects an env key that no shell could ever read back (BE-11)', async () => {
    const res = await request(makeApp())
      .post('/api/sessions')
      .send({ ...body, env: { 'A B': 'x' } })
      .expect(422);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('POST / rejects a workspace hostPath with .. segments (INT-03)', async () => {
    const res = await request(makeApp())
      .post('/api/sessions')
      .send({ ...body, workspace: { type: 'bind', hostPath: '../../../etc' } })
      .expect(422);
    expect(res.body.error.code).toBe('validation_error');
    expect(JSON.stringify(res.body.error.details)).toContain("'..'");
  });

  it('POST / accepts a relative workspace hostPath under workspacesRoot', async () => {
    await request(makeApp())
      .post('/api/sessions')
      .send({ ...body, workspace: { type: 'bind', hostPath: 'proj' } })
      .expect(201);
  });

  it('GET /:name, PUT /:name and DELETE /:name', async () => {
    const app = makeApp();
    await request(app).get('/api/sessions/web').expect(200);
    await request(app).put('/api/sessions/web').send(body).expect(200);
    await request(app).delete('/api/sessions/web?removeVolumes=1').expect(204);
    expect(calls.find((c) => c.method === 'remove')?.args[1]).toEqual({ removeVolumes: true });
  });

  it('DELETE without removeVolumes keeps the volumes', async () => {
    await request(makeApp()).delete('/api/sessions/web').expect(204);
    expect(calls.find((c) => c.method === 'remove')?.args[1]).toEqual({ removeVolumes: false });
  });

  it('lifecycle routes', async () => {
    const app = makeApp();
    for (const action of ['start', 'stop', 'restart', 'recreate']) {
      const res = await request(app).post(`/api/sessions/web/${action}`).expect(200);
      expect(res.body.session.name).toBe('web');
    }
    expect(calls.map((c) => c.method)).toEqual(['start', 'stop', 'restart', 'recreate']);
  });

  it('GET /:name/logs passes tail and timestamps through', async () => {
    const res = await request(makeApp()).get('/api/sessions/web/logs?tail=50&timestamps=1').expect(200);
    expect(res.body.logs).toBe('hello');
    expect(calls.find((c) => c.method === 'logs')?.args[1]).toEqual({ tail: 50, timestamps: true });
  });

  it('404s an unknown sub-route', async () => {
    await request(makeApp()).get('/api/sessions/web/nope').expect(404);
  });
});

describe('/api/hosts/:hostId/images', () => {
  const base = '/api/hosts/default/images';

  it('GET . and GET ./recipes hand the host id to the service', async () => {
    const app = makeApp();
    await request(app).get(base).expect(200);
    const res = await request(app).get(`${base}/recipes`).expect(200);
    expect(res.body.recipes).toEqual([]);
    expect(calls.find((c) => c.method === 'listImages')?.args).toEqual(['default']);
    expect(calls.find((c) => c.method === 'recipeStatuses')?.args).toEqual(['default']);
  });

  it('POST ./recipes/:name/build answers 202 { job }', async () => {
    const res = await request(makeApp())
      .post(`${base}/recipes/node/build`)
      .send({ noCache: true })
      .expect(202);
    expect(res.body.job.id).toBe('j1');
    expect(calls.find((c) => c.method === 'buildRecipe')?.args).toEqual([
      'default',
      'node',
      { noCache: true },
    ]);
  });

  it('POST ./recipes/:name/build works without a body', async () => {
    await request(makeApp()).post(`${base}/recipes/node/build`).expect(202);
  });

  it('GET ./jobs, GET ./jobs/:id?since= and POST ./jobs/:id/cancel are host scoped', async () => {
    const app = makeApp();
    await request(app).get(`${base}/jobs`).expect(200);
    expect(calls.find((c) => c.method === 'listJobs')?.args).toEqual(['default']);

    const res = await request(app).get(`${base}/jobs/j1?since=3`).expect(200);
    expect(res.body).toEqual({ job, lines: ['a'], nextIndex: 1 });
    expect(calls.find((c) => c.method === 'getJobLines')?.args).toEqual(['j1', 3, 'default']);

    await request(app).post(`${base}/jobs/j1/cancel`).expect(200);
    expect(calls.find((c) => c.method === 'cancelJob')?.args).toEqual(['j1', 'default']);
  });

  it('GET ./jobs/:id 404s for an unknown job', async () => {
    const res = await request(makeApp()).get(`${base}/jobs/nope`).expect(404);
    expect(res.body.error.code).toBe('not_found');
  });

  // a build started on another host must not be visible here (api.md v0.2)
  it('GET ./jobs/:id 404s for a job of ANOTHER host', async () => {
    const res = await request(makeApp()).get('/api/hosts/edge/images/jobs/j1').expect(404);
    expect(res.body.error.code).toBe('not_found');
    expect(calls.find((c) => c.method === 'getJob')?.args).toEqual(['j1', 'edge']);
  });

  it('GET ./tools and POST ./tools/sync', async () => {
    const app = makeApp();
    const status = await request(app).get(`${base}/tools`).expect(200);
    expect(status.body.status).toMatchObject({ hostId: 'default', agents: [] });
    const res = await request(app).post(`${base}/tools/sync`).send({ force: true }).expect(202);
    expect(res.body.job.id).toBe('j1');
    expect(calls.find((c) => c.method === 'syncTools')?.args).toEqual(['default', { force: true }]);
  });

  it('POST ./custom/validate and POST ./pull', async () => {
    const app = makeApp();
    const res = await request(app).post(`${base}/custom/validate`).send({ image: 'nginx:1.27' }).expect(200);
    expect(res.body.result).toEqual({ image: 'nginx:1.27', ok: true });
    expect(calls.find((c) => c.method === 'validateCustomImage')?.args).toEqual(['default', 'nginx:1.27']);
    await request(app).post(`${base}/pull`).send({ image: 'nginx:1.27' }).expect(202);
    expect(calls.find((c) => c.method === 'pull')?.args).toEqual(['default', 'nginx:1.27']);
  });

  it('422s a missing image field', async () => {
    const res = await request(makeApp()).post(`${base}/pull`).send({}).expect(422);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('422s a host id that is not a slug', async () => {
    const res = await request(makeApp()).get('/api/hosts/NOPE/images/recipes').expect(422);
    expect(res.body.error.code).toBe('validation_error');
  });

  // the v0.1 flat routes are gone (api.md v0.2 change list #6)
  it('404s the v0.1 /api/images routes', async () => {
    const app = makeApp();
    await request(app).get('/api/images').expect(404);
    await request(app).get('/api/images/recipes').expect(404);
    await request(app).post('/api/images/tools/sync').expect(404);
  });
});
