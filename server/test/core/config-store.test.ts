// OWNER: B1. ConfigStore: creation, env seeding, atomic writes, sanitized projection.
import { describe, it, expect, afterEach } from 'vitest';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildContext, makeDataDir, TEST_PASSWORD } from './helpers.js';
import { SecretBox, verifyPassword } from '../../src/config/crypto.js';
import type { SessionConfig } from '../../src/sessions/model.js';

/** master secret used by the v1 fixtures below (the same value seeds APP_SECRET) */
const FIXTURE_SECRET = 'a-fixture-master-secret-value';
const FIXTURE_API_KEY = 'ptr_livesecretkey_a1b2';

/** A v0.1 config.json, written straight to disk so init() has to migrate it. */
function v1Config(backend: Record<string, unknown>, sessions: unknown[] = []): Record<string, unknown> {
  return {
    version: 1,
    auth: { passwordHash: null, tokenVersion: 3, updatedAt: null },
    backend,
    general: {
      workspacesRoot: '/srv/porterclaude/workspaces',
      sharedClaudeVolume: 'porterclaude-claude',
      sharedClaudeHomeVolume: 'porterclaude-claude-home',
      toolsVolume: 'porterclaude-tools',
      defaultRecipe: 'python',
      containerPrefix: 'pc-',
      sessionNetwork: null,
      imageNamespace: 'porterclaude',
      containerHome: '/home/dev',
      workspaceMount: '/workspace',
      toolsMount: '/opt/porterclaude',
    },
    sessions,
    ui: { layout: { v: 1 }, theme: 'dark' },
  };
}

function v1Session(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    image: { type: 'recipe', recipe: 'node' },
    workspace: { type: 'volume' },
    env: { FOO: 'bar' },
    ports: [],
    extraMounts: [],
    limits: {},
    shareHistory: true,
    autoStart: true,
    network: null,
    user: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...extra,
  };
}

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
    hostId: 'default',
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
  };
}

