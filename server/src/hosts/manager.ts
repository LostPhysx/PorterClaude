// OWNER: B1. Public API FROZEN — B2 (sessions / terminals / images) only ever calls
// `hosts.requireHostId()`, `hosts.settingsFor(hostId)`, `hosts.backendFor(hostId)`,
// `hosts.require(hostId)` and `hosts.hostForSession(...)`. Everything else is B1 internals.
//
// Replaces v0.1's `BackendManager`: instead of ONE cached DockerBackend it keeps one per
// host, keyed by host id, with the same fingerprint rule (drop an instance only when THAT
// host's connection actually changed — a UI layout autosave must never tear down a
// transport that still carries running builds or execs).
import type { ConfigStore } from '../config/store.js';
import type { GeneralConfig } from '../config/schema.js';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import type { BackendTestResult, DockerBackend, DockerInfo } from '../backends/types.js';
import type { ResolvedConnection } from '../backends/index.js';
import type { CredentialStore } from './credentials.js';
import type {
  HostConfig,
  HostConnection,
  HostInput,
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
    void hostId;
    throw new Error('TODO(B1): requireHostId');
  }

  /** The host a stored session belongs to. `AppError.notFound` when it is gone (dangling). */
  hostForSession(session: { name: string; hostId: string }): HostConfig {
    void session;
    throw new Error('TODO(B1): hostForSession');
  }

  /**
   * Effective general settings of a host: `{ ...config.general, ...host.overrides }`.
   * THE accessor B2 must use instead of `config.general()`.
   */
  settingsFor(hostId: string): GeneralConfig {
    void hostId;
    throw new Error('TODO(B1): settingsFor');
  }

  /** Same merge for a host object that is already loaded (avoids a second lookup). */
  settingsForHost(host: HostConfig): GeneralConfig {
    void host;
    throw new Error('TODO(B1): settingsForHost');
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
    void hostId;
    throw new Error('TODO(B1): backendFor');
  }

  /** null instead of throwing (health, host list, settings screen). */
  tryBackendFor(hostId: string): DockerBackend | null {
    void hostId;
    throw new Error('TODO(B1): tryBackendFor');
  }

  /** Everything a transport needs, with the credential resolved. Never logged. */
  resolveConnection(conn: HostConnection): ResolvedConnection {
    void conn;
    throw new Error('TODO(B1): resolveConnection');
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
    throw new Error('TODO(B1): isConfigured');
  }

  /** Drop the cached transport of one host (or of every host when omitted). */
  invalidate(hostId?: string): void {
    void hostId;
    throw new Error('TODO(B1): invalidate');
  }

  /**
   * Drop only the transports whose host connection (or referenced credential) actually
   * changed. Wired to `ConfigStore.on('change')` in index.ts — the store emits for every
   * write, and rebuilding a transport that still carries a running build/exec is harmful.
   * Returns the ids that were dropped.
   */
  invalidateChanged(): string[] {
    throw new Error('TODO(B1): invalidateChanged');
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
    void input;
    throw new Error('TODO(B1): create');
  }

  /** Partial update. `id` is immutable; changing the connection invalidates the transport. */
  async update(hostId: string, input: HostUpdateInput): Promise<HostConfig> {
    void hostId;
    void input;
    throw new Error('TODO(B1): update');
  }

  /**
   * Delete a host. `409 conflict` while sessions still reference it unless `force`, which
   * only drops the host (containers are never touched — a deleted host means "PorterClaude
   * forgets this engine", not "wipe it"). Deleting the default host promotes the first
   * remaining host.
   */
  async remove(hostId: string, opts?: { force?: boolean }): Promise<void> {
    void hostId;
    void opts;
    throw new Error('TODO(B1): remove');
  }

  async setDefault(hostId: string): Promise<HostConfig> {
    void hostId;
    throw new Error('TODO(B1): setDefault');
  }

  /** Replace the host's enabled agent ids (validated against the AgentRegistry by the route). */
  async setEnabledAgents(hostId: string, agentIds: string[]): Promise<HostConfig> {
    void hostId;
    void agentIds;
    throw new Error('TODO(B1): setEnabledAgents');
  }

  // -------------------------------------------------------------------------
  // probes and views
  // -------------------------------------------------------------------------

  /** `info()` on the host's transport; never throws (see backends/index.ts testConnection). */
  async test(hostId: string): Promise<BackendTestResult> {
    void hostId;
    throw new Error('TODO(B1): test');
  }

  /** Probe a connection that is not saved yet (the "Test connection" button of the dialog). */
  async testConnection(conn: HostConnection, opts?: { apiKey?: string }): Promise<BackendTestResult> {
    void conn;
    void opts;
    throw new Error('TODO(B1): testConnection');
  }

  /** `DockerInfo` of a host (throws like `backendFor`). */
  async info(hostId: string): Promise<DockerInfo> {
    void hostId;
    throw new Error('TODO(B1): info');
  }

  /**
   * API projection. `probe:false` (the default) answers from the cached probe
   * (HOST_PROBE_TTL_MS) and never blocks on a dead engine; `probe:true` refreshes it.
   */
  async view(hostId: string, opts?: { probe?: boolean }): Promise<HostView> {
    void hostId;
    void opts;
    throw new Error('TODO(B1): view');
  }

  async views(opts?: { probe?: boolean }): Promise<HostView[]> {
    void opts;
    throw new Error('TODO(B1): views');
  }

  // -------------------------------------------------------------------------
  // portainer endpoint import
  // -------------------------------------------------------------------------

  /**
   * One host per Portainer endpoint of a stored credential:
   *   * skip endpoints that are not docker (`type` 1 or 2) with a reason,
   *   * host id = `uniqueHostId(slugifyHostId(endpoint.name), existing ids)`,
   *   * an existing host with the same `credentialId` + `endpointId` is updated (name) when
   *     `update !== false`, never duplicated,
   *   * the first import on an empty install also sets the default host.
   */
  async importPortainerEndpoints(
    credentialId: string,
    input?: PortainerImportInput,
  ): Promise<PortainerImportResult> {
    void credentialId;
    void input;
    throw new Error('TODO(B1): importPortainerEndpoints');
  }

  /** Close every cached transport (shutdown). */
  async close(): Promise<void> {
    throw new Error('TODO(B1): close');
  }
}

/** The canonical 404 for an unknown host id (same wording everywhere). */
export function hostNotFound(hostId: string): Error {
  // TODO(B1): return AppError.notFound(`host '${hostId}' does not exist`)
  return new Error(`host '${hostId}' does not exist`);
}
