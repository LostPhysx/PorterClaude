// OWNER: B1. Public API FROZEN — B2 uses get(), general(), sessions helpers and update().
// Persists <DATA_DIR>/config.json atomically (tmp file in the same dir + rename), serialises
// writes through an internal promise chain, and emits 'change' after every successful write.
import { EventEmitter } from 'node:events';
import type { AppConfig, GeneralConfig, SanitizedSettings } from './schema.js';
import type { SessionConfig } from '../sessions/model.js';
import type { SecretBox } from './crypto.js';
import type { Env } from '../env.js';
import type { Paths } from '../paths.js';
import type { Logger } from '../logger.js';

export interface ConfigStoreDeps {
  paths: Paths;
  env: Env;
  log: Logger;
  secrets: SecretBox;
}

// declaration merging: typed events on top of EventEmitter
export interface ConfigStore {
  on(event: 'change', listener: (cfg: AppConfig) => void): this;
  emit(event: 'change', cfg: AppConfig): boolean;
}

export class ConfigStore extends EventEmitter {
  constructor(private readonly deps: ConfigStoreDeps) {
    super();
  }

  /**
   * Read config.json (or create it from defaults), migrate old versions, then apply env
   * seeds: APP_PASSWORD (only when no password is set), PORTERCLAUDE_BACKEND / PORTAINER_*
   * (only when backend.kind is 'none'). Must be called exactly once at boot.
   */
  async init(): Promise<void> {
    throw new Error('TODO(B1): implement ConfigStore.init');
  }

  /** Current config (deep-frozen snapshot; never mutate). */
  get(): AppConfig {
    throw new Error('TODO(B1)');
  }

  general(): GeneralConfig {
    throw new Error('TODO(B1)');
  }

  /**
   * Apply a mutation to a deep clone of the config and persist it atomically.
   * The mutator may be async. Returns the new config. Emits 'change'.
   */
  async update(mutate: (draft: AppConfig) => void | Promise<void>): Promise<AppConfig> {
    throw new Error('TODO(B1)');
  }

  // --- secrets -------------------------------------------------------------

  /** Decrypted Portainer api key, or null. Never log the result. */
  getPortainerApiKey(): string | null {
    throw new Error('TODO(B1)');
  }

  async setPortainerApiKey(plain: string | null): Promise<void> {
    throw new Error('TODO(B1)');
  }

  // --- views ---------------------------------------------------------------

  /** Secret-free projection for GET /api/settings. */
  sanitized(extra: { socketAvailable: boolean }): SanitizedSettings {
    throw new Error('TODO(B1)');
  }

  // --- sessions (used by B2's SessionService; B1 only provides storage) -----

  listSessions(): SessionConfig[] {
    throw new Error('TODO(B1)');
  }

  getSession(name: string): SessionConfig | null {
    throw new Error('TODO(B1)');
  }

  /** Insert or replace by name; persists. */
  async putSession(cfg: SessionConfig): Promise<SessionConfig> {
    throw new Error('TODO(B1)');
  }

  /** Returns true when a session was removed. */
  async deleteSession(name: string): Promise<boolean> {
    throw new Error('TODO(B1)');
  }
}
