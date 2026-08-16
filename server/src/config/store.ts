// OWNER: B1. Public API FROZEN — B2 uses get(), general(), sessions helpers and update().
// Persists <DATA_DIR>/config.json atomically (tmp file in the same dir + rename), serialises
// writes through an internal promise chain, and emits 'change' after every successful write.
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppConfigSchema, CONFIG_VERSION, defaultConfig } from './schema.js';
import type { AppConfig, GeneralConfig, SanitizedSettings } from './schema.js';
import type { SessionConfig } from '../sessions/model.js';
import type { SecretBox } from './crypto.js';
import { hashPassword } from './crypto.js';
import type { Env } from '../env.js';
import type { Paths } from '../paths.js';
import type { Logger } from '../logger.js';

export interface ConfigStoreDeps {
  paths: Paths;
  env: Env;
  log: Logger;
  secrets: SecretBox;
}

// Declaration merging gives EventEmitter typed 'change' events without changing the public
// API (this shape is part of the frozen skeleton). The rule below only guards against
// accidental merges; here it is deliberate and type-only.
/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
// declaration merging: typed events on top of EventEmitter
export interface ConfigStore {
  on(event: 'change', listener: (cfg: AppConfig) => void): this;
  emit(event: 'change', cfg: AppConfig): boolean;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export class ConfigStore extends EventEmitter {
  /* eslint-enable @typescript-eslint/no-unsafe-declaration-merging */
  private current: AppConfig | null = null;
  /** serialises every write so two concurrent update() calls cannot interleave */
  private queue: Promise<unknown> = Promise.resolve();
  private decryptWarned = false;

  constructor(private readonly deps: ConfigStoreDeps) {
    super();
  }

  /**
   * Read config.json (or create it from defaults), migrate old versions, then apply env
   * seeds: APP_PASSWORD (only when no password is set), PORTERCLAUDE_BACKEND / PORTAINER_*
   * (only when backend.kind is 'none'). Must be called exactly once at boot.
   */
  async init(): Promise<void> {
    const { paths, log } = this.deps;
    await fs.mkdir(paths.dataDir, { recursive: true });

    let loaded: AppConfig | null = null;
    let existed = false;
    try {
      const raw = await fs.readFile(paths.configFile, 'utf8');
      existed = true;
      loaded = this.parseConfig(raw);
      if (!loaded) {
        const backup = `${paths.configFile}.corrupt-${Date.now()}`;
        await fs.rename(paths.configFile, backup).catch(() => undefined);
        log.error({ backup }, 'config.json is unreadable; starting from defaults (previous file kept)');
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    this.current = deepFreeze(loaded ?? defaultConfig());

    // First boot (or a recovered file): make sure the file exists on disk, then seed.
    await this.update((draft) => {
      draft.version = CONFIG_VERSION;
      this.applyEnvSeeds(draft);
    });

    // Seeding the password hash is async, so it gets its own pass.
    const pw = this.deps.env.APP_PASSWORD;
    if (pw && !this.get().auth.passwordHash) {
      const hash = await hashPassword(pw);
      await this.update((draft) => {
        draft.auth.passwordHash = hash;
        draft.auth.updatedAt = new Date().toISOString();
      });
      log.info('seeded the app password from APP_PASSWORD');
    }

    log.info({ configFile: paths.configFile, created: !existed }, 'config store ready');
  }

  private parseConfig(raw: string): AppConfig | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const migrated = this.migrate(json);
    const parsed = AppConfigSchema.safeParse(migrated);
    if (!parsed.success) {
      this.deps.log.error({ issues: parsed.error.issues }, 'config.json does not match the schema');
      return null;
    }
    return parsed.data;
  }

  /** Version-based migrations. v1 is the first shipped shape. */
  private migrate(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object') return raw;
    const obj = raw as Record<string, unknown>;
    const version = typeof obj.version === 'number' ? obj.version : 0;
    if (version < 1) obj.version = CONFIG_VERSION;
    if (version > CONFIG_VERSION) {
      this.deps.log.warn({ version }, 'config.json was written by a newer version; using it as-is');
    }
    return obj;
  }

  private applyEnvSeeds(draft: AppConfig): void {
    const { env, secrets, log } = this.deps;
    if (draft.backend.kind !== 'none') return;

    const wantPortainer =
      env.PORTERCLAUDE_BACKEND === 'portainer' || (!!env.PORTAINER_URL && !!env.PORTAINER_API_KEY);
    const wantSocket = env.PORTERCLAUDE_BACKEND === 'socket';

    if (wantPortainer) {
      if (env.PORTAINER_URL) draft.backend.portainer.url = env.PORTAINER_URL.replace(/\/+$/, '');
      if (env.PORTAINER_API_KEY) draft.backend.portainer.apiKeyEnc = secrets.encrypt(env.PORTAINER_API_KEY);
      if (env.PORTAINER_ENDPOINT_ID !== undefined) draft.backend.portainer.endpointId = env.PORTAINER_ENDPOINT_ID;
      draft.backend.kind = 'portainer';
      log.info('seeded the portainer backend from the environment');
    } else if (wantSocket) {
      draft.backend.socket.socketPath = env.DOCKER_SOCKET;
      draft.backend.kind = 'socket';
      log.info('seeded the socket backend from the environment');
    }
  }

  /** Current config (deep-frozen snapshot; never mutate). */
  get(): AppConfig {
    if (!this.current) throw new Error('ConfigStore.init() has not been awaited');
    return this.current;
  }

  general(): GeneralConfig {
    return this.get().general;
  }

  /**
   * Apply a mutation to a deep clone of the config and persist it atomically.
   * The mutator may be async. Returns the new config. Emits 'change'.
   */
  async update(mutate: (draft: AppConfig) => void | Promise<void>): Promise<AppConfig> {
    const run = async (): Promise<AppConfig> => {
      const draft = structuredClone(this.current ?? defaultConfig()) as AppConfig;
      await mutate(draft);
      const next = AppConfigSchema.parse(draft);
      await this.writeAtomic(next);
      this.current = deepFreeze(next);
      this.emit('change', this.current);
      return this.current;
    };
    const chained = this.queue.then(run, run);
    // keep the chain alive (and unrejected) even if this update fails
    this.queue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  private async writeAtomic(cfg: AppConfig): Promise<void> {
    const file = this.deps.paths.configFile;
    const tmp = path.join(path.dirname(file), `${path.basename(file)}.${process.pid}.tmp`);
    const data = `${JSON.stringify(cfg, null, 2)}\n`;
    const handle = await fs.open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
    await fs.chmod(file, 0o600).catch(() => undefined);
  }

  // --- secrets -------------------------------------------------------------

  /** Decrypted Portainer api key, or null. Never log the result. */
  getPortainerApiKey(): string | null {
    const enc = this.get().backend.portainer.apiKeyEnc;
    if (!enc) return null;
    try {
      return this.deps.secrets.decrypt(enc);
    } catch {
      if (!this.decryptWarned) {
        this.decryptWarned = true;
        this.deps.log.warn('the stored portainer api key cannot be decrypted (APP_SECRET changed?)');
      }
      return null;
    }
  }

  async setPortainerApiKey(plain: string | null): Promise<void> {
    const enc = plain === null ? null : this.deps.secrets.encrypt(plain);
    await this.update((draft) => {
      draft.backend.portainer.apiKeyEnc = enc;
    });
  }

  // --- views ---------------------------------------------------------------

  /** Secret-free projection for GET /api/settings. */
  sanitized(extra: { socketAvailable: boolean }): SanitizedSettings {
    const cfg = this.get();
    const key = this.getPortainerApiKey();
    return {
      backend: {
        kind: cfg.backend.kind,
        portainer: {
          url: cfg.backend.portainer.url,
          endpointId: cfg.backend.portainer.endpointId,
          insecureTls: cfg.backend.portainer.insecureTls,
          apiKeySet: !!key,
          apiKeyHint: key ? key.slice(-4) : null,
        },
        socket: { ...cfg.backend.socket },
        socketAvailable: extra.socketAvailable,
      },
      general: { ...cfg.general },
      ui: { layout: cfg.ui.layout ?? null, theme: cfg.ui.theme },
      auth: { passwordSet: !!cfg.auth.passwordHash },
    };
  }

  // --- sessions (used by B2's SessionService; B1 only provides storage) -----

  listSessions(): SessionConfig[] {
    return this.get().sessions.map((s) => structuredClone(s) as SessionConfig);
  }

  getSession(name: string): SessionConfig | null {
    const found = this.get().sessions.find((s) => s.name === name);
    return found ? (structuredClone(found) as SessionConfig) : null;
  }

  /** Insert or replace by name; persists. */
  async putSession(cfg: SessionConfig): Promise<SessionConfig> {
    await this.update((draft) => {
      const idx = draft.sessions.findIndex((s) => s.name === cfg.name);
      if (idx >= 0) draft.sessions[idx] = cfg;
      else draft.sessions.push(cfg);
    });
    return this.getSession(cfg.name) as SessionConfig;
  }

  /** Returns true when a session was removed. */
  async deleteSession(name: string): Promise<boolean> {
    let removed = false;
    await this.update((draft) => {
      const idx = draft.sessions.findIndex((s) => s.name === name);
      if (idx >= 0) {
        draft.sessions.splice(idx, 1);
        removed = true;
      }
    });
    return removed;
  }
}
