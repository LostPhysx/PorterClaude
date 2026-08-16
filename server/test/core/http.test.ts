// OWNER: B1. End-to-end HTTP surface of the core: auth, settings, docker, static, errors.
// B2's routers are stubbed so these tests exercise B1's wiring only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

vi.mock('../../src/sessions/routes.js', () => ({
  createSessionsRouter: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../src/images/routes.js', () => ({
  createImagesRouter: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const { makeHarness, TEST_PASSWORD } = await import('./helpers.js');
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
  it('answers 200 with no cookie and reports the backend state', async () => {
    const res = await request(h.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', version: '0.0.0-test' });
    expect(typeof res.body.uptimeSec).toBe('number');
    expect(res.body.backend).toEqual({ kind: 'none', configured: false });
  });
});

describe('auth', () => {
  it('401s every protected route with the canonical envelope', async () => {
    for (const path of ['/api/settings', '/api/sessions', '/api/images', '/api/docker/info']) {
      const res = await request(h.app).get(path);
      expect(res.status, path).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
      expect(typeof res.body.error.message).toBe('string');
    }
  });

  it('reports the session state before and after logging in', async () => {
    const anon = await request(h.app).get('/api/auth/session');
    expect(anon.body).toEqual({ authenticated: false, needsSetup: false });

    const cookie = await login();
    const authed = await request(h.app).get('/api/auth/session').set('Cookie', cookie);
    expect(authed.body).toEqual({ authenticated: true, needsSetup: false });
  });

  it('sets an httpOnly, lax, path=/ cookie on a correct password', async () => {
    const res = await request(h.app).post('/api/auth/login').send({ password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: true });
    const raw = (res.headers['set-cookie'] as unknown as string[])[0] as string;
    expect(raw).toMatch(/^pc_session=/);
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
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/^pc_session=;/);
  });

  it('reports needsSetup when no password is configured', async () => {
    const bare = await makeHarness({ APP_PASSWORD: '' });
    try {
      const res = await request(bare.app).get('/api/auth/session');
      expect(res.body).toEqual({ authenticated: false, needsSetup: true });
      const login = await request(bare.app).post('/api/auth/login').send({ password: 'anything' });
      expect(login.status).toBe(401);
    } finally {
      await bare.cleanup();
    }
  });
});

describe('/api/settings', () => {
  // TODO(B1): v0.2 route tests (the /api/settings/backend* routes are gone, see api.md):
  //   * GET /api/settings has no `backend` section and reports hosts.count/defaultHostId;
  //   * POST /api/credentials/portainer stores the key encrypted and answers apiKeySet
  //     with a 4-char hint only; PUT without apiKey keeps it; the plaintext never appears
  //     in any response body (grep);
  //   * POST /api/hosts creates a host (409 for a second socket host), POST
  //     /api/hosts/:id/default switches the default, DELETE 409s while a session uses it;
  //   * POST /api/hosts/test answers 200 { ok:false } for an unreachable connection.

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
  // value has to be a 422 here instead of a 502 on the next session create.
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

describe('/api/hosts/:hostId/docker', () => {
  // TODO(B1): the helpers are host-scoped now -> 404 for an unknown host and
  // 409 backend_not_configured for a host whose connection is incomplete.
  it('409s backend_not_configured on every helper', async () => {
    const cookie = await login();
    for (const path of ['/api/docker/info', '/api/docker/containers', '/api/docker/volumes', '/api/docker/networks']) {
      const res = await request(h.app).get(path).set('Cookie', cookie);
      expect(res.status, path).toBe(409);
      expect(res.body.error.code).toBe('backend_not_configured');
    }
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
    const deep = await request(h.app).get('/sessions/deep/link');
    expect(deep.status).toBe(200);
    expect(deep.text).toContain('<!doctype html>');
  });

  it('404s unknown /api routes with the canonical envelope', async () => {
    const res = await request(h.app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
