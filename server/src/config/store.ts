// OWNER: B1. Public API FROZEN — B2 uses get(), general(), sessions helpers and update().
// Persists <DATA_DIR>/config.json atomically (tmp file in the same dir + rename), serialises
// writes through an internal promise chain, and emits 'change' after every successful write.
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppConfigSchema, CONFIG_VERSION, CONFIG_VERSION_V1, defaultConfig } from './schema.js';
import type { AppConfig, GeneralConfig, SanitizedSettings } from './schema.js';
import type { SessionConfig } from '../sessions/model.js';
import type { HostConfig, PortainerCredentialConfig } from '../hosts/model.js';
import { LEGACY_HOST_ID } from '../hosts/model.js';
import { DEFAULT_ENABLED_AGENT_IDS } from '../agents/builtin.js';
import { AgentDefinitionSchema } from '../agents/model.js';
import type { AgentDefinition } from '../agents/model.js';
import type { SecretBox } from './crypto.js';
import { hashPassword } from './crypto.js';
import type { Env } from '../env.js';
import type { Paths } from '../paths.js';
import type { Logger } from '../logger.js';
import { shortId } from '../util/ids.js';

/**
 * Instance id of a store whose `init()` never ran. It is a REAL id (containers labelled with
 * it are owned by this process), just not a persisted one — every code path that creates a
 * container goes through an initialised store.
 */
