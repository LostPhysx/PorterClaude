// OWNER: B1. Public API FROZEN — B2 (sessions / terminals / images) only ever calls
// `hosts.requireHostId()`, `hosts.settingsFor(hostId)`, `hosts.backendFor(hostId)`,
// `hosts.require(hostId)` and `hosts.hostForSession(...)`. Everything else is B1 internals.
//
// Replaces v0.1's `BackendManager`: instead of ONE cached DockerBackend it keeps one per
// host, keyed by host id, with the same fingerprint rule (drop an instance only when THAT
// host's connection actually changed — a UI layout autosave must never tear down a
// transport that still carries running builds or execs).
import { createHash } from 'node:crypto';
import type { ConfigStore } from '../config/store.js';
import type { GeneralConfig } from '../config/schema.js';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import { AppError } from '../http/errors.js';
import { createBackend, testConnection } from '../backends/index.js';
import type { BackendTestResult, DockerBackend, DockerInfo } from '../backends/types.js';
import type { ResolvedConnection } from '../backends/index.js';
import { DEFAULT_ENABLED_AGENT_IDS } from '../agents/builtin.js';
import type { CredentialStore } from './credentials.js';
import {
  connectionLabel,
  isImplementedConnection,
  slugifyHostId,
  uniqueHostId,
} from './model.js';
import type {
  HostConfig,
  HostConnection,
  HostInput,
  HostStatus,
  HostUpdateInput,
  HostView,
  PortainerImportInput,
  PortainerImportResult,
} from './model.js';

/**
 * @deprecated v0.1 shape of `ServiceDeps.backends`. Remove the field from context.ts once
 * no B2 service uses it any more.
 */
export interface LegacyBackendAccess {
  get(): DockerBackend;
  tryGet(): DockerBackend | null;
}

export interface HostManagerDeps {
  config: ConfigStore;
  env: Env;
  log: Logger;
  credentials: CredentialStore;
}

/** Cached per-host connectivity probe (drives `HostView.status` without re-hitting docker
 *  on every list call). TTL is short; a failed probe is remembered for the same time. */
export const HOST_PROBE_TTL_MS = 15_000;

/** Hard ceiling for ONE probe, so `GET /api/hosts?probe=1` cannot hang on a dead engine
 *  whose TCP connect never answers. */
export const HOST_PROBE_TIMEOUT_MS = 8_000;

/** Resolve `p`, or reject with a timeout error after `ms`. Never leaves `p` unhandled. */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void p.catch(() => undefined);
  }
}

export class HostManager {
  /** hostId -> live transport */
  private readonly cache = new Map<string, { backend: DockerBackend; fingerprint: string }>();
  /** hostId -> last probe result */
  private readonly probes = new Map<string, { at: number; info: DockerInfo | null; error: string | null }>();
  private readonly closing: Promise<void>[] = [];

  constructor(private readonly deps: HostManagerDeps) {}

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  /** Every configured host, in config order. */
  list(): HostConfig[] {
    return this.deps.config.listHosts();
  }

  get(hostId: string): HostConfig | null {
    return this.deps.config.getHost(hostId);
  }

  /** @throws AppError.notFound */
  require(hostId: string): HostConfig {
    const host = this.get(hostId);
    if (!host) throw hostNotFound(hostId);
    return host;
  }

  defaultHostId(): string | null {
    return this.deps.config.get().defaultHostId;
  }

  /**
   * Resolve an optional host id: `undefined`/`null` => the default host.
   * @throws AppError.notFound when the id is unknown, AppError.backendNotConfigured when
   *         no host exists at all (first-run state — the UI shows "add a host").
   */
  requireHostId(hostId?: string | null): string {
    if (hostId) {
      this.require(hostId);
      return hostId;
    }
    const hosts = this.list();
    if (hosts.length === 0) {
      throw AppError.backendNotConfigured('no docker host configured yet — add one in Settings > Hosts');
    }
    const preferred = this.defaultHostId();
    if (preferred && hosts.some((h) => h.id === preferred)) return preferred;
    return (hosts[0] as HostConfig).id;
  }

