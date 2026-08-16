// OWNER: B1. Portainer credentials: one stored URL + api key that any number of hosts
// (one per endpoint) reference. Public API FROZEN — HostManager and the credentials router
// are the only callers.
//
// SECRETS: `apiKeyEnc` is an "enc:v1:…" blob (config/crypto.ts). `apiKeyFor()` is the ONLY
// place it is decrypted; nothing here (and nothing in the routes) ever logs the plaintext,
// and the sanitized projection exposes `apiKeySet` + the last 4 characters only.
import type { ConfigStore } from '../config/store.js';
import type { SecretBox } from '../config/crypto.js';
import type { Logger } from '../logger.js';
import type { BackendTestResult, PortainerEndpoint } from '../backends/types.js';
import type {
  PortainerCredentialConfig,
  PortainerCredentialInput,
  SanitizedPortainerCredential,
} from './model.js';

export interface CredentialStoreDeps {
  config: ConfigStore;
  secrets: SecretBox;
  log: Logger;
}

export class CredentialStore {
  constructor(private readonly deps: CredentialStoreDeps) {}

  /** Stored credentials (with the encrypted blob) — never handed to a route. */
  listPortainer(): PortainerCredentialConfig[] {
    return this.deps.config.listPortainerCredentials();
  }

  getPortainer(id: string): PortainerCredentialConfig | null {
    return this.deps.config.getPortainerCredential(id);
  }

  /** @throws AppError.notFound */
  requirePortainer(id: string): PortainerCredentialConfig {
    void id;
    throw new Error('TODO(B1): requirePortainer');
  }

  /**
   * Decrypted api key, or null when unset/undecryptable (a rotated APP_SECRET). Warn ONCE
   * per process, never crash, never log the value — same rule as v0.1's
   * ConfigStore.getPortainerApiKey().
   */
  apiKeyFor(id: string): string | null {
    void id;
    throw new Error('TODO(B1): apiKeyFor');
  }

  /** API projection: no key, plus the ids of the hosts using this credential. */
  sanitize(cred: PortainerCredentialConfig): SanitizedPortainerCredential {
    void cred;
    throw new Error('TODO(B1): sanitize');
  }

  sanitizedList(): SanitizedPortainerCredential[] {
    return this.listPortainer().map((c) => this.sanitize(c));
  }

  /** `apiKey` is required here (a credential without a key is useless). */
  async create(input: PortainerCredentialInput): Promise<SanitizedPortainerCredential> {
    void input;
    throw new Error('TODO(B1): create');
  }

  /** Omitting `apiKey` keeps the stored key (api.md: it can never be read back or blanked). */
  async update(id: string, input: Partial<PortainerCredentialInput>): Promise<SanitizedPortainerCredential> {
    void id;
    void input;
    throw new Error('TODO(B1): update');
  }

  /** `409 conflict` while a host still references it. */
  async remove(id: string): Promise<void> {
    void id;
    throw new Error('TODO(B1): remove');
  }

  /**
   * Reachability probe. `input` may carry an unsaved url/key (the dialog's "Test" button);
   * omitted fields fall back to the stored credential. Never throws for connection errors.
   */
  async test(id: string | null, input?: Partial<PortainerCredentialInput>): Promise<BackendTestResult> {
    void id;
    void input;
    throw new Error('TODO(B1): test');
  }

  /** Endpoint picker — same fallback rule as `test()`. */
  async listEndpoints(id: string | null, input?: Partial<PortainerCredentialInput>): Promise<PortainerEndpoint[]> {
    void id;
    void input;
    throw new Error('TODO(B1): listEndpoints');
  }
}
