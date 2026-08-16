// OWNER: B1. Process entry point: build the context, start HTTP + WS, shut down cleanly.
//
// Boot sequence (documented in docs/design/backend.md):
//   1. loadEnv()                          -> Env
//   2. createLogger(env)                  -> Logger
//   3. resolvePaths(env), mkdir -p dataDir
//   4. loadOrCreateMasterSecret() -> new SecretBox()
//   5. new ConfigStore({...}); await store.init()      (seeds APP_PASSWORD / PORTAINER_*)
//   6. new BackendManager({ config, env, log }); config.on('change', () => backends.invalidateIfChanged())
//   7. new SessionService(deps), new ImageService(deps), new TerminalService(deps, sessions)
//   8. createAuthService(...) -> AppContext
//   9. createApp(ctx) -> http.createServer(app)
//  10. attachTerminalWs(server, ctx)      (B2, terminals/ws.ts)
//  11. server.listen(env.PORT, env.HOST)
//  12. best-effort startup reconcile: ctx.sessions.reconcile() (log-only on failure --
//      a missing/unreachable backend must NOT prevent the server from starting)
//  13. SIGINT/SIGTERM -> terminals.closeAll(), server.close(), backends.close(), exit
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AppContext, ServiceDeps } from './context.js';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';
import { resolvePaths, SERVER_ROOT } from './paths.js';
import { loadOrCreateMasterSecret, SecretBox } from './config/crypto.js';
import { ConfigStore } from './config/store.js';
import { BackendManager } from './backends/index.js';
import { createAuthService } from './auth/index.js';
import { SessionService } from './sessions/service.js';
import { ImageService } from './images/service.js';
import { TerminalService } from './terminals/service.js';
import { attachTerminalWs } from './terminals/ws.js';

export interface StartedServer {
  server: Server;
  ctx: AppContext;
  close(): Promise<void>;
}

/** Version reported by /api/health; read from server/package.json at boot. */
export function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Build the AppContext and start listening. Exported so tests can boot the real thing. */
export async function start(): Promise<StartedServer> {
  const env = loadEnv();
  const log = createLogger(env);
  const paths = resolvePaths(env);
  await fsp.mkdir(paths.dataDir, { recursive: true });

  const masterSecret = await loadOrCreateMasterSecret(paths.secretFile, env.APP_SECRET);
  const secrets = new SecretBox(masterSecret);

  const config = new ConfigStore({ paths, env, log, secrets });
  await config.init();

  const backends = new BackendManager({ config, env, log });
  // only rebuild the backend when its own settings changed: 'change' also fires for UI
  // layout autosave / session writes / password changes, and tearing the transport down
  // there would abort in-flight builds, pulls and execs.
  config.on('change', () => backends.invalidateIfChanged());

  const deps: ServiceDeps = { env, log, paths, config, backends };
  const sessions = new SessionService(deps);
  const images = new ImageService(deps);
  const terminals = new TerminalService(deps, sessions);
  const auth = createAuthService({ config, secrets, env, log });

  const ctx: AppContext = {
    ...deps,
    secrets,
    auth,
    sessions,
    images,
    terminals,
    version: readVersion(),
    startedAt: Date.now(),
  };

  const app = createApp(ctx);
  const server = http.createServer(app);
  const ws = attachTerminalWs(server, ctx);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(env.PORT, env.HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });
  log.info(
    { host: env.HOST, port: env.PORT, dataDir: paths.dataDir, webRoot: paths.webPublic },
    'porterclaude is listening',
  );

  if (!backends.isConfigured()) {
    log.warn('no docker backend configured yet -- open Settings to connect one');
  }

  // 12. best-effort reconcile; a broken/absent backend must never block startup
  void (async () => {
    try {
      const report = await sessions.reconcile();
      log.info({ report }, 'startup reconcile complete');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'startup reconcile skipped');
    }
  })();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      terminals.closeAll();
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'closing terminals failed');
    }
    try {
      await ws.close();
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'closing the websocket server failed');
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await backends.close();
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'closing the docker backend failed');
    }
  };

  return { server, ctx, close };
}

export async function main(): Promise<void> {
  const started = await start();
  const { log } = started.ctx;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      log.warn('forced exit after 10s');
      process.exit(0);
    }, 10_000);
    force.unref();
    started
      .close()
      .then(() => {
        clearTimeout(force);
        process.exit(0);
      })
      .catch((err) => {
        log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error({ err: reason }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => log.error({ err }, 'uncaught exception'));
}

const isEntry =
  !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntry) {
  void main().catch((err) => {
    console.error('[porterclaude] fatal:', err);
    process.exit(1);
  });
}
