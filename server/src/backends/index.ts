// OWNER: B1. Public API FROZEN: B2 (sessions/terminals/images) only ever calls
// `backends.get()` / `backends.tryGet()`. Everything else is B1 internals.
import type { ConfigStore } from '../config/store.js';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
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
  constructor(
    private readonly deps: { config: ConfigStore; env: Env; log: Logger },
  ) {}

  /** Throws AppError.backendNotConfigured() when settings are incomplete/invalid. */
  get(): DockerBackend {
    throw new Error('TODO(B1): implement BackendManager.get');
  }

  /** null instead of throwing (used by /api/health and the Settings screen). */
  tryGet(): DockerBackend | null {
    throw new Error('TODO(B1): implement BackendManager.tryGet');
  }

  /** True when a usable backend is configured (does not touch the network). */
  isConfigured(): boolean {
    throw new Error('TODO(B1)');
  }

  /** Drop the cached instance; next get() rebuilds from config. Call on settings change. */
  invalidate(): void {
    throw new Error('TODO(B1)');
  }

  /**
   * Test a candidate configuration WITHOUT saving it. When `portainer.apiKey` is omitted
   * the currently stored key is used, so the UI can re-test without re-typing it.
   * Never throws for connection problems: returns { ok:false, error }.
   */
  async test(input: BackendProbeInput): Promise<BackendTestResult> {
    throw new Error('TODO(B1)');
  }

  /** Portainer endpoint picker. Same api-key fallback rule as test(). */
  async listPortainerEndpoints(input: { url: string; apiKey?: string; insecureTls?: boolean }): Promise<PortainerEndpoint[]> {
    throw new Error('TODO(B1)');
  }

  async close(): Promise<void> {
    throw new Error('TODO(B1)');
  }
}
