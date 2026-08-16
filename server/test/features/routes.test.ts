// OWNER: B2. The /api/sessions and /api/images route tables (api.md), mounted on a bare
// express app with stubbed services so no B1 runtime code is required.
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
  startedAt: null,
  uptimeSec: null,
  runtimePorts: [],
  needsRecreate: false,
  orphan: false,
  warnings: [],
});

const job = {
  id: 'j1',
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
      list: async () => rec('list', [], [view('web')]),
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
      listImages: async () => rec('listImages', [], []),
      recipeStatuses: async () => rec('recipeStatuses', [], []),
      buildRecipe: async (name: string, opts: unknown) => rec('buildRecipe', [name, opts], job),
      pull: async (image: string) => rec('pull', [image], job),
      toolsStatus: async () => rec('toolsStatus', [], { volume: 'porterclaude-tools' }),
      syncTools: async (opts: unknown) => rec('syncTools', [opts], job),
      validateCustomImage: async (image: string) => rec('validateCustomImage', [image], { image, ok: true }),
      listJobs: () => rec('listJobs', [], [job]),
      getJob: (id: string) => rec('getJob', [id], id === 'j1' ? job : null),
      getJobLines: (id: string, since: number) =>
        rec('getJobLines', [id, since], { lines: ['a'], nextIndex: 1 }),
      cancelJob: (id: string) => rec('cancelJob', [id], job),
    },
  } as unknown as AppContext;

  const app = express();
  app.use(express.json());
  app.use('/api/sessions', createSessionsRouter(ctx));
  app.use('/api/images', createImagesRouter(ctx));
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

  it('POST / rejects an env key that no shell could ever read back (BE-11)', async () => {
    const res = await request(makeApp())
      .post('/api/sessions')
      .send({ ...body, env: { 'A B': 'x' } })
      .expect(422);
    expect(res.body.error.code).toBe('validation_error');
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

describe('/api/images', () => {
  it('GET / and GET /recipes', async () => {
    const app = makeApp();
    await request(app).get('/api/images').expect(200);
    const res = await request(app).get('/api/images/recipes').expect(200);
    expect(res.body.recipes).toEqual([]);
  });

  it('POST /recipes/:name/build answers 202 { job }', async () => {
    const res = await request(makeApp())
      .post('/api/images/recipes/node/build')
      .send({ noCache: true })
      .expect(202);
    expect(res.body.job.id).toBe('j1');
    expect(calls.find((c) => c.method === 'buildRecipe')?.args).toEqual(['node', { noCache: true }]);
  });

  it('POST /recipes/:name/build works without a body', async () => {
    await request(makeApp()).post('/api/images/recipes/node/build').expect(202);
  });

  it('GET /jobs, GET /jobs/:id?since= and POST /jobs/:id/cancel', async () => {
    const app = makeApp();
    await request(app).get('/api/images/jobs').expect(200);
    const res = await request(app).get('/api/images/jobs/j1?since=3').expect(200);
    expect(res.body).toEqual({ job, lines: ['a'], nextIndex: 1 });
    expect(calls.find((c) => c.method === 'getJobLines')?.args).toEqual(['j1', 3]);
    await request(app).post('/api/images/jobs/j1/cancel').expect(200);
  });

  it('GET /jobs/:id 404s for an unknown job', async () => {
    const res = await request(makeApp()).get('/api/images/jobs/nope').expect(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('GET /tools and POST /tools/sync', async () => {
    const app = makeApp();
    await request(app).get('/api/images/tools').expect(200);
    const res = await request(app).post('/api/images/tools/sync').send({ force: true }).expect(202);
    expect(res.body.job.id).toBe('j1');
    expect(calls.find((c) => c.method === 'syncTools')?.args[0]).toEqual({ force: true });
  });

  it('POST /custom/validate and POST /pull', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/images/custom/validate').send({ image: 'nginx:1.27' }).expect(200);
    expect(res.body.result).toEqual({ image: 'nginx:1.27', ok: true });
    await request(app).post('/api/images/pull').send({ image: 'nginx:1.27' }).expect(202);
  });

  it('422s a missing image field', async () => {
    const res = await request(makeApp()).post('/api/images/pull').send({}).expect(422);
    expect(res.body.error.code).toBe('validation_error');
  });
});