  /** The host a stored session belongs to. `AppError.notFound` when it is gone (dangling). */
  hostForSession(session: { name: string; hostId: string }): HostConfig {
    const host = this.get(session.hostId);
    if (!host) {
      throw AppError.notFound(
        `session '${session.name}' points at host '${session.hostId}', which does not exist`,
      );
    }
    return host;
  }

  /**
   * Effective general settings of a host: `{ ...config.general, ...host.overrides }`.
   * THE accessor B2 must use instead of `config.general()`.
   */
  settingsFor(hostId: string): GeneralConfig {
    return this.settingsForHost(this.require(hostId));
  }

  /** Same merge for a host object that is already loaded (avoids a second lookup). */
  settingsForHost(host: HostConfig): GeneralConfig {
    const general = this.deps.config.general();
    const overrides = Object.fromEntries(
      Object.entries(host.overrides ?? {}).filter(([, v]) => v !== undefined),
    );
    return { ...general, ...overrides } as GeneralConfig;
  }

  // -------------------------------------------------------------------------
  // transports
  // -------------------------------------------------------------------------

  /**
   * Live transport of a host, built on demand and cached.
   * @throws AppError.notFound (unknown host), AppError.backendNotConfigured (incomplete
   *         connection: missing credential / api key), AppError.notImplemented (tcp, ssh).
   */
  backendFor(hostId: string): DockerBackend {
    const host = this.require(hostId);
    const fingerprint = this.fingerprint(host);
    const cached = this.cache.get(host.id);
    if (cached && cached.fingerprint === fingerprint) return cached.backend;
    if (cached) this.invalidate(host.id);

    const backend = createBackend(this.resolveConnection(host.connection));
    this.cache.set(host.id, { backend, fingerprint });
    this.deps.log.info({ hostId: host.id, backend: backend.id }, 'docker transport ready');
    return backend;
  }

  /** null instead of throwing (health, host list, settings screen). */
  tryBackendFor(hostId: string): DockerBackend | null {
    try {
      return this.backendFor(hostId);
    } catch {
      return null;
    }
  }

