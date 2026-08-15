// FROZEN (planner-authored, types only). The dependency container passed to every router,
// service and the websocket layer. B1 builds it in index.ts; B2 only consumes it.
import type { BackendManager } from './backends/index.js';
import type { ConfigStore } from './config/store.js';
import type { SecretBox } from './config/crypto.js';
import type { AuthService } from './auth/index.js';
import type { Env } from './env.js';
import type { Logger } from './logger.js';
import type { Paths } from './paths.js';
import type { SessionService } from './sessions/service.js';
import type { ImageService } from './images/service.js';
import type { TerminalService } from './terminals/service.js';

/** What every B2 service constructor receives (first argument). */
export interface ServiceDeps {
  env: Env;
  log: Logger;
  paths: Paths;
  config: ConfigStore;
  backends: BackendManager;
}

export interface AppContext extends ServiceDeps {
  secrets: SecretBox;
  auth: AuthService;
  sessions: SessionService;
  images: ImageService;
  terminals: TerminalService;
  /** app version reported by /api/health */
  version: string;
  startedAt: number;
}
