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
import { BackendManager } from '../../src/backends/index.js';
import { createAuthService } from '../../src/auth/index.js';
import { SessionService } from '../../src/sessions/service.js';
import { ImageService } from '../../src/images/service.js';
import { TerminalService } from '../../src/terminals/service.js';
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

  const backends = new BackendManager({ config, env: parsed, log });
  // mirrors src/index.ts: only backend settings changes rebuild the transport
  config.on('change', () => backends.invalidateIfChanged());

  const deps: ServiceDeps = { env: parsed, log, paths, config, backends };
  const ctx: AppContext = {
    ...deps,
    secrets,
    auth: createAuthService({ config, secrets, env: parsed, log }),
    sessions: new SessionService(deps),
    images: new ImageService(deps),
    terminals: new TerminalService(deps, new SessionService(deps)),
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
      await ctx.backends.close().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
