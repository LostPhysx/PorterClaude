// OWNER: B1. End-to-end HTTP surface of the core: auth, settings, docker, static, errors.
// B2's routers are stubbed so these tests exercise B1's wiring only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

vi.mock('../../src/containers/routes.js', () => ({
  // Answers on one sentinel path so the mount-path test below can observe WHERE this router
  // is mounted; everything else falls through exactly as before, which is what the rest of
  // this file relies on (B2's routers are stubbed so only B1's wiring is under test).
  createContainersRouter: () => (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/__mounted__') {
      res.json({ mounted: true });
      return;
    }
    next();
  },
}));
vi.mock('../../src/images/routes.js', () => ({
  createImagesRouter: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const { makeHarness, TEST_PASSWORD } = await import('./helpers.js');
const { HOST_PROBE_TIMEOUT_MS } = await import('../../src/hosts/manager.js');
const { SESSION_WS_PATH } = await import('../../src/sessions/ws.js');
type Harness = Awaited<ReturnType<typeof makeHarness>>;

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.cleanup();
});

async function login(password = TEST_PASSWORD): Promise<string> {
  const res = await request(h.app).post('/api/auth/login').send({ password });
  expect(res.status).toBe(200);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  return (cookies[0] as string).split(';')[0] as string;
}

describe('GET /api/health (public)', () => {
  it('answers 200 with no cookie and reports the host summary', async () => {
    const res = await request(h.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', version: '0.0.0-test' });
    expect(typeof res.body.uptimeSec).toBe('number');
    expect(res.body.backend).toBeUndefined();
    expect(res.body.hosts).toEqual({ count: 0, configured: false, defaultHostId: null });
  });

  it('counts the hosts once one is configured', async () => {
    await h.ctx.hosts.create({ name: 'Local docker', connection: { type: 'socket', socketPath: '/x.sock' } });
    const res = await request(h.app).get('/api/health');
    expect(res.body.hosts).toEqual({ count: 1, configured: true, defaultHostId: 'local-docker' });
  });
});

describe('auth', () => {
  it('401s every protected route with the canonical envelope', async () => {
    const paths = [
      '/api/settings',
      '/api/containers',
      '/api/hosts',
      '/api/credentials/portainer',
      '/api/agents',
      '/api/hosts/default/agents',
      '/api/hosts/default/docker/info',
    ];
    for (const path of paths) {
      const res = await request(h.app).get(path);
      expect(res.status, path).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
      expect(typeof res.body.error.message).toBe('string');
    }
  });

  it('reports the login state before and after logging in', async () => {
    const anon = await request(h.app).get('/api/auth/me');
    expect(anon.body).toEqual({ authenticated: false, needsSetup: false });

    const cookie = await login();
    const authed = await request(h.app).get('/api/auth/me').set('Cookie', cookie);
    expect(authed.body).toEqual({ authenticated: true, needsSetup: false });
  });

  it('sets an httpOnly, lax, path=/ cookie on a correct password', async () => {
    const res = await request(h.app).post('/api/auth/login').send({ password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: true });
    const raw = (res.headers['set-cookie'] as unknown as string[])[0] as string;
    expect(raw).toMatch(/^pc_auth=/);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Path=/');
  });

  it('rejects a wrong password and an empty body', async () => {
    const wrong = await request(h.app).post('/api/auth/login').send({ password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('unauthorized');
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const invalid = await request(h.app).post('/api/auth/login').send({});
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe('validation_error');
  });

  it('throttles after 10 attempts with code rate_limited', async () => {
    let last = 0;
    let body: { error?: { code?: string } } = {};
    for (let i = 0; i < 11; i++) {
      const res = await request(h.app).post('/api/auth/login').send({ password: 'wrong' });
      last = res.status;
      body = res.body;
    }
    expect(last).toBe(429);
    expect(body.error?.code).toBe('rate_limited');
  });

  it('clears the cookie on logout', async () => {
    const res = await request(h.app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/^pc_auth=;/);
  });

  it('reports needsSetup when no password is configured', async () => {
    const bare = await makeHarness({ APP_PASSWORD: '' });
    try {
      const res = await request(bare.app).get('/api/auth/me');
      expect(res.body).toEqual({ authenticated: false, needsSetup: true });
      const login = await request(bare.app).post('/api/auth/login').send({ password: 'anything' });
      expect(login.status).toBe(401);
    } finally {
      await bare.cleanup();
    }
  });
});

describe('/api/settings', () => {
  it('GET has no backend section and reports the host summary', async () => {
    const cookie = await login();
    const res = await request(h.app).get('/api/settings').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.backend).toBeUndefined();
    expect(res.body.hosts).toMatchObject({ count: 0, defaultHostId: null, socketHostId: null });
    expect(typeof res.body.hosts.socketAvailable).toBe('boolean');
    expect(res.body.general.volumePrefix).toBe('porterclaude-');
    expect(res.body.auth).toEqual({ passwordSet: true });
  });

  it('PUT /general merges partial updates', async () => {
    const cookie = await login();
    const res = await request(h.app)
      .put('/api/settings/general')
      .set('Cookie', cookie)
      .send({ defaultRecipe: 'python' });
    expect(res.status).toBe(200);
    expect(res.body.general.defaultRecipe).toBe('python');
    expect(res.body.general.imageNamespace).toBe('porterclaude');
  });

  // BE-11: path-like settings are used verbatim in every later docker call, so a bad
  // value has to be a 422 here instead of a 502 on the next container create.
  it('PUT /general rejects path-like fields that docker would choke on', async () => {
    const cookie = await login();
    const cases: Array<Record<string, unknown>> = [
      { containerPrefix: '../x' },
      { workspaceMount: 'relative' },
      { containerHome: '/home/../etc' },
      { toolsVolume: '-bad name' },
      { imageNamespace: 'Upper/Case' },
      { workspacesRoot: '' },
    ];
    for (const body of cases) {
      const res = await request(h.app).put('/api/settings/general').set('Cookie', cookie).send(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.code).toBe('validation_error');
    }
    const after = await request(h.app).get('/api/settings').set('Cookie', cookie);
    expect(after.body.general.containerPrefix).toBe('pc-');
    expect(after.body.general.workspaceMount).toBe('/workspace');
  });

  it('PUT /ui persists the layout blob and the theme', async () => {
    const cookie = await login();
    const layout = { v: 1, savedAt: 123, root: { type: 'row' } };
    const res = await request(h.app).put('/api/settings/ui').set('Cookie', cookie).send({ layout, theme: 'dark' });
    expect(res.status).toBe(200);
    expect(res.body.ui).toEqual({ layout, theme: 'dark' });

    const cleared = await request(h.app).put('/api/settings/ui').set('Cookie', cookie).send({ layout: null });
    expect(cleared.body.ui).toEqual({ layout: null, theme: 'dark' });
  });

  it('POST /password issues a fresh cookie and invalidates the old one', async () => {
    const oldCookie = await login();
    const res = await request(h.app)
      .post('/api/settings/password')
      .set('Cookie', oldCookie)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-new-password' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const newCookie = ((res.headers['set-cookie'] as unknown as string[])[0] as string).split(';')[0] as string;
    expect(newCookie).not.toBe(oldCookie);

    expect((await request(h.app).get('/api/settings').set('Cookie', oldCookie)).status).toBe(401);
    expect((await request(h.app).get('/api/settings').set('Cookie', newCookie)).status).toBe(200);
    expect((await request(h.app).post('/api/auth/login').send({ password: 'a-new-password' })).status).toBe(200);
  });

  it('POST /password rejects a wrong current password and a short new one', async () => {
    const cookie = await login();
    const wrong = await request(h.app)
      .post('/api/settings/password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'not-it', newPassword: 'a-new-password' });
    expect(wrong.status).toBe(401);

    const short = await request(h.app)
      .post('/api/settings/password')
      .set('Cookie', cookie)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'short' });
    expect(short.status).toBe(422);
  });

  it('GET /vendor reports every vendor route', async () => {
    const cookie = await login();
    const res = await request(h.app).get('/api/settings/vendor').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const routes = res.body.routes as Array<{ route: string; mounted: boolean; dir: string | null }>;
    expect(routes.map((r) => r.route)).toContain('/vendor/bootstrap');
    expect(routes.every((r) => r.mounted)).toBe(true);
  });
});

describe('/api/credentials/portainer', () => {
  const API_KEY = 'ptr_supersecret_9xyz';

  it('stores the key write-only and never echoes it', async () => {
    const cookie = await login();
    const created = await request(h.app)
      .post('/api/credentials/portainer')
      .set('Cookie', cookie)
      .send({ name: 'Portainer', url: 'https://portainer.example.com/', apiKey: API_KEY });

    expect(created.status).toBe(201);
    expect(created.body.credential).toMatchObject({
      id: 'portainer-1',
      url: 'https://portainer.example.com',
      apiKeySet: true,
      apiKeyHint: API_KEY.slice(-4),
      hostIds: [],
    });

    const list = await request(h.app).get('/api/credentials/portainer').set('Cookie', cookie);
    expect(JSON.stringify(list.body)).not.toContain(API_KEY);
    expect(JSON.stringify(list.body)).not.toContain(TEST_PASSWORD);

    // PUT without apiKey keeps the stored one
    const updated = await request(h.app)
      .put('/api/credentials/portainer/portainer-1')
      .set('Cookie', cookie)
      .send({ name: 'Renamed' });
    expect(updated.status).toBe(200);
    expect(updated.body.credential).toMatchObject({ name: 'Renamed', apiKeySet: true });
    expect(h.ctx.credentials.apiKeyFor('portainer-1')).toBe(API_KEY);
    expect(JSON.stringify(updated.body)).not.toContain(API_KEY);
  });

  it('404s an unknown credential and 409s while a host references it', async () => {
    const cookie = await login();
    expect(
      (await request(h.app).put('/api/credentials/portainer/nope').set('Cookie', cookie).send({ name: 'x' }))
        .status,
    ).toBe(404);

    await request(h.app)
      .post('/api/credentials/portainer')
      .set('Cookie', cookie)
      .send({ name: 'Portainer', url: 'https://portainer.example.com', apiKey: API_KEY });
    await request(h.app)
      .post('/api/hosts')
      .set('Cookie', cookie)
      .send({ name: 'Prod', connection: { type: 'portainer', credentialId: 'portainer-1', endpointId: 2 } });

    const blocked = await request(h.app)
      .delete('/api/credentials/portainer/portainer-1')
      .set('Cookie', cookie);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('conflict');

    await request(h.app).delete('/api/hosts/prod').set('Cookie', cookie);
    expect((await request(h.app).delete('/api/credentials/portainer/portainer-1').set('Cookie', cookie)).status).toBe(204);
  });
});

describe('/api/hosts', () => {
  it('creates hosts, enforces the single socket host and switches the default', async () => {
    const cookie = await login();
    const first = await request(h.app)
      .post('/api/hosts')
      .set('Cookie', cookie)
      .send({ name: 'Local docker', connection: { type: 'socket', socketPath: '/x.sock' } });
    expect(first.status).toBe(201);
    expect(first.body.host).toMatchObject({
      id: 'local-docker',
      isDefault: true,
      supported: true,
      connectionLabel: 'socket: /x.sock',
      agents: { enabled: ['claude'] },
      containerCount: 0,
    });
    expect(first.body.host.settings.volumePrefix).toBe('porterclaude-');

    const second = await request(h.app)
      .post('/api/hosts')
      .set('Cookie', cookie)
      .send({ name: 'Another socket', connection: { type: 'socket', socketPath: '/y.sock' } });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conflict');

    const unknownCred = await request(h.app)
      .post('/api/hosts')
      .set('Cookie', cookie)
      .send({ name: 'Prod', connection: { type: 'portainer', credentialId: 'nope', endpointId: 1 } });
    expect(unknownCred.status).toBe(404);

    // a reserved connection type is accepted by the schema but refused by the factory
    const reserved = await request(h.app)
      .post('/api/hosts')
      .set('Cookie', cookie)
      .send({ name: 'Future', connection: { type: 'tcp', url: 'tcp://10.0.0.5:2376' } });
    expect(reserved.status).toBe(201);
    expect(reserved.body.host).toMatchObject({ supported: false, status: 'not_configured' });
    expect((await request(h.app).get('/api/hosts/future/info').set('Cookie', cookie)).status).toBe(501);

    const madeDefault = await request(h.app).post('/api/hosts/future/default').set('Cookie', cookie);
    expect(madeDefault.status).toBe(200);
    expect(madeDefault.body.defaultHostId).toBe('future');

    const list = await request(h.app).get('/api/hosts?probe=1').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.hosts.map((x: { id: string }) => x.id)).toEqual(['local-docker', 'future']);
    expect(list.body.defaultHostId).toBe('future');
  });

  it('renders an unreachable engine as status unreachable instead of 502ing', async () => {
    const cookie = await login();
    await request(h.app)
      .post('/api/hosts')
      .set('Cookie', cookie)
      .send({ name: 'Dead', connection: { type: 'socket', socketPath: '/definitely/not/here.sock' } });

    const started = Date.now();
    const res = await request(h.app).get('/api/hosts?probe=1').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(HOST_PROBE_TIMEOUT_MS + 5_000);
    const host = res.body.hosts[0];
    expect(host.status).toBe('unreachable');
    expect(typeof host.error).toBe('string');
    expect(host.info).toBeNull();

    const test = await request(h.app).post('/api/hosts/dead/test').set('Cookie', cookie);
    expect(test.status).toBe(200);
    expect(test.body.ok).toBe(false);
    expect(typeof test.body.error.message).toBe('string');
  });

  it('POST /api/hosts/test answers 200 { ok:false } for an unreachable connection', async () => {
    const cookie = await login();
    const res = await request(h.app)
      .post('/api/hosts/test')
      .set('Cookie', cookie)
      .send({ connection: { type: 'socket', socketPath: '/definitely/not/here.sock' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(TEST_PASSWORD);
  });

  it('404s an unknown host and 409s a DELETE while containers reference it', async () => {
    const cookie = await login();
    expect((await request(h.app).get('/api/hosts/nope').set('Cookie', cookie)).status).toBe(404);

    await request(h.app)
      .post('/api/hosts')
      .set('Cookie', cookie)
      .send({ name: 'Local docker', connection: { type: 'socket', socketPath: '/x.sock' } });
    await h.ctx.config.putContainer({
      name: 'web',
      hostId: 'local-docker',
      agents: null,
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const blocked = await request(h.app).delete('/api/hosts/local-docker').set('Cookie', cookie);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('conflict');

    const forced = await request(h.app).delete('/api/hosts/local-docker?force=1').set('Cookie', cookie);
    expect(forced.status).toBe(204);
    // the container survives (it is now dangling), the engine was never touched
    expect(h.ctx.config.listContainers().map((x) => x.name)).toEqual(['web']);
    expect(h.ctx.config.get().defaultHostId).toBeNull();
  });
});

describe('/api/agents', () => {
  const custom = {
    id: 'mycoder',
    name: 'My Coder',
    command: 'mycoder',
    args: [],
    versionCommand: ['mycoder', '--version'],
    install: { kind: 'npm', package: 'mycoder' },
    sharedPaths: [{ path: '~/.mycoder', kind: 'dir' }],
    historyPath: null,
    env: {},
  };

  it('lists the built-ins and manages custom definitions', async () => {
    const cookie = await login();
    const list = await request(h.app).get('/api/agents').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.agents.map((a: { id: string }) => a.id)).toEqual([
      'claude',
      'opencode',
      'gemini',
      'codex',
      'aider',
    ]);
    expect(list.body.agents.every((a: { builtin: boolean }) => a.builtin)).toBe(true);

    const created = await request(h.app).post('/api/agents').set('Cookie', cookie).send(custom);
    expect(created.status).toBe(201);
    expect(created.body.agent).toMatchObject({ id: 'mycoder', builtin: false });

    const collision = await request(h.app)
      .post('/api/agents')
      .set('Cookie', cookie)
      .send({ ...custom, id: 'claude' });
    expect(collision.status).toBe(409);

    const dupSlug = await request(h.app)
      .post('/api/agents')
      .set('Cookie', cookie)
      .send({
        ...custom,
        id: 'dupe',
        sharedPaths: [
          { path: '~/.dupe', kind: 'dir' },
          { path: '~/dupe', kind: 'dir' },
        ],
      });
    expect(dupSlug.status).toBe(422);
    expect(dupSlug.body.error.code).toBe('validation_error');

    expect((await request(h.app).put('/api/agents/claude').set('Cookie', cookie).send({ ...custom, id: 'claude' })).status).toBe(409);
    expect((await request(h.app).delete('/api/agents/claude').set('Cookie', cookie)).status).toBe(409);
    expect((await request(h.app).get('/api/agents/nope').set('Cookie', cookie)).status).toBe(404);
  });

  // B-8: a sharedPath becomes a SYMLINK inside the container, so `..` would point it
  // outside the agent's auth volume (`~/../../etc/passwd` was accepted and stored).
  it('422s a sharedPath / historyPath that escapes the container home', async () => {
    const cookie = await login();
    for (const bad of ['~/../../etc/passwd', '~/.mycoder/../../root', 'relative/path', '~']) {
      const res = await request(h.app)
        .post('/api/agents')
        .set('Cookie', cookie)
        .send({ ...custom, id: 'bad', sharedPaths: [{ path: bad, kind: 'dir' }] });
      expect(res.status, bad).toBe(422);
      expect(res.body.error.code).toBe('validation_error');
    }
    const badHistory = await request(h.app)
      .post('/api/agents')
      .set('Cookie', cookie)
      .send({ ...custom, id: 'bad2', historyPath: '~/.mycoder/../../etc' });
    expect(badHistory.status).toBe(422);

    // ...while an absolute path outside the home is still fine (it is inside the container)
    const ok = await request(h.app)
      .post('/api/agents')
      .set('Cookie', cookie)
      .send({ ...custom, id: 'absolute', sharedPaths: [{ path: '/etc/mycoder', kind: 'dir' }] });
    expect(ok.status).toBe(201);
  });

  it('409s a DELETE while a host enables the agent and strips it with force=1', async () => {
    const cookie = await login();
    await request(h.app).post('/api/agents').set('Cookie', cookie).send(custom);
    await request(h.app)
      .post('/api/hosts')
      .set('Cookie', cookie)
      .send({
        name: 'Local docker',
        connection: { type: 'socket', socketPath: '/x.sock' },
        agents: ['claude', 'mycoder'],
      });

    const blocked = await request(h.app).delete('/api/agents/mycoder').set('Cookie', cookie);
    expect(blocked.status).toBe(409);

    const forced = await request(h.app).delete('/api/agents/mycoder?force=1').set('Cookie', cookie);
    expect(forced.status).toBe(204);
    expect(h.ctx.hosts.require('local-docker').agents.enabled).toEqual(['claude']);
  });
});

describe('/api/hosts/:hostId/agents', () => {
  it('merges definitions, the host config and the tools manifest', async () => {
    const cookie = await login();
    await request(h.app)
      .post('/api/hosts')
      .set('Cookie', cookie)
      .send({ name: 'Local docker', connection: { type: 'socket', socketPath: '/x.sock' } });

    const res = await request(h.app).get('/api/hosts/local-docker/agents').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toEqual(['claude']);
    const claude = res.body.agents.find((a: { id: string }) => a.id === 'claude');
    expect(claude).toMatchObject({
      builtin: true,
      enabled: true,
      installed: false,
      version: null,
      authVolume: 'porterclaude-auth-claude',
    });
    expect(res.body.agents.find((a: { id: string }) => a.id === 'aider').enabled).toBe(false);

    const put = await request(h.app)
      .put('/api/hosts/local-docker/agents')
      .set('Cookie', cookie)
      .send({ enabled: ['claude', 'opencode'] });
    expect(put.status).toBe(200);
    expect(put.body.enabled).toEqual(['claude', 'opencode']);
    expect(h.ctx.hosts.require('local-docker').agents.enabled).toEqual(['claude', 'opencode']);

    const unknown = await request(h.app)
      .put('/api/hosts/local-docker/agents')
      .set('Cookie', cookie)
      .send({ enabled: ['nope'] });
    expect(unknown.status).toBe(422);
    expect((await request(h.app).get('/api/hosts/nope/agents').set('Cookie', cookie)).status).toBe(404);
  });

  it('still renders when the tools read fails (installed:false + error, never a 502)', async () => {
    const cookie = await login();
    await request(h.app)
      .post('/api/hosts')
      .set('Cookie', cookie)
      .send({ name: 'Local docker', connection: { type: 'socket', socketPath: '/x.sock' } });
    const spy = vi
      .spyOn(h.ctx.images, 'agentStatuses')
      .mockRejectedValue(new Error('engine is not reachable'));

    const res = await request(h.app).get('/api/hosts/local-docker/agents').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const claude = res.body.agents.find((a: { id: string }) => a.id === 'claude');
    expect(claude.installed).toBe(false);
    expect(claude.error).toContain('engine is not reachable');
    spy.mockRestore();
  });
});

describe('/api/hosts/:hostId/docker', () => {
  it('404s an unknown host', async () => {
    const cookie = await login();
    for (const path of ['info', 'containers', 'volumes', 'networks']) {
      const res = await request(h.app).get(`/api/hosts/nope/docker/${path}`).set('Cookie', cookie);
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
  });

  it('409s backend_not_configured for a host whose connection is incomplete', async () => {
    const cookie = await login();
    // written straight to the store: the API would refuse an unknown credential with a 404
    const now = new Date().toISOString();
    await h.ctx.config.putHost({
      id: 'broken',
      name: 'Broken',
      connection: { type: 'portainer', credentialId: 'gone', endpointId: 1 },
      overrides: {},
      agents: { enabled: ['claude'] },
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    for (const path of ['info', 'containers', 'volumes', 'networks']) {
      const res = await request(h.app).get(`/api/hosts/broken/docker/${path}`).set('Cookie', cookie);
      expect(res.status, path).toBe(409);
      expect(res.body.error.code).toBe('backend_not_configured');
    }
  });

  it('501s a reserved connection type', async () => {
    const cookie = await login();
    await request(h.app)
      .post('/api/hosts')
      .set('Cookie', cookie)
      .send({ name: 'Future', connection: { type: 'ssh', url: 'ssh://root@10.0.0.5' } });
    const res = await request(h.app).get('/api/hosts/future/docker/info').set('Cookie', cookie);
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('not_implemented');
  });

  it('does not answer the removed v0.1 routes any more', async () => {
    const cookie = await login();
    for (const path of ['/api/docker/info', '/api/images', '/api/settings/backend']) {
      expect((await request(h.app).get(path).set('Cookie', cookie)).status, path).toBe(404);
    }
    expect((await request(h.app).put('/api/settings/backend').set('Cookie', cookie).send({})).status).toBe(404);
    expect((await request(h.app).post('/api/settings/backend/test').set('Cookie', cookie).send({})).status).toBe(404);
  });
});

describe('static assets and error handling', () => {
  it('serves a vendor asset', async () => {
    const res = await request(h.app).get('/vendor/bootstrap/css/bootstrap.min.css');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
  });

  it('404s an unknown vendor asset without crashing', async () => {
    const res = await request(h.app).get('/vendor/does-not-exist/x.js');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect((await request(h.app).get('/api/health')).status).toBe(200);
  });

  it('serves index.html for / and for an unknown SPA route', async () => {
    const root = await request(h.app).get('/');
    expect(root.status).toBe(200);
    expect(root.text).toContain('<!doctype html>');
    const deep = await request(h.app).get('/containers/deep/link');
    expect(deep.status).toBe(200);
    expect(deep.text).toContain('<!doctype html>');
  });

  it('404s unknown /api routes with the canonical envelope', async () => {
    const res = await request(h.app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  // v0.3 phase R: the HTTP container CRUD moved to /api/containers and the shell connections
  // took over /api/sessions. That path belongs to the WEBSOCKET upgrade handler alone — if
  // express ever owns it again it answers the handshake with 401/404 and every pane dies
  // before it connects. Asserted while AUTHENTICATED so a 404 means "no route", not "no cookie";
  // the two halves are one test on purpose, so moving the mount back fails BOTH.
  it('mounts the container CRUD on /api/containers and leaves SESSION_WS_PATH to the websocket', async () => {
    const cookie = await login();

    const crud = await request(h.app).get('/api/containers/__mounted__').set('Cookie', cookie);
    expect(crud.status).toBe(200);
    expect(crud.body).toEqual({ mounted: true });

    const onWsPath = await request(h.app).get(`${SESSION_WS_PATH}/__mounted__`).set('Cookie', cookie);
    expect(onWsPath.status).toBe(404);

    const res = await request(h.app).get(SESSION_WS_PATH).set('Cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// QA R1-INT2-4 / R2-INT2-7: a custom agent definition is admin-supplied config that ends up
// in a docker create, in an installer script and in a session argv. Everything that cannot
// work there is refused HERE (422), not hours later in a tools-sync job log.
// ---------------------------------------------------------------------------
describe('/api/agents input hygiene', () => {
  const base = {
    id: 'mycoder',
    name: 'My Coder',
    command: 'mycoder',
    args: [],
    versionCommand: ['mycoder', '--version'],
    install: { kind: 'npm', package: 'mycoder' },
    sharedPaths: [{ path: '~/.mycoder', kind: 'dir' }],
    historyPath: null,
    env: {},
  };

  async function post(body: Record<string, unknown>, cookie: string) {
    return request(h.app).post('/api/agents').set('Cookie', cookie).send({ ...base, ...body });
  }

  it('422s a `command` that is not a plain executable name', async () => {
    const cookie = await login();
    for (const command of ['evil; rm -rf /', 'my coder', '$(id)', 'a`b`', '/usr/bin/mycoder', '-x', '']) {
      const res = await post({ command }, cookie);
      expect(res.status, command).toBe(422);
      expect(res.body.error.code).toBe('validation_error');
    }
    expect((await post({ command: 'my-coder_2.0' }, cookie)).status).toBe(201);
  });

  it('422s an npm/pip `bin` with shell metacharacters', async () => {
    const cookie = await login();
    expect((await post({ install: { kind: 'npm', package: 'mycoder', bin: 'a;b' } }, cookie)).status).toBe(422);
    expect((await post({ install: { kind: 'pip', package: 'mycoder', bin: 'a b' } }, cookie)).status).toBe(422);
    expect((await post({ install: { kind: 'npm', package: 'mycoder', bin: 'mycoder' } }, cookie)).status).toBe(201);
  });

  it('422s a sharedPath with whitespace or shell metacharacters', async () => {
    const cookie = await login();
    // `;` and `|` also break the PORTERCLAUDE_AGENT_LINKS encoding: the entrypoint drops the
    // entry as malformed and the agent's real directory is never linked
    for (const path of ['~/.qa;touch /tmp/x', '~/.qb $(id)', '~/.qc`id`', '~/.qd|x', '~/.q e']) {
      const res = await post({ id: 'bad', sharedPaths: [{ path, kind: 'dir' }] }, cookie);
      expect(res.status, path).toBe(422);
    }
  });

  it('422s an env key that is not an identifier', async () => {
    const cookie = await login();
    for (const key of ['BAD KEY', '1BAD', 'BAD-KEY', 'BAD=KEY']) {
      const res = await post({ id: 'bad', env: { [key]: '1' } }, cookie);
      expect(res.status, key).toBe(422);
    }
    expect((await post({ env: { MYCODER_HOME: '/x' } }, cookie)).status).toBe(201);
  });

  // docs/AGENTS.md: historyPath must sit inside one of the shared paths - it is mounted at
  // agentHistoryTarget(), which is null anywhere else, so `shareHistory:false` would
  // silently never get its own volume.
  it('422s a historyPath outside every shared DIRECTORY', async () => {
    const cookie = await login();
    expect((await post({ id: 'bad', historyPath: '~/.other/hist' }, cookie)).status).toBe(422);
    // a shared FILE is not a directory the history can live in either
    expect(
      (
        await post(
          {
            id: 'bad2',
            sharedPaths: [{ path: '~/.mycoder.json', kind: 'file' }],
            historyPath: '~/.mycoder.json/hist',
          },
          cookie,
        )
      ).status,
    ).toBe(422);
    // ...and the documented layout is accepted
    expect((await post({ historyPath: '~/.mycoder/chats' }, cookie)).status).toBe(201);
  });
});