describe('ConfigStore', () => {
  it('creates config.json with defaults and seeds APP_PASSWORD on an empty DATA_DIR', async () => {
    const dir = await freshDir();
    const { ctx } = await buildContext({ DATA_DIR: dir });

    const onDisk = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(onDisk.version).toBe(2);
    expect(onDisk.backend).toBeUndefined();
    expect(onDisk.hosts).toEqual([]);
    expect(onDisk.defaultHostId).toBeNull();
    expect(onDisk.credentials).toEqual({ portainer: [] });
    expect(onDisk.agents).toEqual({ custom: [] });
    expect(onDisk.general.imageNamespace).toBe('porterclaude');
    expect(onDisk.general.volumePrefix).toBe('porterclaude-');
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

  it('seeds ONE portainer credential + host from the environment, key encrypted at rest', async () => {
    const dir = await freshDir();
    const { ctx } = await buildContext({
      DATA_DIR: dir,
      PORTERCLAUDE_BACKEND: 'portainer',
      PORTAINER_URL: 'https://portainer.example.com/',
      PORTAINER_API_KEY: FIXTURE_API_KEY,
      PORTAINER_ENDPOINT_ID: '2',
    });

    const cfg = ctx.config.get();
    expect(cfg.hosts).toHaveLength(1);
    expect(cfg.defaultHostId).toBe('default');
    const host = cfg.hosts[0]!;
    expect(host.id).toBe('default');
    expect(host.connection).toEqual({ type: 'portainer', credentialId: 'portainer-1', endpointId: 2 });
    expect(host.agents.enabled).toEqual(['claude']);
    expect(cfg.credentials.portainer).toHaveLength(1);
    expect(cfg.credentials.portainer[0]!.url).toBe('https://portainer.example.com');
    expect(cfg.credentials.portainer[0]!.name).toBe('portainer.example.com');

    // the key is stored encrypted and is decryptable through the CredentialStore only
    const raw = await readFile(path.join(dir, 'config.json'), 'utf8');
    expect(raw).not.toContain(FIXTURE_API_KEY);
    expect(JSON.parse(raw).credentials.portainer[0].apiKeyEnc).toMatch(/^enc:v1:/);
    expect(ctx.credentials.apiKeyFor('portainer-1')).toBe(FIXTURE_API_KEY);
  });

  it('seeds a socket host (and no credential) from PORTERCLAUDE_BACKEND=socket', async () => {
    const dir = await freshDir();
    const { ctx } = await buildContext({
      DATA_DIR: dir,
      PORTERCLAUDE_BACKEND: 'socket',
      DOCKER_SOCKET: '/var/run/docker.sock',
    });
    const cfg = ctx.config.get();
    expect(cfg.hosts).toHaveLength(1);
    expect(cfg.hosts[0]!.connection).toEqual({ type: 'socket', socketPath: '/var/run/docker.sock' });
    expect(cfg.credentials.portainer).toEqual([]);
    expect(cfg.defaultHostId).toBe('default');
  });

  it('never re-applies the env seeds once a host exists', async () => {
    const dir = await freshDir();
    const first = await buildContext({ DATA_DIR: dir, PORTERCLAUDE_BACKEND: 'socket' });
    await first.ctx.hosts.remove('default');
    await first.ctx.hosts.create({ name: 'Manual', connection: { type: 'socket', socketPath: '/x.sock' } });

    const second = await buildContext({
      DATA_DIR: dir,
      PORTERCLAUDE_BACKEND: 'portainer',
      PORTAINER_URL: 'https://other.example.com',
      PORTAINER_API_KEY: FIXTURE_API_KEY,
    });
    const cfg = second.ctx.config.get();
    expect(cfg.hosts).toHaveLength(1);
    expect(cfg.hosts[0]!.name).toBe('Manual');
    expect(cfg.credentials.portainer).toEqual([]);
  });

  it('migrates a v0.1 portainer config into a credential + host and keeps the key decryptable', async () => {
    const dir = await freshDir();
    const secrets = new SecretBox(FIXTURE_SECRET);
    await writeFile(path.join(dir, 'secret.key'), `${FIXTURE_SECRET}\n`, 'utf8');
    await writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify(
        v1Config(
          {
            kind: 'portainer',
            portainer: {
              url: 'https://portainer.example.com',
              apiKeyEnc: secrets.encrypt(FIXTURE_API_KEY),
              endpointId: 2,
              insecureTls: true,
            },
            socket: { socketPath: '/var/run/docker.sock' },
          },
          [v1Session('alpha'), v1Session('beta', { shareHistory: false })],
        ),
        null,
        2,
      ),
      'utf8',
    );

    const { ctx } = await buildContext({ DATA_DIR: dir, APP_SECRET: FIXTURE_SECRET });
    const cfg = ctx.config.get();

    expect(cfg.version).toBe(2);
    expect(cfg.defaultHostId).toBe('default');
    expect(cfg.hosts).toHaveLength(1);
    expect(cfg.hosts[0]!.connection).toEqual({
      type: 'portainer',
      credentialId: 'portainer-1',
      endpointId: 2,
    });
    expect(cfg.credentials.portainer[0]).toMatchObject({
      id: 'portainer-1',
      name: 'portainer.example.com',
      url: 'https://portainer.example.com',
      insecureTls: true,
    });
    // the blob was copied verbatim, so it still decrypts with the same master key
    expect(ctx.credentials.apiKeyFor('portainer-1')).toBe(FIXTURE_API_KEY);
    const sanitized = ctx.credentials.sanitizedList()[0]!;
    expect(sanitized.apiKeySet).toBe(true);
    expect(sanitized.apiKeyHint).toBe(FIXTURE_API_KEY.slice(-4));
    expect(sanitized.hostIds).toEqual(['default']);

    // lossless: sessions keep everything and gain hostId/agents
    expect(cfg.sessions.map((s) => s.name)).toEqual(['alpha', 'beta']);
    expect(cfg.sessions.every((s) => s.hostId === 'default')).toBe(true);
    expect(cfg.sessions.every((s) => s.agents === null)).toBe(true);
    expect(cfg.sessions[1]!.shareHistory).toBe(false);
    expect(cfg.sessions[0]!.env).toEqual({ FOO: 'bar' });
    expect(cfg.sessions[0]!.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(cfg.general.defaultRecipe).toBe('python');
    expect(cfg.general.sharedClaudeVolume).toBe('porterclaude-claude');
    expect(cfg.auth.tokenVersion).toBe(3);
    expect(cfg.ui.theme).toBe('dark');

    // the v1 file is kept for a rollback, and `backend` is gone from the new one
    const backup = JSON.parse(await readFile(path.join(dir, 'config.json.v1.bak'), 'utf8'));
    expect(backup.version).toBe(1);
    expect(backup.backend.kind).toBe('portainer');
    const onDisk = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(onDisk.backend).toBeUndefined();
    expect(onDisk.version).toBe(2);
  });

  it('migrates a v0.1 socket config and is idempotent on the next boots', async () => {
    const dir = await freshDir();
    await writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify(
        v1Config(
          { kind: 'socket', portainer: {}, socket: { socketPath: '/run/user/1000/docker.sock' } },
          [v1Session('alpha')],
        ),
      ),
      'utf8',
    );

    const first = await buildContext({ DATA_DIR: dir });
    expect(first.ctx.config.get().hosts[0]!.connection).toEqual({
      type: 'socket',
      socketPath: '/run/user/1000/docker.sock',
    });
    expect(first.ctx.config.get().credentials.portainer).toEqual([]);
    const backupBefore = await readFile(path.join(dir, 'config.json.v1.bak'), 'utf8');

    // a host created after the migration must survive the next boot (no second migration)
    await first.ctx.hosts.create({
      name: 'Second',
      connection: { type: 'portainer', credentialId: 'x', endpointId: 1 },
    }).catch(() => undefined);

    const second = await buildContext({ DATA_DIR: dir });
    expect(second.ctx.config.get().hosts).toHaveLength(1);
    expect(second.ctx.config.get().sessions[0]!.hostId).toBe('default');
    const third = await buildContext({ DATA_DIR: dir });
    expect(third.ctx.config.get().version).toBe(2);
    // the backup is written exactly once and never overwritten
    expect(await readFile(path.join(dir, 'config.json.v1.bak'), 'utf8')).toBe(backupBefore);
  });

  it('migrates a v0.1 config without a backend into the hostless first-run state', async () => {
    const dir = await freshDir();
    await writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify(v1Config({ kind: 'none', portainer: {}, socket: {} })),
      'utf8',
    );
    const { ctx } = await buildContext({ DATA_DIR: dir });
    expect(ctx.config.get().hosts).toEqual([]);
    expect(ctx.config.get().defaultHostId).toBeNull();
    expect(ctx.hosts.isConfigured()).toBe(false);
    await stat(path.join(dir, 'config.json.v1.bak'));
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

  it('fills hosts.socketHostId in the sanitized settings projection', async () => {
    const dir = await freshDir();
    const { ctx } = await buildContext({ DATA_DIR: dir });
    expect(ctx.config.sanitized({ socketAvailable: false }).hosts).toEqual({
      count: 0,
      defaultHostId: null,
      socketAvailable: false,
      socketHostId: null,
    });

    await ctx.hosts.create({ name: 'Local docker', connection: { type: 'socket', socketPath: '/x.sock' } });
    const after = ctx.config.sanitized({ socketAvailable: true }).hosts;
    expect(after).toEqual({
      count: 1,
      defaultHostId: 'local-docker',
      socketAvailable: true,
      socketHostId: 'local-docker',
    });
  });

  it('recovers from a corrupt config.json instead of crashing', async () => {
    const dir = await freshDir();
    await buildContext({ DATA_DIR: dir });
    await writeFile(path.join(dir, 'config.json'), '{ this is not json', 'utf8');

    const { ctx } = await buildContext({ DATA_DIR: dir });
    expect(ctx.config.get().hosts).toEqual([]);
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
