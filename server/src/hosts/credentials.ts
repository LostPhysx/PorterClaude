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
import { AppError } from '../http/errors.js';
import { listPortainerEndpoints, testConnection } from '../backends/index.js';
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

/** `portainer-1`, `portainer-2`, … — first id not taken. */
function nextCredentialId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `portainer-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `portainer-${Date.now().toString(36)}`;
}

export class CredentialStore {
  /** a rotated APP_SECRET must warn once, not once per request */
  private decryptWarned = false;

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
    const cred = this.getPortainer(id);
    if (!cred) throw AppError.notFound(`portainer credential '${id}' does not exist`);
    return cred;
  }

  /**
   * Decrypted api key, or null when unset/undecryptable (a rotated APP_SECRET). Warn ONCE
   * per process, never crash, never log the value — same rule as v0.1's
   * ConfigStore.getPortainerApiKey().
   */
  apiKeyFor(id: string): string | null {
    const cred = this.getPortainer(id);
    if (!cred?.apiKeyEnc) return null;
    try {
      return this.deps.secrets.decrypt(cred.apiKeyEnc);
    } catch {
      if (!this.decryptWarned) {
        this.decryptWarned = true;
        this.deps.log.warn(
          { credentialId: id },
          'a stored portainer api key cannot be decrypted (APP_SECRET changed?); re-enter it in Settings > Credentials',
        );
      }
      return null;
    }
  }

  /** API projection: no key, plus the ids of the hosts using this credential. */
  sanitize(cred: PortainerCredentialConfig): SanitizedPortainerCredential {
    const key = this.apiKeyFor(cred.id);
    return {
      id: cred.id,
      name: cred.name,
      url: cred.url,
      insecureTls: cred.insecureTls,
      apiKeySet: !!key,
      apiKeyHint: key ? key.slice(-4) : null,
      hostIds: this.hostIdsUsing(cred.id),
      createdAt: cred.createdAt,
      updatedAt: cred.updatedAt,
    };
  }

  sanitizedList(): SanitizedPortainerCredential[] {
    return this.listPortainer().map((c) => this.sanitize(c));
  }

  /** ids of every host whose connection references this credential. */
  private hostIdsUsing(id: string): string[] {
    return this.deps.config
      .listHosts()
      .filter((h) => 'credentialId' in h.connection && h.connection.credentialId === id)
      .map((h) => h.id);
  }

  /** `apiKey` is required here (a credential without a key is useless). */
  async create(input: PortainerCredentialInput): Promise<SanitizedPortainerCredential> {
    if (!input.apiKey) throw AppError.validation('an api key is required');
    const now = new Date().toISOString();
    const cred: PortainerCredentialConfig = {
      id: nextCredentialId(this.listPortainer().map((c) => c.id)),
      name: input.name,
      url: input.url.replace(/\/+$/, ''),
      apiKeyEnc: this.deps.secrets.encrypt(input.apiKey),
      insecureTls: input.insecureTls ?? false,
      createdAt: now,
      updatedAt: now,
    };
    const stored = await this.deps.config.putPortainerCredential(cred);
    this.deps.log.info({ credentialId: stored.id, url: stored.url }, 'portainer credential stored');
    return this.sanitize(stored);
  }

  /** Omitting `apiKey` keeps the stored key (api.md: it can never be read back or blanked). */
  async update(id: string, input: Partial<PortainerCredentialInput>): Promise<SanitizedPortainerCredential> {
    const cred = this.requirePortainer(id);
    const next: PortainerCredentialConfig = {
      ...cred,
      name: input.name ?? cred.name,
      url: input.url ? input.url.replace(/\/+$/, '') : cred.url,
      apiKeyEnc: input.apiKey ? this.deps.secrets.encrypt(input.apiKey) : cred.apiKeyEnc,
      insecureTls: input.insecureTls ?? cred.insecureTls,
      updatedAt: new Date().toISOString(),
    };
    const stored = await this.deps.config.putPortainerCredential(next);
    this.deps.log.info(
      { credentialId: id, keyReplaced: !!input.apiKey },
      'portainer credential updated',
    );
    return this.sanitize(stored);
  }

  /** `409 conflict` while a host still references it. */
  async remove(id: string): Promise<void> {
    this.requirePortainer(id);
    const used = this.hostIdsUsing(id);
    if (used.length > 0) {
      throw AppError.conflict(
        `credential '${id}' is still used by ${used.length} host(s): ${used.join(', ')}`,
        { hostIds: used },
      );
    }
    await this.deps.config.deletePortainerCredential(id);
    this.deps.log.info({ credentialId: id }, 'portainer credential removed');
  }

  /**
   * url / apiKey / insecureTls of a probe: the unsaved values of the dialog win, the stored
   * credential fills in the rest. Never returned to a caller, never logged.
   */
  private resolveProbe(
    id: string | null,
    input?: Partial<PortainerCredentialInput>,
  ): { url: string; apiKey: string; insecureTls: boolean } {
    const cred = id ? this.requirePortainer(id) : null;
    const url = (input?.url ?? cred?.url ?? '').replace(/\/+$/, '');
    const apiKey = input?.apiKey ?? (cred ? this.apiKeyFor(cred.id) : null) ?? '';
    const insecureTls = input?.insecureTls ?? cred?.insecureTls ?? false;
    if (!url) throw AppError.badRequest('a portainer url is required');
    if (!apiKey) throw AppError.badRequest('a portainer api key is required');
    return { url, apiKey, insecureTls };
  }

  /**
   * Reachability probe of the CREDENTIAL (not of one endpoint): a credential is good when
   * it can list the endpoints, so that is what decides `ok` — `/info` needs a valid
   * endpoint id, which the dialog does not have yet. `info` is filled in best effort from
   * the first docker endpoint so the UI can show what it is talking to.
   *
   * `input` may carry an unsaved url/key (the dialog's "Test" button); omitted fields fall
   * back to the stored credential. Never throws for connection errors.
   */
  async test(id: string | null, input?: Partial<PortainerCredentialInput>): Promise<BackendTestResult> {
    const probe = this.resolveProbe(id, input);
    try {
      const endpoints = await listPortainerEndpoints(probe);
      const result: BackendTestResult = { ok: true, endpoints };
      const first = endpoints.find((e) => e.type === 1 || e.type === 2);
      if (first) {
        const probed = await testConnection(
          { type: 'portainer', ...probe, endpointId: first.id },
          { log: this.deps.log },
        );
        if (probed.ok && probed.info) result.info = probed.info;
      }
      return result;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      this.deps.log.warn({ credentialId: id }, 'portainer credential test failed');
      return {
        ok: false,
        error: {
          code: typeof e.code === 'string' ? e.code : 'backend_error',
          message: e.message ?? String(err),
        },
      };
    }
  }

  /** Endpoint picker — same fallback rule as `test()`. */
  async listEndpoints(id: string | null, input?: Partial<PortainerCredentialInput>): Promise<PortainerEndpoint[]> {
    const probe = this.resolveProbe(id, input);
    return listPortainerEndpoints(probe);
  }
}
