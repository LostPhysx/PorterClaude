// OWNER: v0.4 profiles (issue #2). CRUD over config.profiles[] with the secret handling the
// Portainer CredentialStore established: plaintext secrets arrive via the API, are encrypted
// with SecretBox before they touch config.json, and can never be read back — the sanitized
// projection exposes only `{set, hint}` per key.
//
// The stored (encrypted) form is handed ONLY to the container machinery (containers/service.ts
// resolveProfile, profiles/apply.ts) — never to a route.
import type { ConfigStore } from '../config/store.js';
import type { SecretBox } from '../config/crypto.js';
import type { Logger } from '../logger.js';
import { AppError } from '../http/errors.js';
import { toSlug } from '../util/slug.js';
import {
  ProfileIdSchema,
  RESERVED_PROFILE_IDS,
  validateProfileInput,
  type ProfileAgentConfig,
  type ProfileConfig,
  type ProfileInput,
  type SanitizedProfile,
  type SanitizedProfileAgentConfig,
} from './model.js';

export interface ProfileStoreDeps {
  config: ConfigStore;
  secrets: SecretBox;
  log: Logger;
}

export class ProfileStore {
  /** a rotated APP_SECRET must warn once, not once per request */
  private decryptWarned = false;

  constructor(private readonly deps: ProfileStoreDeps) {}

  // --- reads (sanitized; for the API) ---------------------------------------

  list(): SanitizedProfile[] {
    return this.deps.config.listProfiles().map((p) => this.sanitize(p));
  }

  get(id: string): SanitizedProfile | null {
    const profile = this.deps.config.getProfile(id);
    return profile ? this.sanitize(profile) : null;
  }

  /** @throws AppError.notFound */
  require(id: string): SanitizedProfile {
    const found = this.get(id);
    if (!found) throw AppError.notFound(`profile '${id}' does not exist`);
    return found;
  }

  // --- reads (stored; for the container machinery, never a route) -----------

  /** The stored profile (with enc blobs), or null. No throw — a dangling container profileId
   *  renders a warning instead of breaking every container view. */
  stored(id: string | null): ProfileConfig | null {
    if (!id) return null;
    return this.deps.config.getProfile(id);
  }

