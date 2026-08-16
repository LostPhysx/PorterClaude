// OWNER: B1. HostManager CRUD, views and the Portainer endpoint import (v0.2).
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { rm } from 'node:fs/promises';
import { buildContext } from './helpers.js';
import { AppError } from '../../src/http/errors.js';
import { slugifyHostId, uniqueHostId } from '../../src/hosts/model.js';
import type { AppContext } from '../../src/context.js';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await (closers.pop() as () => Promise<void>)();
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true });
});

async function ctxFor(env: Record<string, string> = {}): Promise<AppContext> {
  const built = await buildContext(env);
  dirs.push(built.dataDir);
  closers.push(async () => {
    await built.ctx.hosts.close().catch(() => undefined);
  });
  return built.ctx;
}

/** A Portainer stub that only answers the endpoint list. */
async function fakePortainer(endpoints: unknown[]): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
    if ((req.url ?? '').startsWith('/api/endpoints')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(endpoints));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  closers.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${port}`, requests };
}

describe('host id helpers', () => {
  it('slugifies names and de-duplicates ids', () => {
    expect(slugifyHostId('My Docker box!')).toBe('my-docker-box');
    expect(slugifyHostId('  ')).toBe('host');
    expect(slugifyHostId('Prod (portainer)')).toBe('prod-portainer');
    expect(uniqueHostId('prod', [])).toBe('prod');
    expect(uniqueHostId('prod', ['prod'])).toBe('prod-2');
    expect(uniqueHostId('prod', ['prod', 'prod-2'])).toBe('prod-3');
  });
});

describe('HostManager CRUD', () => {
  it('derives the id, makes the first host the default and keeps ids unique', async () => {
    const ctx = await ctxFor();
    const first = await ctx.hosts.create({
      name: 'Local docker',
      connection: { type: 'socket', socketPath: '/x.sock' },
    });
    expect(first.id).toBe('local-docker');
    expect(ctx.hosts.defaultHostId()).toBe('local-docker');
    expect(first.agents.enabled).toEqual(['claude']);

    await ctx.credentials.create({ name: 'P', url: 'https://p.example.com', apiKey: 'k1234' });
    const second = await ctx.hosts.create({
      name: 'Local docker',
      connection: { type: 'portainer', credentialId: 'portainer-1', endpointId: 1 },
      agents: ['claude', 'claude', 'opencode'],
    });
    expect(second.id).toBe('local-docker-2');
    expect(second.agents.enabled).toEqual(['claude', 'opencode']);
    expect(ctx.hosts.defaultHostId()).toBe('local-docker');

    // an explicitly requested id that is taken is a 409
    await expect(
      ctx.hosts.create({
        id: 'local-docker',
        name: 'Third',
        connection: { type: 'portainer', credentialId: 'portainer-1', endpointId: 2 },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('resolves an omitted host id to the default one', async () => {
    const ctx = await ctxFor();
    await ctx.hosts.create({ name: 'A', connection: { type: 'socket', socketPath: '/a.sock' } });
    await ctx.credentials.create({ name: 'P', url: 'https://p.example.com', apiKey: 'k1234' });
    const b = await ctx.hosts.create({
      name: 'B',
      connection: { type: 'portainer', credentialId: 'portainer-1', endpointId: 1 },
      makeDefault: true,
    });

    expect(ctx.hosts.requireHostId()).toBe(b.id);
    expect(ctx.hosts.requireHostId('a')).toBe('a');
    expect(() => ctx.hosts.requireHostId('nope')).toThrow(/does not exist/);
    expect(ctx.hosts.hostForSession({ name: 'web', hostId: 'a' }).id).toBe('a');
    expect(() => ctx.hosts.hostForSession({ name: 'web', hostId: 'gone' })).toThrow(/does not exist/);
  });

  it('updates a host without touching the fields that were not sent', async () => {
    const ctx = await ctxFor();
    await ctx.hosts.create({
      name: 'A',
      connection: { type: 'socket', socketPath: '/a.sock' },
      notes: 'the box under the desk',
    });
    const updated = await ctx.hosts.update('a', { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    expect(updated.notes).toBe('the box under the desk');
    expect(updated.connection).toEqual({ type: 'socket', socketPath: '/a.sock' });
    expect(updated.updatedAt >= updated.createdAt).toBe(true);

    await expect(ctx.hosts.update('nope', { name: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('allows exactly one socket host', async () => {
    const ctx = await ctxFor();
    await ctx.hosts.create({ name: 'A', connection: { type: 'socket', socketPath: '/a.sock' } });
    await expect(
      ctx.hosts.create({ name: 'B', connection: { type: 'socket', socketPath: '/b.sock' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // updating the existing socket host is fine (it is not "another" socket host)
    await expect(
      ctx.hosts.update('a', { connection: { type: 'socket', socketPath: '/b.sock' } }),
    ).resolves.toMatchObject({ id: 'a' });
  });

  it('promotes another host when the default one is deleted, and never touches the engine', async () => {
    const ctx = await ctxFor();
    await ctx.credentials.create({ name: 'P', url: 'https://p.example.com', apiKey: 'k1234' });
    await ctx.hosts.create({ name: 'A', connection: { type: 'socket', socketPath: '/a.sock' } });
    await ctx.hosts.create({
      name: 'B',
      connection: { type: 'portainer', credentialId: 'portainer-1', endpointId: 1 },
    });
    expect(ctx.hosts.defaultHostId()).toBe('a');

    await ctx.hosts.remove('a');
    expect(ctx.hosts.list().map((h) => h.id)).toEqual(['b']);
    expect(ctx.hosts.defaultHostId()).toBe('b');

    await ctx.hosts.remove('b');
    expect(ctx.hosts.defaultHostId()).toBeNull();
    await expect(ctx.hosts.remove('b')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses to delete a host with sessions unless force is given', async () => {
    const ctx = await ctxFor();
    await ctx.hosts.create({ name: 'A', connection: { type: 'socket', socketPath: '/a.sock' } });
    await ctx.config.putSession({
      name: 'web',
      hostId: 'a',
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

    await expect(ctx.hosts.remove('a')).rejects.toMatchObject({ code: 'conflict' });
    await ctx.hosts.remove('a', { force: true });
    expect(ctx.hosts.list()).toEqual([]);
    // the stored session survives as a dangling one; nothing on the engine was removed
    expect(ctx.config.listSessions().map((s) => s.name)).toEqual(['web']);
  });

  it('validates the enabled agent list of a host through setEnabledAgents', async () => {
    const ctx = await ctxFor();
    await ctx.hosts.create({ name: 'A', connection: { type: 'socket', socketPath: '/a.sock' } });
    const host = await ctx.hosts.setEnabledAgents('a', ['opencode', 'claude', 'opencode']);
    expect(host.agents.enabled).toEqual(['opencode', 'claude']);
    expect(ctx.agents.enabledForHost(host).map((d) => d.id)).toEqual(['claude', 'opencode']);
  });
});

describe('HostManager.importPortainerEndpoints', () => {
  const ENDPOINTS = [
    { Id: 1, Name: 'prod', Type: 1, Status: 1 },
    { Id: 2, Name: 'kube cluster', Type: 5, Status: 1 },
    { Id: 3, Name: 'Staging Box', Type: 2, Status: 1 },
  ];

  it('creates one host per docker endpoint and skips the rest with a reason', async () => {
    const ctx = await ctxFor();
    const portainer = await fakePortainer(ENDPOINTS);
    await ctx.credentials.create({ name: 'P', url: portainer.url, apiKey: 'ptr_key_abcd' });

    const result = await ctx.hosts.importPortainerEndpoints('portainer-1');
    expect(result.created).toEqual(['prod', 'staging-box']);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([
      { endpointId: 2, name: 'kube cluster', reason: 'not a docker endpoint' },
    ]);
    expect(result.hosts.map((h) => h.id)).toEqual(['prod', 'staging-box']);
    // the first imported host becomes the default of an empty install
    expect(ctx.hosts.defaultHostId()).toBe('prod');
    expect(ctx.hosts.require('staging-box').connection).toEqual({
      type: 'portainer',
      credentialId: 'portainer-1',
      endpointId: 3,
    });
    expect(JSON.stringify(result)).not.toContain('ptr_key_abcd');
  });

  it('updates instead of duplicating on a second run', async () => {
    const ctx = await ctxFor();
    const portainer = await fakePortainer(ENDPOINTS);
    await ctx.credentials.create({ name: 'P', url: portainer.url, apiKey: 'ptr_key_abcd' });
    await ctx.hosts.importPortainerEndpoints('portainer-1');

    const again = await ctx.hosts.importPortainerEndpoints('portainer-1', {
      nameTemplate: 'edge {name}',
    });
    expect(again.created).toEqual([]);
    expect(again.updated).toEqual(['prod', 'staging-box']);
    expect(ctx.hosts.list()).toHaveLength(2);
    expect(ctx.hosts.require('prod').name).toBe('edge prod');

    const skipping = await ctx.hosts.importPortainerEndpoints('portainer-1', { update: false });
    expect(skipping.created).toEqual([]);
    expect(skipping.updated).toEqual([]);
    expect(skipping.skipped.map((s) => s.reason)).toContain('already imported');
  });

  it('honours an explicit endpoint selection and 404s an unknown credential', async () => {
    const ctx = await ctxFor();
    const portainer = await fakePortainer(ENDPOINTS);
    await ctx.credentials.create({ name: 'P', url: portainer.url, apiKey: 'ptr_key_abcd' });

    const result = await ctx.hosts.importPortainerEndpoints('portainer-1', { endpointIds: [3] });
    expect(result.created).toEqual(['staging-box']);
    await expect(ctx.hosts.importPortainerEndpoints('nope')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('HostView', () => {
  it('renders every host without probing when probe is not requested', async () => {
    const ctx = await ctxFor();
    await ctx.hosts.create({
      name: 'A',
      connection: { type: 'socket', socketPath: '/definitely/not/here.sock' },
      notes: 'note',
    });
    const views = await ctx.hosts.views();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: 'a',
      isDefault: true,
      supported: true,
      status: 'unknown',
      info: null,
      error: null,
      notes: 'note',
      sessionCount: 0,
    });
    expect(views[0]?.connectionLabel).toBe('socket: /definitely/not/here.sock');

    const probed = await ctx.hosts.view('a', { probe: true });
    expect(probed.status).toBe('unreachable');
    expect(typeof probed.error).toBe('string');

    // and the cached probe answers the next un-probed call
    expect((await ctx.hosts.view('a')).status).toBe('unreachable');
    await expect(ctx.hosts.view('nope')).rejects.toBeInstanceOf(AppError);
  });

  it('shows the credential name and url of a portainer host', async () => {
    const ctx = await ctxFor();
    await ctx.credentials.create({ name: 'Prod portainer', url: 'https://p.example.com', apiKey: 'k1234' });
    await ctx.hosts.create({
      name: 'Prod',
      connection: { type: 'portainer', credentialId: 'portainer-1', endpointId: 2 },
    });
    const view = await ctx.hosts.view('prod');
    expect(view.credentialName).toBe('Prod portainer');
    expect(view.connectionLabel).toBe('portainer: https://p.example.com#2');
    expect(JSON.stringify(view)).not.toContain('k1234');
  });
});
