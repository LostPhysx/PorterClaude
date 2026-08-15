// OWNER: B1. Process entry point: build the context, start HTTP + WS, shut down cleanly.
//
// Boot sequence (documented in docs/design/backend.md):
//   1. loadEnv()                          -> Env
//   2. createLogger(env)                  -> Logger
//   3. resolvePaths(env), mkdir -p dataDir
//   4. loadOrCreateMasterSecret() -> new SecretBox()
//   5. new ConfigStore({...}); await store.init()      (seeds APP_PASSWORD / PORTAINER_*)
//   6. new BackendManager({ config, env, log }); config.on('change', () => backends.invalidate())
//   7. new SessionService(deps), new ImageService(deps), new TerminalService(deps, sessions)
//   8. createAuthService(...) -> AppContext
//   9. createApp(ctx) -> http.createServer(app)
//  10. attachTerminalWs(server, ctx)      (B2, terminals/ws.ts)
//  11. server.listen(env.PORT, env.HOST)
//  12. best-effort startup reconcile: ctx.sessions.reconcile() (log-only on failure --
//      a missing/unreachable backend must NOT prevent the server from starting)
//  13. SIGINT/SIGTERM -> terminals.closeAll(), server.close(), backends.close(), exit
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AppContext } from './context.js';

export interface StartedServer {
  server: Server;
  ctx: AppContext;
  close(): Promise<void>;
}

/** Build the AppContext and start listening. Exported so tests can boot the real thing. */
export async function start(): Promise<StartedServer> {
  throw new Error('TODO(B1): implement start');
}

export async function main(): Promise<void> {
  throw new Error('TODO(B1): implement main (calls start() + installs signal handlers)');
}

const isEntry =
  !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntry) {
  void main().catch((err) => {
    console.error('[porterclaude] fatal:', err);
    process.exit(1);
  });
}