  /** Everything a transport needs, with the credential resolved. Never logged. */
  resolveConnection(conn: HostConnection): ResolvedConnection {
    switch (conn.type) {
      case 'socket':
        return { type: 'socket', socketPath: conn.socketPath || this.deps.env.DOCKER_SOCKET };
      case 'portainer': {
        const cred = this.deps.credentials.getPortainer(conn.credentialId);
        if (!cred) {
          throw AppError.backendNotConfigured(
            `the portainer credential '${conn.credentialId}' this host uses does not exist any more`,
          );
        }
        const apiKey = this.deps.credentials.apiKeyFor(cred.id);
        if (!cred.url || !apiKey) {
          throw AppError.backendNotConfigured(
            `the portainer credential '${cred.id}' has no usable url/api key — re-enter it in Settings > Credentials`,
          );
        }
        return {
          type: 'portainer',
          url: cred.url,
          apiKey,
          endpointId: conn.endpointId,
          insecureTls: cred.insecureTls,
        };
      }
      case 'tcp':
        return { type: 'tcp', url: conn.url, insecureTls: conn.insecureTls };
      case 'ssh':
        return { type: 'ssh', url: conn.url, socketPath: conn.socketPath };
      default: {
        const exhaustive: never = conn;
        throw AppError.badRequest(`unknown connection type ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /**
   * Stable digest of everything `resolveConnection` reads out of the config for this host.
   * The ENCRYPTED credential blob is part of it (never the plaintext, never logged), so
   * rotating a Portainer key rebuilds exactly the hosts that use that credential.
   */
  private fingerprint(host: HostConfig): string {
    const conn = host.connection;
    const parts: unknown[] = [conn.type, JSON.stringify(conn), this.deps.env.DOCKER_SOCKET ?? ''];
    if (conn.type === 'portainer') {
      const cred = this.deps.credentials.getPortainer(conn.credentialId);
      parts.push(cred?.url ?? '', cred?.apiKeyEnc ?? '', cred?.insecureTls ?? false);
    }
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }

  /**
   * @deprecated v0.1 compatibility shim handed to `ServiceDeps.backends`: the DEFAULT
   * host's transport. It only exists so the v0.1 services keep compiling while B2 threads
   * `hostId` through them; every remaining `deps.backends.*` call site is a bug once B2 is
   * done (the integration QA greps for it).
   */
  legacyAccess(): LegacyBackendAccess {
    return {
      get: () => this.backendFor(this.requireHostId()),
      tryGet: () => {
        try {
          return this.tryBackendFor(this.requireHostId());
        } catch {
          return null;
        }
      },
    };
  }

  /** True when at least one host has a usable transport (does not touch the network). */
  isConfigured(): boolean {
    return this.list().some((host) => {
      if (!isImplementedConnection(host.connection)) return false;
      try {
        this.resolveConnection(host.connection);
        return true;
      } catch {
        return false;
      }
    });
  }

  /** Drop the cached transport of one host (or of every host when omitted). */
  invalidate(hostId?: string): void {
    const ids = hostId ? [hostId] : [...this.cache.keys()];
    for (const id of ids) {
      const entry = this.cache.get(id);
      if (!entry) continue;
      this.cache.delete(id);
      this.probes.delete(id);
      this.closing.push(entry.backend.close().catch(() => undefined));
      this.deps.log.debug({ hostId: id, backend: entry.backend.id }, 'docker transport invalidated');
    }
  }

  /**
   * Drop only the transports whose host connection (or referenced credential) actually
   * changed. Wired to `ConfigStore.on('change')` in index.ts — the store emits for every
   * write, and rebuilding a transport that still carries a running build/exec is harmful.
   * Returns the ids that were dropped.
   */
  invalidateChanged(): string[] {
    const dropped: string[] = [];
    for (const [id, entry] of [...this.cache.entries()]) {
      const host = this.get(id);
      if (host && this.fingerprint(host) === entry.fingerprint) continue;
      this.invalidate(id);
      dropped.push(id);
    }
    return dropped;
  }

  // -------------------------------------------------------------------------
  // mutations
  // -------------------------------------------------------------------------

  /**
   * Create a host. `id` is `slugifyHostId(name)` + `uniqueHostId()` when omitted.
   * Rules: at most ONE socket host (409 `conflict` otherwise); a portainer connection must
   * reference an existing credential (404); the first host created becomes the default;
   * `agents` defaults to `DEFAULT_ENABLED_AGENT_IDS`.
   */
  async create(input: HostInput): Promise<HostConfig> {
    const existing = this.list();
    const taken = existing.map((h) => h.id);
    let id: string;
    if (input.id) {
      if (taken.includes(input.id)) throw AppError.conflict(`host '${input.id}' already exists`);
      id = input.id;
    } else {
      id = uniqueHostId(slugifyHostId(input.name), taken);
    }

    this.assertConnectionUsable(input.connection, null);

    const now = new Date().toISOString();
    const host: HostConfig = {
      id,
      name: input.name,
      connection: input.connection,
      overrides: input.overrides ?? {},
      agents: { enabled: dedupe(input.agents ?? DEFAULT_ENABLED_AGENT_IDS) },
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const stored = await this.deps.config.putHost(host);
    if (input.makeDefault) await this.deps.config.setDefaultHostId(stored.id);
    this.invalidateChanged();
    this.deps.log.info({ hostId: stored.id, type: stored.connection.type }, 'host created');
    return stored;
  }

  /** Partial update. `id` is immutable; changing the connection invalidates the transport. */
  async update(hostId: string, input: HostUpdateInput): Promise<HostConfig> {
    const host = this.require(hostId);
    if (input.connection) this.assertConnectionUsable(input.connection, hostId);

    const next: HostConfig = {
      ...host,
      name: input.name ?? host.name,
      connection: input.connection ?? host.connection,
      overrides: input.overrides ?? host.overrides,
      agents: input.agents ? { enabled: dedupe(input.agents) } : host.agents,
      notes: input.notes === undefined ? host.notes : input.notes,
      updatedAt: new Date().toISOString(),
    };
    const stored = await this.deps.config.putHost(next);
    if (input.makeDefault) await this.deps.config.setDefaultHostId(stored.id);
    this.invalidateChanged();
    return stored;
  }

  /**
   * Delete a host. `409 conflict` while sessions still reference it unless `force`, which
   * only drops the host (containers are never touched — a deleted host means "PorterClaude
   * forgets this engine", not "wipe it"). Deleting the default host promotes the first
   * remaining host.
   */
  async remove(hostId: string, opts?: { force?: boolean }): Promise<void> {
    this.require(hostId);
    const sessions = this.deps.config.listSessions().filter((s) => s.hostId === hostId);
    if (sessions.length > 0 && !opts?.force) {
      throw AppError.conflict(
        `host '${hostId}' still has ${sessions.length} session(s): ${sessions.map((s) => s.name).join(', ')} — delete them or repeat with ?force=1`,
        { sessions: sessions.map((s) => s.name) },
      );
    }
    // the engine itself is never touched: only PorterClaude forgets this host
    await this.deps.config.deleteHost(hostId);
    this.invalidate(hostId);
    this.deps.log.info(
      { hostId, force: !!opts?.force, sessions: sessions.length },
      'host removed (containers and volumes on that engine are untouched)',
    );
  }

  async setDefault(hostId: string): Promise<HostConfig> {
    const host = this.require(hostId);
    await this.deps.config.setDefaultHostId(host.id);
    return this.require(host.id);
  }

  /** Replace the host's enabled agent ids (validated against the AgentRegistry by the route). */
  async setEnabledAgents(hostId: string, agentIds: string[]): Promise<HostConfig> {
    const host = this.require(hostId);
    return this.deps.config.putHost({
      ...host,
      agents: { enabled: dedupe(agentIds) },
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Guard shared by create/update: at most one socket host, and a portainer connection has
   * to reference a credential that exists.
   */
  private assertConnectionUsable(conn: HostConnection, selfId: string | null): void {
    if (conn.type === 'socket') {
      const other = this.list().find((h) => h.connection.type === 'socket' && h.id !== selfId);
      if (other) {
        throw AppError.conflict(
          `host '${other.id}' already uses the local docker socket — PorterClaude runs on exactly one machine`,
        );
      }
    }
    if (conn.type === 'portainer') {
      // 404 (not backend_not_configured): the caller sent an id that does not exist
      this.deps.credentials.requirePortainer(conn.credentialId);
    }
  }

  // -------------------------------------------------------------------------
  // probes and views
  // -------------------------------------------------------------------------

  /** `info()` on the host's transport; never throws (see backends/index.ts testConnection). */
  async test(hostId: string): Promise<BackendTestResult> {
    const host = this.require(hostId);
    let conn: ResolvedConnection;
    try {
      conn = this.resolveConnection(host.connection);
    } catch (err) {
      if (err instanceof AppError && err.code === 'backend_not_configured') {
        this.probes.set(hostId, { at: Date.now(), info: null, error: err.message });
        return { ok: false, error: { code: err.code, message: err.message } };
      }
      throw err;
    }
    const result = await testConnection(conn, { log: this.deps.log });
    this.probes.set(hostId, {
      at: Date.now(),
      info: result.info ?? null,
      error: result.ok ? null : (result.error?.message ?? 'connection failed'),
    });
    return result;
  }

  /** Probe a connection that is not saved yet (the "Test connection" button of the dialog). */
  async testConnection(conn: HostConnection, opts?: { apiKey?: string }): Promise<BackendTestResult> {
    let resolved: ResolvedConnection;
    try {
      if (conn.type === 'portainer' && opts?.apiKey) {
        const cred = this.deps.credentials.getPortainer(conn.credentialId);
        resolved = {
          type: 'portainer',
          url: cred?.url ?? '',
          apiKey: opts.apiKey,
          endpointId: conn.endpointId,
          insecureTls: cred?.insecureTls ?? false,
        };
        if (!resolved.url) throw AppError.badRequest('a portainer url is required');
      } else {
        resolved = this.resolveConnection(conn);
      }
    } catch (err) {
      if (err instanceof AppError && (err.code === 'backend_not_configured' || err.code === 'bad_request')) {
        return { ok: false, error: { code: err.code, message: err.message } };
      }
      throw err;
    }
    return testConnection(resolved, { log: this.deps.log });
  }

  /** `DockerInfo` of a host (throws like `backendFor`). */
  async info(hostId: string): Promise<DockerInfo> {
    const info = await this.backendFor(hostId).info();
    this.probes.set(hostId, { at: Date.now(), info, error: null });
    return info;
  }

  /**
   * Reachability of one host, answered from the ≤HOST_PROBE_TTL_MS cache unless `force`.
   * Never throws and never blocks longer than HOST_PROBE_TIMEOUT_MS.
   */
  private async probe(
    host: HostConfig,
    force: boolean,
  ): Promise<{ info: DockerInfo | null; error: string | null } | null> {
    const cached = this.probes.get(host.id);
    if (!force) {
      // never touches the network: a stale entry is still better than blocking the list
      // on a dead engine, and `probe=1` (or GET /api/hosts/:id) refreshes it.
      return cached ? { info: cached.info, error: cached.error } : null;
    }
    if (cached && Date.now() - cached.at < HOST_PROBE_TTL_MS) {
      // a second refresh within the TTL (several panels polling) reuses the last answer
      return { info: cached.info, error: cached.error };
    }

    let result: { info: DockerInfo | null; error: string | null };
    try {
      const backend = this.backendFor(host.id);
      const info = await withTimeout(backend.info(), HOST_PROBE_TIMEOUT_MS, `probe of host '${host.id}'`);
      result = { info, error: null };
    } catch (err) {
      result = { info: null, error: (err as Error).message };
    }
    this.probes.set(host.id, { at: Date.now(), ...result });
    return result;
  }

  /**
   * API projection. `probe:false` (the default) answers from the cached probe
   * (HOST_PROBE_TTL_MS) and never blocks on a dead engine; `probe:true` refreshes it.
   */
  async view(hostId: string, opts?: { probe?: boolean }): Promise<HostView> {
    return this.viewOf(this.require(hostId), opts);
  }

  async views(opts?: { probe?: boolean }): Promise<HostView[]> {
    return Promise.all(this.list().map((host) => this.viewOf(host, opts)));
  }

  private async viewOf(host: HostConfig, opts?: { probe?: boolean }): Promise<HostView> {
    const conn = host.connection;
    const cred =
      conn.type === 'portainer' ? this.deps.credentials.getPortainer(conn.credentialId) : null;
    const supported = isImplementedConnection(conn);

    let status: HostStatus = 'unknown';
    let info: DockerInfo | null = null;
    let error: string | null = null;

    if (!supported) {
      status = 'not_configured';
      error = `connection type '${conn.type}' is reserved for a later release and cannot be used yet`;
    } else {
      try {
        this.resolveConnection(conn);
        const probed = await this.probe(host, opts?.probe === true);
        if (probed) {
          info = probed.info;
          error = probed.error;
          status = probed.error ? 'unreachable' : 'ok';
        }
      } catch (err) {
        status = 'not_configured';
        error = (err as Error).message;
      }
    }

    return {
      id: host.id,
      name: host.name,
      connection: conn,
      connectionLabel: connectionLabel(conn, cred?.url ?? null),
      credentialName: cred?.name ?? null,
      isDefault: this.defaultHostId() === host.id,
      supported,
      status,
      info,
      error,
      settings: { ...this.settingsForHost(host) },
      overrides: host.overrides,
      agents: { enabled: [...host.agents.enabled] },
      sessionCount: this.deps.config.listSessions().filter((s) => s.hostId === host.id).length,
      notes: host.notes,
      createdAt: host.createdAt,
      updatedAt: host.updatedAt,
    };
  }

  // -------------------------------------------------------------------------
  // portainer endpoint import
  // -------------------------------------------------------------------------

  /**
   * One host per Portainer endpoint of a stored credential:
   *   * skip endpoints that are not docker (`type` 1 or 2) with a reason,
   *   * host id = `uniqueHostId(slugifyHostId(endpoint.name), existing ids)`,
   *   * an existing host with the same `credentialId` + `endpointId` is updated when
   *     `update !== false`, never duplicated - but a name the operator edited is KEPT: the
   *     name is only re-templated while the host still carries the endpoint's own name,
   *   * the first import on an empty install also sets the default host.
   */
  async importPortainerEndpoints(
    credentialId: string,
    input?: PortainerImportInput,
  ): Promise<PortainerImportResult> {
    const cred = this.deps.credentials.requirePortainer(credentialId);
    const endpoints = await this.deps.credentials.listEndpoints(cred.id);
    const wanted = input?.endpointIds?.length
      ? endpoints.filter((e) => input.endpointIds?.includes(e.id))
      : endpoints;
    const nameTemplate = input?.nameTemplate ?? '{name}';
    const doUpdate = input?.update !== false;

    const created: string[] = [];
    const updated: string[] = [];
    const skipped: PortainerImportResult['skipped'] = [];
    const now = new Date().toISOString();

    for (const endpoint of wanted) {
      const name = nameTemplate.replace('{name}', endpoint.name || `endpoint-${endpoint.id}`);
      // portainer environment types: 1 = local docker, 2 = agent (docker)
      if (endpoint.type !== 1 && endpoint.type !== 2) {
        skipped.push({ endpointId: endpoint.id, name: endpoint.name, reason: 'not a docker endpoint' });
        continue;
      }

      const existing = this.list().find(
        (h) =>
          h.connection.type === 'portainer' &&
          h.connection.credentialId === cred.id &&
          h.connection.endpointId === endpoint.id,
      );
      if (existing) {
        if (!doUpdate) {
          skipped.push({ endpointId: endpoint.id, name: endpoint.name, reason: 'already imported' });
          continue;
        }
        // Never clobber an operator-chosen name: re-templating is only for hosts that still
        // carry the endpoint's own name (R1-INT2-7a).
        const untouched = existing.name === (endpoint.name || `endpoint-${endpoint.id}`);
        await this.deps.config.putHost({
          ...existing,
          name: untouched ? name : existing.name,
          updatedAt: now,
        });
        updated.push(existing.id);
        continue;
      }

      const id = uniqueHostId(slugifyHostId(name), this.list().map((h) => h.id));
      await this.deps.config.putHost({
        id,
        name,
        connection: { type: 'portainer', credentialId: cred.id, endpointId: endpoint.id },
        overrides: {},
        agents: { enabled: [...DEFAULT_ENABLED_AGENT_IDS] },
        notes: null,
        createdAt: now,
        updatedAt: now,
      });
      created.push(id);
    }

    this.invalidateChanged();
    this.deps.log.info(
      { credentialId: cred.id, created: created.length, updated: updated.length, skipped: skipped.length },
      'imported portainer endpoints as hosts',
    );
    return { created, updated, skipped, hosts: await this.views() };
  }

  /** Close every cached transport (shutdown). */
  async close(): Promise<void> {
    const pending = this.closing.splice(0, this.closing.length);
    const backends = [...this.cache.values()].map((e) => e.backend);
    this.cache.clear();
    this.probes.clear();
    await Promise.all([...pending, ...backends.map((b) => b.close().catch(() => undefined))]);
  }
}

/** ids, de-duplicated, order preserved. */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** The canonical 404 for an unknown host id (same wording everywhere). */
export function hostNotFound(hostId: string): Error {
  return AppError.notFound(`host '${hostId}' does not exist`);
}