  /**
   * Decrypted secret env of one agent slice, `{}` when none. A value that no longer decrypts
   * (rotated APP_SECRET) warns once and is SKIPPED — the container starts without it and the
   * sanitized view keeps `set: true` so the UI shows a stale-but-present key.
   */
  secretEnvFor(agent: ProfileAgentConfig): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, blob] of Object.entries(agent.envSecretsEnc)) {
      try {
        out[key] = this.deps.secrets.decrypt(blob);
      } catch {
        if (!this.decryptWarned) {
          this.decryptWarned = true;
          this.deps.log.warn(
            { key },
            'a stored profile secret cannot be decrypted (APP_SECRET changed?); re-enter it in Settings > Profiles',
          );
        }
      }
    }
    return out;
  }

  // --- writes ----------------------------------------------------------------

  async create(input: ProfileInput): Promise<SanitizedProfile> {
    const errors = validateProfileInput(input);
    if (errors.length > 0) throw AppError.validation(errors.join('; '));
    const id = input.id ?? this.deriveId(input.name);
    // Re-check an EXPLICIT id here, not only in the route's parseBody: a bad id would
    // otherwise reach ConfigStore.update and surface as a raw ZodError (500) instead of a
    // 422 naming the field — and `default` would alias the host-wide login set.
    const parsedId = ProfileIdSchema.safeParse(id);
    if (!parsedId.success) {
      throw AppError.validation(`invalid profile id '${id}'`, parsedId.error.issues);
    }
    if (this.deps.config.getProfile(id)) {
      throw AppError.conflict(`profile id '${id}' is already taken`);
    }
    const now = new Date().toISOString();
    const stored: ProfileConfig = {
      id,
      name: input.name,
      description: input.description,
      agents: this.toStoredAgents(input),
      createdAt: now,
      updatedAt: now,
    };
    const saved = await this.deps.config.putProfile(stored);
    this.deps.log.info({ profileId: id }, 'profile created');
    return this.sanitize(saved);
  }

  /** Full replacement of the public fields; `envSecrets` merges per key
   *  (string = set, null/'' = clear, omitted = keep). `id` in the body must match the path. */
  async update(id: string, input: ProfileInput): Promise<SanitizedProfile> {
    const errors = validateProfileInput(input);
    if (errors.length > 0) throw AppError.validation(errors.join('; '));
    if (input.id && input.id !== id) {
      throw AppError.validation(`profile id is immutable ('${id}' cannot become '${input.id}')`);
    }
    const current = this.deps.config.getProfile(id);
    if (!current) throw AppError.notFound(`profile '${id}' does not exist`);

    const stored: ProfileConfig = {
      ...current,
      name: input.name,
      description: input.description,
      agents: this.mergeAgents(current.agents, input),
      updatedAt: new Date().toISOString(),
    };
    const saved = await this.deps.config.putProfile(stored);
    this.deps.log.info({ profileId: id }, 'profile updated');
    return this.sanitize(saved);
  }

  /**
   * @throws AppError.conflict while containers reference the profile, unless `force` strips
   * their profileId first (those containers then need one recreate — reported by needsRecreate).
   */
  async remove(id: string, opts: { force?: boolean } = {}): Promise<void> {
    if (!this.deps.config.getProfile(id)) {
      throw AppError.notFound(`profile '${id}' does not exist`);
    }
    const inUse = this.containersUsing(id);
    if (inUse.length > 0 && !opts.force) {
      throw AppError.conflict(
        `profile '${id}' is used by containers: ${inUse.join(', ')} (force=true strips the assignment)`,
        { containers: inUse },
      );
    }
    // ONE transaction: stripping the containers and removing the profile in two queued
    // writes could leave containers detached while the profile still exists (or, if a
    // create interleaved between them, a container pointing at a profile that just went
    // away — `assertKnownProfile` would have passed a moment earlier).
    await this.deps.config.update((draft) => {
      for (const c of draft.containers) {
        if (c.profileId === id) c.profileId = null;
      }
      const idx = draft.profiles.findIndex((p) => p.id === id);
      if (idx >= 0) draft.profiles.splice(idx, 1);
    });
    if (inUse.length > 0) {
      this.deps.log.warn({ profileId: id, containers: inUse }, 'force-deleted a profile; containers were stripped');
    }
    this.deps.log.info({ profileId: id }, 'profile deleted');
  }

  // --- helpers ----------------------------------------------------------------

  /** names of containers whose profileId points at this profile */
  containersUsing(id: string): string[] {
    return this.deps.config
      .listContainers()
      .filter((c) => c.profileId === id)
      .map((c) => c.name);
  }

  /** `toSlug(name)`, suffixed `-2`, `-3`, … while taken (or reserved). */
  private deriveId(name: string): string {
    const taken = new Set(this.deps.config.listProfiles().map((p) => p.id));
    // `default` names the host-wide login set; a derived id must never land on it
    const unavailable = (id: string): boolean =>
      taken.has(id) || (RESERVED_PROFILE_IDS as readonly string[]).includes(id);

    let base: string;
    try {
      base = toSlug(name);
    } catch {
      // toSlug throws a plain Error for a name with nothing slug-able ("???", "日本語"):
      // that is a bad REQUEST, not a server fault
      throw AppError.validation(
        `cannot derive a profile id from the name ${JSON.stringify(name)}; pass an explicit id`,
        [{ path: ['id'], message: 'required when the name has no letters or digits' }],
      );
    }
    if (!unavailable(base)) return base;
    for (let i = 2; i < 1000; i += 1) {
      const suffix = `-${i}`;
      // trim the BASE, never the counter: `${base}-${i}`.slice(0, 32) would cut the digits
      // off a 31-char base and keep answering the same trailing-dash id
      const candidate = `${base.slice(0, 32 - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!unavailable(candidate)) return candidate;
    }
    throw AppError.conflict('cannot derive a free profile id; choose one explicitly');
  }

  /** Input agents -> stored agents: encrypt typed secrets, drop the plaintext field. */
  private toStoredAgents(input: ProfileInput): ProfileConfig['agents'] {
    const out: ProfileConfig['agents'] = {};
    for (const [agentId, cfg] of Object.entries(input.agents)) {
      const envSecretsEnc: Record<string, string> = {};
      for (const [key, value] of Object.entries(cfg.envSecrets)) {
        if (typeof value === 'string' && value.length > 0) envSecretsEnc[key] = this.deps.secrets.encrypt(value);
      }
      out[agentId] = {
        loginSet: cfg.loginSet,
        env: cfg.env,
        envSecretsEnc,
        settings: cfg.settings,
        marketplaces: cfg.marketplaces,
        plugins: cfg.plugins,
      };
    }
    return out;
  }

  /** Current agents + input public fields + per-key secret merge: an omitted key keeps the
   *  stored blob, null/'' clears it, a typed string replaces it (already encrypted by
   *  toStoredAgents — it must win over the previous blob, never the other way round). */
  private mergeAgents(current: ProfileConfig['agents'], input: ProfileInput): ProfileConfig['agents'] {
    const replaced = this.toStoredAgents(input);
    const out: ProfileConfig['agents'] = {};
    for (const [agentId, cfg] of Object.entries(replaced)) {
      const prev = current[agentId];
      const envSecretsEnc: Record<string, string> = { ...(prev?.envSecretsEnc ?? {}), ...cfg.envSecretsEnc };
      const typed = input.agents[agentId]?.envSecrets ?? {};
      for (const [key, value] of Object.entries(typed)) {
        if (value === null || value === '') delete envSecretsEnc[key];
      }
      out[agentId] = { ...cfg, envSecretsEnc };
    }
    return out;
  }

  /** API projection: no secret value, no enc blob, ever. */
  private sanitize(profile: ProfileConfig): SanitizedProfile {
    const agents: Record<string, SanitizedProfileAgentConfig> = {};
    for (const [agentId, cfg] of Object.entries(profile.agents)) {
      const envSecrets: Record<string, { set: boolean; hint: string }> = {};
      const decrypted = this.secretEnvFor(cfg);
      for (const key of Object.keys(cfg.envSecretsEnc)) {
        const value = decrypted[key];
        // `set` reflects that a value IS STORED, not that it still decrypts. Reporting
        // set:false for a blob a rotated APP_SECRET made unreadable would show the field as
        // empty, the user would leave it empty, and an omitted key means KEEP on update —
        // so the dead blob would survive forever while the container starts without the key.
        // An empty hint is the signal that it needs re-entering.
        envSecrets[key] = { set: true, hint: value ? value.slice(-4) : '' };
      }
      agents[agentId] = {
        loginSet: cfg.loginSet,
        env: cfg.env,
        envSecrets,
        settings: cfg.settings,
        marketplaces: cfg.marketplaces,
        plugins: cfg.plugins,
      };
    }
    return {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      agents,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      inUse: this.containersUsing(profile.id),
    };
  }
}
