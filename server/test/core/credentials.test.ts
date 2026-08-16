// OWNER: B1. CredentialStore: the ONLY decryption point of a Portainer api key.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildContext, makeDataDir } from './helpers.js';
import type { AppContext } from '../../src/context.js';

const API_KEY = 'ptr_livesecret_wxyz';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await (closers.pop() as () => Promise<void>)();
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true });
});

async function ctxFor(env: Record<string, string> = {}): Promise<AppContext> {
  const built = await buildContext(env);
  if (!env.DATA_DIR) dirs.push(built.dataDir);
  closers.push(async () => {
    await built.ctx.hosts.close().catch(() => undefined);
  });
  return built.ctx;
}

async function fakePortainer(handler: (url: string, res: http.ServerResponse) => void): Promise<string> {
  const server = http.createServer((req, res) => handler(req.url ?? '', res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('CredentialStore', () => {
  it('stores the key encrypted, exposes only a 4-char hint and keeps it on update', async () => {
    const dir = await makeDataDir();
    dirs.push(dir);
    const ctx = await ctxFor({ DATA_DIR: dir });

    const created = await ctx.credentials.create({
      name: 'Prod',
      url: 'https://p.example.com/',
      apiKey: API_KEY,
    });
    expect(created).toMatchObject({
      id: 'portainer-1',
      url: 'https://p.example.com',
      apiKeySet: true,
      apiKeyHint: 'wxyz',
      hostIds: [],
      insecureTls: false,
    });
    expect(JSON.stringify(created)).not.toContain(API_KEY);

    const raw = await readFile(path.join(dir, 'config.json'), 'utf8');
    expect(raw).not.toContain(API_KEY);
    expect(JSON.parse(raw).credentials.portainer[0].apiKeyEnc).toMatch(/^enc:v1:/);

    const renamed = await ctx.credentials.update('portainer-1', { name: 'Renamed', insecureTls: true });
    expect(renamed).toMatchObject({ name: 'Renamed', apiKeySet: true, apiKeyHint: 'wxyz', insecureTls: true });
    expect(ctx.credentials.apiKeyFor('portainer-1')).toBe(API_KEY);

    const rotated = await ctx.credentials.update('portainer-1', { apiKey: 'ptr_rotated_1234' });
    expect(rotated.apiKeyHint).toBe('1234');
    expect(ctx.credentials.apiKeyFor('portainer-1')).toBe('ptr_rotated_1234');
  });

  it('numbers new credentials and reports the hosts using them', async () => {
    const ctx = await ctxFor();
    await ctx.credentials.create({ name: 'A', url: 'https://a.example.com', apiKey: API_KEY });
    const second = await ctx.credentials.create({ name: 'B', url: 'https://b.example.com', apiKey: API_KEY });
    expect(second.id).toBe('portainer-2');

    await ctx.hosts.create({
      name: 'Prod',
      connection: { type: 'portainer', credentialId: 'portainer-1', endpointId: 1 },
    });
    await ctx.hosts.create({
      name: 'Staging',
      connection: { type: 'portainer', credentialId: 'portainer-1', endpointId: 2 },
    });
    const list = ctx.credentials.sanitizedList();
    expect(list.map((c) => c.id)).toEqual(['portainer-1', 'portainer-2']);
    expect(list[0]?.hostIds).toEqual(['prod', 'staging']);
    expect(list[1]?.hostIds).toEqual([]);

    await expect(ctx.credentials.remove('portainer-1')).rejects.toMatchObject({ code: 'conflict' });
    await expect(ctx.credentials.remove('portainer-2')).resolves.toBeUndefined();
    await expect(ctx.credentials.remove('nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('survives a rotated APP_SECRET with apiKeySet:false instead of crashing', async () => {
    const dir = await makeDataDir();
    dirs.push(dir);
    const first = await ctxFor({ DATA_DIR: dir, APP_SECRET: 'the-first-master-secret' });
    await first.credentials.create({ name: 'Prod', url: 'https://p.example.com', apiKey: API_KEY });

    const second = await ctxFor({ DATA_DIR: dir, APP_SECRET: 'a-completely-different-secret' });
    expect(second.credentials.apiKeyFor('portainer-1')).toBeNull();
    // called twice: the warning is emitted once per process, the call never throws
    expect(second.credentials.apiKeyFor('portainer-1')).toBeNull();
    const sanitized = second.credentials.sanitizedList()[0];
    expect(sanitized).toMatchObject({ apiKeySet: false, apiKeyHint: null });

    // ... and a host using it reports a configuration problem instead of a crash
    await second.hosts.create({
      name: 'Prod',
      connection: { type: 'portainer', credentialId: 'portainer-1', endpointId: 1 },
    });
    expect(second.hosts.tryBackendFor('prod')).toBeNull();
    expect((await second.hosts.view('prod', { probe: true })).status).toBe('not_configured');
  });

  it('tests and lists endpoints with unsaved overrides, falling back to the stored values', async () => {
    const ctx = await ctxFor();
    const url = await fakePortainer((reqUrl, res) => {
      if (reqUrl.split('?')[0] === '/api/endpoints') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ Id: 1, Name: 'prod', Type: 1, Status: 1 }]));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          Name: 'fake',
          ServerVersion: '29.1.3',
          OperatingSystem: 'linux',
          Architecture: 'aarch64',
          NCPU: 4,
          MemTotal: 1024,
          Containers: 0,
          ContainersRunning: 0,
          Images: 0,
        }),
      );
    });

    await ctx.credentials.create({ name: 'Prod', url, apiKey: API_KEY });
    const stored = await ctx.credentials.test('portainer-1');
    expect(stored.ok).toBe(true);
    expect(stored.info?.serverVersion).toBe('29.1.3');
    expect(stored.endpoints?.map((e) => e.name)).toEqual(['prod']);
    expect(JSON.stringify(stored)).not.toContain(API_KEY);

    // an unsaved url (the dialog's "Test" button) wins over the stored one
    const unsaved = await ctx.credentials.test(null, { url: 'http://127.0.0.1:1', apiKey: 'other' });
    expect(unsaved.ok).toBe(false);
    expect(typeof unsaved.error?.message).toBe('string');

    expect((await ctx.credentials.listEndpoints('portainer-1')).map((e) => e.id)).toEqual([1]);
    await expect(ctx.credentials.test(null, {})).rejects.toMatchObject({ code: 'bad_request' });
  });
});
