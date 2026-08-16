// OWNER: B1. Core smoke: the documented route table exists, the vendor mounts resolve and
// nothing in the boot path throws with an empty DATA_DIR and no backend configured.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { VENDOR_ROUTES, resolveVendorDir, vendorMountResults } from '../../src/vendor.js';
import { parseTrustProxy } from '../../src/app.js';
import { readCookie, shouldUseSecureCookie } from '../../src/auth/index.js';
import type { AppContext } from '../../src/context.js';

vi.mock('../../src/sessions/routes.js', () => ({
  createSessionsRouter: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../src/images/routes.js', () => ({
  createImagesRouter: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const { makeHarness, TEST_PASSWORD } = await import('./helpers.js');
type Harness = Awaited<ReturnType<typeof makeHarness>>;

let h: Harness;
let cookie: string;

beforeAll(async () => {
  h = await makeHarness();
  // the v0.2 route table is host-scoped: one host has to exist for those paths to resolve
  await h.ctx.hosts.create({
    name: 'Local docker',
    connection: { type: 'socket', socketPath: '/definitely/not/here.sock' },
  });
  const res = await request(h.app).post('/api/auth/login').send({ password: TEST_PASSWORD });
  cookie = (((res.headers['set-cookie'] as unknown as string[])[0] as string).split(';')[0]) as string;
});

afterAll(async () => {
  await h.cleanup();
});

describe('route table (api.md v0.2)', () => {
  const core: Array<[string, string]> = [
    ['GET', '/api/health'],
    ['GET', '/api/auth/session'],
    ['POST', '/api/auth/logout'],
    ['GET', '/api/settings'],
    ['GET', '/api/settings/vendor'],
    ['PUT', '/api/settings/general'],
    ['PUT', '/api/settings/ui'],
    ['POST', '/api/settings/password'],
    ['GET', '/api/hosts'],
    ['POST', '/api/hosts/test'],
    ['GET', '/api/hosts/local-docker'],
    ['PUT', '/api/hosts/local-docker'],
    ['POST', '/api/hosts/local-docker/default'],
    ['POST', '/api/hosts/local-docker/test'],
    ['GET', '/api/credentials/portainer'],
    ['POST', '/api/credentials/portainer/test'],
    ['GET', '/api/agents'],
    ['GET', '/api/hosts/local-docker/agents'],
    ['PUT', '/api/hosts/local-docker/agents'],
    ['GET', '/api/hosts/local-docker/docker/info'],
    ['GET', '/api/hosts/local-docker/docker/containers'],
    ['GET', '/api/hosts/local-docker/docker/volumes'],
    ['GET', '/api/hosts/local-docker/docker/networks'],
  ];

  it.each(core)('%s %s exists (never 404)', async (method, path) => {
    const agent = request(h.app) as unknown as Record<string, (p: string) => request.Test>;
    const res = await (agent[method.toLowerCase()] as (p: string) => request.Test)(path)
      .set('Cookie', cookie)
      .send({});
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(501);
  });

  // v0.2 change list #4/#5/#6: the global backend routes are gone for good
  const removed: Array<[string, string]> = [
    ['PUT', '/api/settings/backend'],
    ['POST', '/api/settings/backend/test'],
    ['POST', '/api/settings/backend/endpoints'],
    ['GET', '/api/docker/info'],
    ['GET', '/api/docker/containers'],
    ['GET', '/api/docker/volumes'],
    ['GET', '/api/docker/networks'],
    ['GET', '/api/images'],
    ['GET', '/api/images/recipes'],
  ];

  it.each(removed)('%s %s is gone (404)', async (method, path) => {
    const agent = request(h.app) as unknown as Record<string, (p: string) => request.Test>;
    const res = await (agent[method.toLowerCase()] as (p: string) => request.Test)(path)
      .set('Cookie', cookie)
      .send({});
    expect(res.status).toBe(404);
  });

  it('404s a host-scoped route with an unknown host id', async () => {
    for (const path of ['/api/hosts/nope', '/api/hosts/nope/agents', '/api/hosts/nope/docker/info']) {
      const res = await request(h.app).get(path).set('Cookie', cookie);
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
  });

  it('rejects an unknown /api path with the canonical envelope', async () => {
    const res = await request(h.app).get('/api/does-not-exist').set('Cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('vendor mounts', () => {
  it('resolves every vendored package from node_modules', () => {
    for (const route of VENDOR_ROUTES) {
      expect(resolveVendorDir(h.ctx.paths, route.packageDir), route.packageDir).toBeTruthy();
    }
    const results = vendorMountResults(h.ctx.paths);
    expect(results).toHaveLength(VENDOR_ROUTES.length);
    expect(results.every((r) => r.mounted)).toBe(true);
  });

  it('serves the concrete asset urls the UI relies on', async () => {
    const urls = [
      '/vendor/bootstrap/css/bootstrap.min.css',
      '/vendor/bootstrap/js/bootstrap.bundle.min.js',
      '/vendor/bootstrap-icons/bootstrap-icons.css',
      '/vendor/jquery/jquery.min.js',
      '/vendor/xterm/css/xterm.css',
      '/vendor/xterm/lib/xterm.js',
      '/vendor/xterm-addon-fit/addon-fit.js',
      '/vendor/xterm-addon-web-links/addon-web-links.js',
      // golden-layout 2.6 ships dist/esm/index.js (api.md's bundle/esm path does not exist)
      '/vendor/golden-layout/esm/index.js',
      '/vendor/golden-layout/css/goldenlayout-base.css',
      '/vendor/golden-layout/css/themes/goldenlayout-dark-theme.css',
    ];
    for (const url of urls) {
      const res = await request(h.app).get(url);
      expect(res.status, url).toBe(200);
    }
  });

  it('resolves the extensionless ESM specifiers golden-layout uses (express.static extensions)', async () => {
    // dist/esm/index.js does `export * from './ts/config/config'`; without extensions:['js']
    // the browser cannot load the graph. Also assert an unmatched /vendor/** GET is a real
    // 404 rather than the SPA index.html.
    const res = await request(h.app).get('/vendor/golden-layout/esm/ts/golden-layout');
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/javascript/);

    const missing = await request(h.app).get('/vendor/golden-layout/nope.js');
    expect(missing.status).toBe(404);
    expect(String(missing.headers['content-type'])).not.toMatch(/text\/html/);
  });

  it('returns null for an unknown package instead of throwing', () => {
    expect(resolveVendorDir(h.ctx.paths, 'not-a-real-package/dist')).toBeNull();
  });
});

describe('small helpers', () => {
  it('parses TRUST_PROXY the way express expects', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('0')).toBe(0);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });

  it('parses cookies out of a raw header', () => {
    expect(readCookie('a=1; pc_session=abc.def; b=2', 'pc_session')).toBe('abc.def');
    expect(readCookie(undefined, 'pc_session')).toBeUndefined();
    expect(readCookie('other=1', 'pc_session')).toBeUndefined();
  });

  it('derives the secure cookie flag from the request when COOKIE_SECURE=auto', () => {
    const ctx = h.ctx as AppContext;
    expect(shouldUseSecureCookie(ctx, { secure: false, headers: {} })).toBe(false);
    expect(shouldUseSecureCookie(ctx, { secure: true, headers: {} })).toBe(true);
    expect(shouldUseSecureCookie(ctx, { secure: false, headers: { 'x-forwarded-proto': 'https' } })).toBe(true);
    expect(shouldUseSecureCookie(ctx, { secure: false, headers: { 'x-forwarded-proto': 'https,http' } })).toBe(true);
    expect(shouldUseSecureCookie(ctx, { secure: false, headers: { 'x-forwarded-proto': 'http' } })).toBe(false);
  });
});