const UNKNOWN_INSTANCE_ID = 'pc-unknown';

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

  constructor(private readonly deps: ConfigStoreDeps) {
    super();
  }

  /**
   * Read config.json (or create it from defaults), migrate old versions (v1 -> v2, see
   * `migrate`), then apply env seeds: APP_PASSWORD (only when no password is set),
   * PORTERCLAUDE_BACKEND / PORTAINER_* (only when NO host exists yet). Must be called
   * exactly once at boot.
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
      // identity of this install; generated ONCE and never rewritten (see schema.ts)
      if (!draft.instanceId) {
        draft.instanceId = `pc-${shortId(6)}`;
        log.info({ instanceId: draft.instanceId }, 'generated the instance id of this install');
      }
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
    const migrated = this.dropInvalidCustomAgents(this.migrate(json));
    const parsed = AppConfigSchema.safeParse(migrated);
    if (!parsed.success) {
      this.deps.log.error({ issues: parsed.error.issues }, 'config.json does not match the schema');
      return null;
    }
    return parsed.data;
  }

  /**
   * Drop stored custom agents that no longer satisfy `AgentDefinitionSchema` (a definition
   * written before the path rules of `AgentPathSchema` existed, e.g. a `sharedPaths` entry
   * with a `..` segment). Without this the whole config.json would fail to parse and be
   * renamed to .corrupt-<ts> - losing hosts, credentials and sessions because of ONE bad
   * agent. The offending definition is logged and simply not loaded.
   */
  private dropInvalidCustomAgents(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object') return raw;
    const obj = raw as Record<string, unknown>;
    const agents = obj.agents as Record<string, unknown> | undefined;
    if (!agents || !Array.isArray(agents.custom)) return obj;

    const kept = agents.custom.filter((entry) => {
      const parsed = AgentDefinitionSchema.safeParse(entry);
      if (!parsed.success) {
        const id = (entry as { id?: unknown } | null)?.id;
        this.deps.log.error(
          { id, issues: parsed.error.issues },
          'dropping a stored custom agent that does not match the schema',
        );
      }
      return parsed.success;
    });
    if (kept.length === agents.custom.length) return obj;
    return { ...obj, agents: { ...agents, custom: kept } };
  }

  /**
   * Version-based migrations, applied to the RAW json before AppConfigSchema parses it.
   *
   * v1 -> v2 (v0.1 single backend -> hosts). MUST be lossless:
   *   1. write <configFile>.v1.bak (best effort, once) before returning the new shape, so
   *      an operator can always go back to the v0.1 image;
   *   2. backend.kind === 'portainer' -> credentials.portainer = [{
   *        id: 'portainer-1', name: <hostname of backend.portainer.url>,
   *        url, apiKeyEnc (COPIED verbatim - it is already encrypted with the same key),
   *        insecureTls, createdAt/updatedAt: now }]
   *      and hosts = [{ id: LEGACY_HOST_ID, name: 'Default',
   *        connection: { type:'portainer', credentialId:'portainer-1',
   *                      endpointId: backend.portainer.endpointId ?? 0 } }];
   *   3. backend.kind === 'socket' -> hosts = [{ id: LEGACY_HOST_ID, name: 'Local docker',
   *        connection: { type:'socket', socketPath: backend.socket.socketPath } }];
   *   4. backend.kind === 'none' -> hosts = [] (the first-run state is preserved as such);
   *   5. every created host gets agents:{ enabled: DEFAULT_ENABLED_AGENT_IDS } and
   *      overrides:{}; defaultHostId = the created host id (or null);
   *   6. every stored session gets hostId: LEGACY_HOST_ID and agents: null (the schema
   *      defaults do the same, but writing them makes the file self-describing);
   *   7. general is carried over unchanged - including sharedClaudeVolume /
   *      sharedClaudeHomeVolume, which the one-time claude auth import still needs;
   *   8. backend is DROPPED from the parsed shape (the .v1.bak file keeps it) and
   *      version becomes 2.
   *
   * A file that is already v2 passes through. A file from a NEWER version is used as-is
   * with a warning (same rule as v0.1).
   */
  private migrate(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object') return raw;
    const obj = raw as Record<string, unknown>;
    const version = typeof obj.version === 'number' ? obj.version : 0;
    if (version > CONFIG_VERSION) {
      this.deps.log.warn({ version }, 'config.json was written by a newer version; using it as-is');
      return obj;
    }
    if (version >= CONFIG_VERSION) return obj;

    // ---- v1 (or a pre-versioned file) -> v2 --------------------------------
    this.backupV1(obj);

    const next: Record<string, unknown> = { ...obj };
    delete next.backend;
    next.version = CONFIG_VERSION;

    const now = new Date().toISOString();
    const backend = (obj.backend ?? {}) as Record<string, unknown>;
    const kind = typeof backend.kind === 'string' ? backend.kind : 'none';
    const portainer = (backend.portainer ?? {}) as Record<string, unknown>;
    const socket = (backend.socket ?? {}) as Record<string, unknown>;

    const hosts: Record<string, unknown>[] = [];
    const credentials: Record<string, unknown>[] = [];

    const makeHost = (name: string, connection: Record<string, unknown>): Record<string, unknown> => ({
      id: LEGACY_HOST_ID,
      name,
      connection,
      overrides: {},
      agents: { enabled: [...DEFAULT_ENABLED_AGENT_IDS] },
      notes: null,
      createdAt: now,
      updatedAt: now,
    });

    if (kind === 'portainer') {
      const url = typeof portainer.url === 'string' ? portainer.url : '';
      credentials.push({
        id: 'portainer-1',
        name: hostnameOf(url) || 'portainer',
        url,
        // already encrypted with the same master key: copied verbatim, never re-encrypted
        apiKeyEnc: typeof portainer.apiKeyEnc === 'string' ? portainer.apiKeyEnc : null,
        insecureTls: portainer.insecureTls === true,
        createdAt: now,
        updatedAt: now,
      });
      hosts.push(
        makeHost('Default', {
          type: 'portainer',
          credentialId: 'portainer-1',
          endpointId: typeof portainer.endpointId === 'number' ? portainer.endpointId : 0,
        }),
      );
    } else if (kind === 'socket') {
      const socketPath =
        typeof socket.socketPath === 'string' && socket.socketPath
          ? socket.socketPath
          : '/var/run/docker.sock';
      hosts.push(makeHost('Local docker', { type: 'socket', socketPath }));
    }
    // kind === 'none': no host at all - the first-run state is preserved as such.

    next.hosts = hosts;
    next.defaultHostId = hosts[0]?.id ?? null;
    const existingCredentials = (obj.credentials ?? {}) as Record<string, unknown>;
    next.credentials = { ...existingCredentials, portainer: credentials };

    if (Array.isArray(obj.sessions)) {
      next.sessions = obj.sessions.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const session = entry as Record<string, unknown>;
        return {
          ...session,
          // the schema defaults would do the same; writing them makes the file self-describing
          hostId: typeof session.hostId === 'string' ? session.hostId : LEGACY_HOST_ID,
          agents: Array.isArray(session.agents) ? session.agents : null,
        };
      });
    }

    this.deps.log.info(
      { hosts: hosts.length, credentials: credentials.length, from: version || CONFIG_VERSION_V1 },
      'migrated config.json to version 2',
    );
    return next;
  }

  /** `<configFile>.v1.bak`, written once (best effort) before the first v2 write. */
  private backupV1(obj: Record<string, unknown>): void {
    const target = `${this.deps.paths.configFile}.v1.bak`;
    try {
      fsSync.writeFileSync(target, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      this.deps.log.info({ backup: target }, 'kept a copy of the v1 config before migrating');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        this.deps.log.warn({ err: (err as Error).message }, 'could not write the v1 config backup');
      }
    }
  }

  /**
   * Unattended install seeds, applied ONLY while no host exists yet (hosts.length === 0):
   *   PORTERCLAUDE_BACKEND=socket   -> one socket host (id 'default', name 'Local docker')
   *   PORTERCLAUDE_BACKEND=portainer, or PORTAINER_URL + PORTAINER_API_KEY
   *                                 -> one portainer credential ('portainer-1') plus one
   *                                    host (id 'default') for PORTAINER_ENDPOINT_ID ?? 0
   * The created host becomes defaultHostId and enables DEFAULT_ENABLED_AGENT_IDS. The env
   * is never re-applied once a host exists - the UI is the source of truth then.
   *
   * The variable names are the v0.1 ones so existing deploy/.env files keep working.
   */
  private applyEnvSeeds(draft: AppConfig): void {
    const { env, secrets, log } = this.deps;
    if (draft.hosts.length > 0) return;

    const wantPortainer =
      env.PORTERCLAUDE_BACKEND === 'portainer' || (!!env.PORTAINER_URL && !!env.PORTAINER_API_KEY);
    const wantSocket = env.PORTERCLAUDE_BACKEND === 'socket';
    const now = new Date().toISOString();

    if (wantPortainer) {
      const url = (env.PORTAINER_URL ?? '').replace(/\/+$/, '');
      if (!url || !env.PORTAINER_API_KEY) {
        log.warn(
          'PORTERCLAUDE_BACKEND=portainer needs PORTAINER_URL and PORTAINER_API_KEY; skipping the seed',
        );
        return;
      }
      const credentialId = 'portainer-1';
      draft.credentials.portainer = [
        {
          id: credentialId,
          name: hostnameOf(url) || 'portainer',
          url,
          apiKeyEnc: secrets.encrypt(env.PORTAINER_API_KEY),
          insecureTls: false,
          createdAt: now,
          updatedAt: now,
        },
      ];
      draft.hosts = [
        {
          id: LEGACY_HOST_ID,
          name: 'Default',
          connection: {
            type: 'portainer',
            credentialId,
            endpointId: env.PORTAINER_ENDPOINT_ID ?? 0,
          },
          overrides: {},
          agents: { enabled: [...DEFAULT_ENABLED_AGENT_IDS] },
          notes: null,
          createdAt: now,
          updatedAt: now,
        },
      ];
      draft.defaultHostId = LEGACY_HOST_ID;
      log.info({ hostId: LEGACY_HOST_ID }, 'seeded the first portainer host from the environment');
      return;
    }

    if (wantSocket) {
      draft.hosts = [
        {
          id: LEGACY_HOST_ID,
          name: 'Local docker',
          connection: { type: 'socket', socketPath: env.DOCKER_SOCKET },
          overrides: {},
          agents: { enabled: [...DEFAULT_ENABLED_AGENT_IDS] },
          notes: null,
          createdAt: now,
          updatedAt: now,
        },
      ];
      draft.defaultHostId = LEGACY_HOST_ID;
      log.info({ hostId: LEGACY_HOST_ID }, 'seeded the first socket host from the environment');
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
   * Identity of this install (`porterclaude.instance` on every container/volume it creates).
   * Always a value once `init()` ran; the fallback keeps a store that was never initialised
   * (tests, a caller before init) from labelling containers with `undefined`.
   */
  instanceId(): string {
    return this.get().instanceId ?? UNKNOWN_INSTANCE_ID;
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

  // --- hosts ---------------------------------------------------------------

  listHosts(): HostConfig[] {
    return this.get().hosts.map((h) => structuredClone(h) as HostConfig);
  }

  getHost(id: string): HostConfig | null {
    const found = this.get().hosts.find((h) => h.id === id);
    return found ? (structuredClone(found) as HostConfig) : null;
  }

  /** Insert or replace by id; persists. The first host also becomes the default. */
  async putHost(host: HostConfig): Promise<HostConfig> {
    await this.update((draft) => {
      const idx = draft.hosts.findIndex((h) => h.id === host.id);
      if (idx >= 0) draft.hosts[idx] = host;
      else draft.hosts.push(host);
      if (!draft.defaultHostId) draft.defaultHostId = host.id;
    });
    return this.getHost(host.id) as HostConfig;
  }

  /** Returns true when a host was removed; promotes a new default when needed. */
  async deleteHost(id: string): Promise<boolean> {
    let removed = false;
    await this.update((draft) => {
      const idx = draft.hosts.findIndex((h) => h.id === id);
      if (idx >= 0) {
        draft.hosts.splice(idx, 1);
        removed = true;
      }
      if (draft.defaultHostId === id) draft.defaultHostId = draft.hosts[0]?.id ?? null;
    });
    return removed;
  }

  async setDefaultHostId(id: string | null): Promise<void> {
    await this.update((draft) => {
      draft.defaultHostId = id;
    });
  }

  // --- portainer credentials ------------------------------------------------

  listPortainerCredentials(): PortainerCredentialConfig[] {
    return this.get().credentials.portainer.map((c) => structuredClone(c) as PortainerCredentialConfig);
  }

  getPortainerCredential(id: string): PortainerCredentialConfig | null {
    const found = this.get().credentials.portainer.find((c) => c.id === id);
    return found ? (structuredClone(found) as PortainerCredentialConfig) : null;
  }

  async putPortainerCredential(cred: PortainerCredentialConfig): Promise<PortainerCredentialConfig> {
    await this.update((draft) => {
      const idx = draft.credentials.portainer.findIndex((c) => c.id === cred.id);
      if (idx >= 0) draft.credentials.portainer[idx] = cred;
      else draft.credentials.portainer.push(cred);
    });
    return this.getPortainerCredential(cred.id) as PortainerCredentialConfig;
  }

  async deletePortainerCredential(id: string): Promise<boolean> {
    let removed = false;
    await this.update((draft) => {
      const idx = draft.credentials.portainer.findIndex((c) => c.id === id);
      if (idx >= 0) {
        draft.credentials.portainer.splice(idx, 1);
        removed = true;
      }
    });
    return removed;
  }

  // --- custom agents --------------------------------------------------------

  listCustomAgents(): AgentDefinition[] {
    return this.get().agents.custom.map((a) => structuredClone(a) as AgentDefinition);
  }

  async putCustomAgent(def: AgentDefinition): Promise<AgentDefinition> {
    await this.update((draft) => {
      const idx = draft.agents.custom.findIndex((a) => a.id === def.id);
      if (idx >= 0) draft.agents.custom[idx] = def;
      else draft.agents.custom.push(def);
    });
    return this.listCustomAgents().find((a) => a.id === def.id) as AgentDefinition;
  }

  async deleteCustomAgent(id: string): Promise<boolean> {
    let removed = false;
    await this.update((draft) => {
      const idx = draft.agents.custom.findIndex((a) => a.id === id);
      if (idx >= 0) {
        draft.agents.custom.splice(idx, 1);
        removed = true;
      }
    });
    return removed;
  }

  // --- views ---------------------------------------------------------------

  /**
   * Secret-free projection for GET /api/settings. v0.2: there is no backend section any
   * more - hosts (and their credentials) live at GET /api/hosts and /api/credentials.
   */
  sanitized(extra: { socketAvailable: boolean }): SanitizedSettings {
    const cfg = this.get();
    return {
      general: { ...cfg.general },
      ui: { layout: cfg.ui.layout ?? null, theme: cfg.ui.theme },
      auth: { passwordSet: !!cfg.auth.passwordHash },
      hosts: {
        count: cfg.hosts.length,
        defaultHostId: cfg.defaultHostId,
        socketAvailable: extra.socketAvailable,
        socketHostId: cfg.hosts.find((h) => h.connection.type === 'socket')?.id ?? null,
      },
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

/** Hostname of a url, used for the auto-generated credential name; '' when unparsable. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
