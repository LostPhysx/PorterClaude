// OWNER: B1. ConfigStore: creation, env seeding, atomic writes, sanitized projection.
import { describe, it, expect, afterEach } from 'vitest';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildContext, makeDataDir, TEST_PASSWORD } from './helpers.js';
import { verifyPassword } from '../../src/config/crypto.js';
import type { SessionConfig } from '../../src/sessions/model.js';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  const dir = await makeDataDir();
  dirs.push(dir);
  return dir;
}

function sampleSession(name: string): SessionConfig {
  return {
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('ConfigStore', () => {
  it('creates config.json with defaults and seeds APP_PASSWORD on an empty DATA_DIR', async () => {
    const dir = await freshDir();
    const { ctx } = await buildContext({ DATA_DIR: dir });

    const onDisk = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.backend.kind).toBe('none');
    expect(onDisk.general.imageNamespace).toBe('porterclaude');
    expect(onDisk.sessions).toEqual([]);
    expect(await verifyPassword(TEST_PASSWORD, onDisk.auth.passwordHash)).toBe(true);
    expect(ctx.config.get().auth.tokenVersion).toBe(1);
    await stat(path.join(dir, 'secret.key'));
  });

  it('keeps the stored hash on a second boot (env only seeds what is unset)', async () => {
    const dir = await freshDir();
    const first = await buildContext({ DATA_DIR: dir });
    const hash = first.ctx.config.get().auth.passwordHash;

    const second = await buildContext({ DATA_DIR: dir, APP_PASSWORD: 'a-different-password' });
    expect(second.ctx.config.get().auth.passwordHash).toBe(hash);
    expect(await verifyPassword('a-different-password', hash)).toBe(false);
  });

  it('seeds the portainer backend from the environment and encrypts the key at rest', async () => {
    const dir = await freshDir();
    const { ctx } = await buildContext({
      DATA_DIR: dir,
      PORTERCLAUDE_BACKEND: 'portainer',
      PORTAINER_URL: 'https://portainer.example.com/',
      PORTAINER_API_KEY: 'ptr_seeded_key_1234',
      PORTAINER_ENDPOINT_ID: '2',
    });

    const cfg = ctx.config.get();
    expect(cfg.backend.kind).toBe('portainer');
    expect(cfg.backend.portainer.url).toBe('https://portainer.example.com');
    expect(cfg.backend.portainer.endpointId).toBe(2);
    expect(cfg.backend.portainer.apiKeyEnc?.startsWith('enc:v1:')).toBe(true);
    expect(ctx.config.getPortainerApiKey()).toBe('ptr_seeded_key_1234');

    const raw = await readFile(path.join(dir, 'config.json'), 'utf8');
    expect(raw).not.toContain('ptr_seeded_key_1234');

    const sanitized = ctx.config.sanitized({ socketAvailable: false });
    expect(JSON.stringify(sanitized)).not.toContain('ptr_seeded_key_1234');
    expect(sanitized.backend.portainer.apiKeySet).toBe(true);
    expect(sanitized.backend.portainer.apiKeyHint).toBe('1234');
  });

  it('seeds the socket backend when asked', async () => {
    const dir = await freshDir();
    const { ctx } = await buildContext({ DATA_DIR: dir, PORTERCLAUDE_BACKEND: 'socket', DOCKER_SOCKET: '/tmp/docker.sock' });
    expect(ctx.config.get().backend.kind).toBe('socket');
    expect(ctx.config.get().backend.socket.socketPath).toBe('/tmp/docker.sock');
  });

  it('emits change and never leaves a partial file under concurrent writes', async () => {
    const dir = await freshDir();
    const { ctx } = await buildContext({ DATA_DIR: dir });
    let changes = 0;
    ctx.config.on('change', () => {
      changes++;
    });

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        ctx.config.update((draft) => {
          draft.ui.layout = { round: i };
        }),
      ),
    );

    expect(changes).toBe(50);
    const parsed = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(parsed.ui.layout).toBeTruthy();
    // no leftover temp files
    const leftovers = (await import('node:fs/promises')).readdir(dir);
    expect((await leftovers).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('recovers from a corrupt config.json instead of crashing', async () => {
    const dir = await freshDir();
    await buildContext({ DATA_DIR: dir });
    await writeFile(path.join(dir, 'config.json'), '{ this is not json', 'utf8');

    const { ctx } = await buildContext({ DATA_DIR: dir });
    expect(ctx.config.get().backend.kind).toBe('none');
    const files = await (await import('node:fs/promises')).readdir(dir);
    expect(files.some((f) => f.includes('corrupt'))).toBe(true);
  });

  // BE-11: the API rejects these values, but a hand-edited file must not cost the user
  // every stored session - an invalid general value falls back to its default instead.
  it('falls back to the default for an invalid general value without quarantining the file', async () => {
    const dir = await freshDir();
    const { ctx: first } = await buildContext({ DATA_DIR: dir });
    await first.config.putSession(sampleSession('alpha'));

    const file = path.join(dir, 'config.json');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.general.containerPrefix = '../x';
    raw.general.workspaceMount = 'relative';
    await writeFile(file, JSON.stringify(raw), 'utf8');

    const { ctx } = await buildContext({ DATA_DIR: dir });
    expect(ctx.config.general().containerPrefix).toBe('pc-');
    expect(ctx.config.general().workspaceMount).toBe('/workspace');
    expect(ctx.config.listSessions().map((s) => s.name)).toEqual(['alpha']);
    const files = await (await import('node:fs/promises')).readdir(dir);
    expect(files.some((f) => f.includes('corrupt'))).toBe(false);
  });

  it('stores, reads and deletes sessions (the storage B2 calls)', async () => {
    const dir = await freshDir();
    const { ctx } = await buildContext({ DATA_DIR: dir });

    await ctx.config.putSession(sampleSession('alpha'));
    await ctx.config.putSession(sampleSession('beta'));
    expect(ctx.config.listSessions().map((s) => s.name)).toEqual(['alpha', 'beta']);

    const updated = { ...sampleSession('alpha'), displayName: 'Alpha' };
    await ctx.config.putSession(updated);
    expect(ctx.config.listSessions()).toHaveLength(2);
    expect(ctx.config.getSession('alpha')?.displayName).toBe('Alpha');
    expect(ctx.config.getSession('nope')).toBeNull();

    expect(await ctx.config.deleteSession('alpha')).toBe(true);
    expect(await ctx.config.deleteSession('alpha')).toBe(false);
    expect(ctx.config.listSessions().map((s) => s.name)).toEqual(['beta']);
  });

  it('hands out frozen snapshots that cannot corrupt the store', async () => {
    const dir = await freshDir();
    const { ctx } = await buildContext({ DATA_DIR: dir });
    const cfg = ctx.config.get();
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(() => {
      (cfg as unknown as { version: number }).version = 99;
    }).toThrow();
  });
});
