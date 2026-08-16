// FROZEN (planner-authored, types only). The dependency container passed to every router,
// service and the websocket layer. B1 builds it in index.ts; B2 only consumes it.
import type { HostManager, LegacyBackendAccess } from './hosts/manager.js';
import type { CredentialStore } from './hosts/credentials.js';
import type { AgentRegistry } from './agents/registry.js';
import type { ConfigStore } from './config/store.js';
import type { SecretBox } from './config/crypto.js';
import type { AuthService } from './auth/index.js';
import type { Env } from './env.js';
import type { Logger } from './logger.js';
import type { Paths } from './paths.js';
import type { SessionService } from './sessions/service.js';
import type { ImageService } from './images/service.js';
import type { TerminalService } from './terminals/service.js';

/** What every service constructor receives (first argument). */
export interface ServiceDeps {
  env: Env;
  log: Logger;
  paths: Paths;
  config: ConfigStore;
  /** v0.2: hosts own the docker transports and the per-host effective settings */
  hosts: HostManager;
  /** v0.2: agent definitions (built-in + custom) and their per-host/-session resolution */
  agents: AgentRegistry;
  /**
   * @deprecated v0.1 compatibility shim (`hosts.legacyAccess()`), pinned to the DEFAULT
   * host. It exists only so the v0.1 services compile while B2 threads `hostId` through
   * them. B2 acceptance: no `deps.backends.` remains in server/src.
   */
  backends: LegacyBackendAccess;
}

export interface AppContext extends ServiceDeps {
  secrets: SecretBox;
  auth: AuthService;
  credentials: CredentialStore;
  sessions: SessionService;
  images: ImageService;
  terminals: TerminalService;
  /** app version reported by /api/health */
  version: string;
  startedAt: number;
}
