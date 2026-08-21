// OWNER: B1. Shared fixtures for the core tests (not a test file itself).
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';
import { createLogger } from '../../src/logger.js';
import { resolvePaths } from '../../src/paths.js';
import { loadOrCreateMasterSecret, SecretBox } from '../../src/config/crypto.js';
import { ConfigStore } from '../../src/config/store.js';
import { CredentialStore } from '../../src/hosts/credentials.js';
import { HostManager } from '../../src/hosts/manager.js';
import { AgentRegistry } from '../../src/agents/registry.js';
import { createAuthService } from '../../src/auth/index.js';
import { ContainerFilesService } from '../../src/containers/files.js';
import { ProfileStore } from '../../src/profiles/service.js';
import { ContainerService } from '../../src/containers/service.js';
import { ImageService } from '../../src/images/service.js';
import { SessionService } from '../../src/sessions/service.js';
import type { AppContext, ServiceDeps } from '../../src/context.js';

export const TEST_PASSWORD = 'test-password';

export interface TestHarness {
  ctx: AppContext;
  app: Express;
  dataDir: string;
  cleanup(): Promise<void>;
}

export async function makeDataDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'porterclaude-test-'));
}

export async function buildContext(env: Record<string, string> = {}): Promise<{ ctx: AppContext; dataDir: string }> {
  const dataDir = env.DATA_DIR ?? (await makeDataDir());
  const parsed = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATA_DIR: dataDir,
    APP_PASSWORD: TEST_PASSWORD,
    ENABLE_REQUEST_LOG: 'false',
    ...env,
  } as NodeJS.ProcessEnv);

  const log = createLogger(parsed);
  const paths = resolvePaths(parsed);
  const secrets = new SecretBox(await loadOrCreateMasterSecret(paths.secretFile, parsed.APP_SECRET));
  const config = new ConfigStore({ paths, env: parsed, log, secrets });
  await config.init();

  const credentials = new CredentialStore({ config, secrets, log });
  const hosts = new HostManager({ config, env: parsed, log, credentials });
  const agents = new AgentRegistry({ config, log });
  // mirrors src/index.ts: only a changed host connection rebuilds that host's transport
  config.on('change', () => hosts.invalidateChanged());

  const deps: ServiceDeps = {
    env: parsed,
    log,
    paths,
    config,
    hosts,
    agents,
    secrets,
    backends: hosts.legacyAccess(),
  };
  const images = new ImageService(deps);
  const containers = new ContainerService(deps);
  const ctx: AppContext = {
    ...deps,
    secrets,
    auth: createAuthService({ config, secrets, env: parsed, log }),
    credentials,
    containers,
    files: new ContainerFilesService(deps, containers),
    profiles: new ProfileStore({ config, secrets, log }),
    images,
    sessions: new SessionService(deps, containers, images),
    version: '0.0.0-test',
    startedAt: Date.now(),
  };
  return { ctx, dataDir };
}

/** Full app + context on a throw-away DATA_DIR. */
export async function makeHarness(env: Record<string, string> = {}): Promise<TestHarness> {
  const { ctx, dataDir } = await buildContext(env);
  const app = createApp(ctx);
  return {
    ctx,
    app,
    dataDir,
    cleanup: async () => {
      await ctx.hosts.close().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
