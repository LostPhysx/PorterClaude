// OWNER: B1. Public API FROZEN: B2 (sessions/terminals/images) only ever calls
// `backends.get()` / `backends.tryGet()`. Everything else is B1 internals.
import { createHash } from 'node:crypto';
import type { ConfigStore } from '../config/store.js';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import { AppError } from '../http/errors.js';
import { PortainerBackend } from './portainer.js';
import { SocketBackend } from './socket.js';
import type { BackendKind, BackendTestResult, DockerBackend, PortainerEndpoint } from './types.js';

export * from './types.js';

export interface BackendProbeInput {
  kind: BackendKind;
  portainer?: { url: string; apiKey?: string; endpointId?: number; insecureTls?: boolean };
  socket?: { socketPath?: string };
}

/**
 * Owns the single live DockerBackend instance. Rebuilds it whenever backend settings
 * change (ConfigStore emits 'change'); callers must not cache the returned instance
 * across awaits of unrelated work.
 */
export class BackendManager {
  private cached: DockerBackend | null = null;
  /** fingerprint of the backend settings the cached instance was built from */
  private cachedFingerprint: string | null = null;
  /** backends built for a one-off test(); closed as soon as the probe finishes */
  private closing: Promise<void>[] = [];

  constructor(
    private readonly deps: { config: ConfigStore; env: Env; log: Logger },
  ) {}

  /** Throws AppError.backendNotConfigured() when settings are incomplete/invalid. */
  get(): DockerBackend {
    const backend = this.tryGet();
    if (!backend) throw AppError.backendNotConfigured();
    return backend;
  }

  /** null instead of throwing (used by /api/health and the Settings screen). */
  tryGet(): DockerBackend | null {
    if (this.cached) return this.cached;
    const cfg = this.deps.config.get().backend;

    if (cfg.kind === 'socket') {
      const socketPath = cfg.socket.socketPath || this.deps.env.DOCKER_SOCKET;
      if (!socketPath) return null;
      this.cached = new SocketBackend({ socketPath });
      this.cachedFingerprint = this.fingerprint();
      this.deps.log.info({ backend: this.cached.id }, 'docker backend ready');
      return this.cached;
    }

    if (cfg.kind === 'portainer') {
      const apiKey = this.deps.config.getPortainerApiKey();
      if (!cfg.portainer.url || !apiKey || cfg.portainer.endpointId === null) return null;
      this.cached = new PortainerBackend({
        url: cfg.portainer.url,
        apiKey,
        endpointId: cfg.portainer.endpointId,
        insecureTls: cfg.portainer.insecureTls,
      });
      this.cachedFingerprint = this.fingerprint();
      this.deps.log.info({ backend: this.cached.id }, 'docker backend ready');
      return this.cached;
    }

    return null;
  }

  /**
   * Stable digest of everything tryGet() reads out of the config. The encrypted api key
   * is hashed, never kept verbatim, and the digest is never logged.
   */
  private fingerprint(): string {
    const cfg = this.deps.config.get().backend;
    const h = createHash('sha256');
    h.update(
      JSON.stringify([
        cfg.kind,
        cfg.portainer.url,
        cfg.portainer.endpointId,
        cfg.portainer.insecureTls,
        cfg.portainer.apiKeyEnc ?? '',
        cfg.socket.socketPath,
        this.deps.env.DOCKER_SOCKET ?? '',
      ]),
    );
    return h.digest('hex');
  }

  /** True when a usable backend is configured (does not touch the network). */
  isConfigured(): boolean {
    return this.tryGet() !== null;
  }

  /** Drop the cached instance; next get() rebuilds from config. Call on settings change. */
  invalidate(): void {
    const old = this.cached;
    this.cached = null;
    this.cachedFingerprint = null;
    if (old) {
      this.closing.push(old.close().catch(() => undefined));
      this.deps.log.debug({ backend: old.id }, 'docker backend invalidated');
    }
  }

  /**
   * Invalidate ONLY when the backend section of the config actually changed. The
   * ConfigStore emits 'change' for every write -- UI layout autosave (~every 1.5s),
   * session create/update, password change -- and rebuilding the backend on those is
   * both pointless and disruptive (it tears down the transport used by running
   * builds/pulls/execs). Returns true when the backend was dropped.
   */
  invalidateIfChanged(): boolean {
    if (!this.cached) {
      this.cachedFingerprint = null;
      return false;
    }
    if (this.fingerprint() === this.cachedFingerprint) return false;
    this.invalidate();
    return true;
  }

  /** Build a throw-away backend from an explicit probe input (never cached). */
  private buildProbe(input: BackendProbeInput): DockerBackend {
    if (input.kind === 'socket') {
      const socketPath = input.socket?.socketPath || this.deps.config.get().backend.socket.socketPath || this.deps.env.DOCKER_SOCKET;
      return new SocketBackend({ socketPath });
    }
    const stored = this.deps.config.get().backend.portainer;
    const url = input.portainer?.url ?? stored.url;
    const apiKey = input.portainer?.apiKey ?? this.deps.config.getPortainerApiKey() ?? '';
    const endpointId = input.portainer?.endpointId ?? stored.endpointId ?? 0;
    const insecureTls = input.portainer?.insecureTls ?? stored.insecureTls;
    if (!url) throw AppError.badRequest('a portainer url is required');
    if (!apiKey) throw AppError.badRequest('a portainer api key is required');
    return new PortainerBackend({ url, apiKey, endpointId, insecureTls });
  }

  /**
   * Test a candidate configuration WITHOUT saving it. When `portainer.apiKey` is omitted
   * the currently stored key is used, so the UI can re-test without re-typing it.
   * Never throws for connection problems: returns { ok:false, error }.
   */
  async test(input: BackendProbeInput): Promise<BackendTestResult> {
    let backend: DockerBackend | null = null;
    try {
      backend = this.buildProbe(input);
      const info = await backend.info();
      const result: BackendTestResult = { ok: true, info };
      if (input.kind === 'portainer' && backend instanceof PortainerBackend) {
        try {
          result.endpoints = await backend.listEndpoints();
        } catch (err) {
          this.deps.log.warn({ err: (err as Error).message }, 'portainer endpoint listing failed during test');
          result.endpoints = [];
        }
      }
      return result;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      this.deps.log.warn({ kind: input.kind, err: e.message }, 'backend test failed');
      return {
        ok: false,
        error: { code: typeof e.code === 'string' ? e.code : 'backend_error', message: e.message ?? String(err) },
      };
    } finally {
      await backend?.close().catch(() => undefined);
    }
  }

  /** Portainer endpoint picker. Same api-key fallback rule as test(). */
  async listPortainerEndpoints(input: { url: string; apiKey?: string; insecureTls?: boolean }): Promise<PortainerEndpoint[]> {
    const stored = this.deps.config.get().backend.portainer;
    const url = input.url || stored.url;
    const apiKey = input.apiKey ?? this.deps.config.getPortainerApiKey() ?? '';
    if (!url) throw AppError.badRequest('a portainer url is required');
    if (!apiKey) throw AppError.badRequest('a portainer api key is required');
    const backend = new PortainerBackend({
      url,
      apiKey,
      endpointId: stored.endpointId ?? 0,
      insecureTls: input.insecureTls ?? stored.insecureTls,
    });
    try {
      return await backend.listEndpoints();
    } finally {
      await backend.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const pending = this.closing;
    this.closing = [];
    const current = this.cached;
    this.cached = null;
    this.cachedFingerprint = null;
    await Promise.all([...pending, current ? current.close().catch(() => undefined) : Promise.resolve()]);
  }
}
