// v0.4 (issues #2/#3): PROFILES — named per-container configuration sets.
//
// A profile picks, per agent, which LOGIN SET (docs/design/users.md §0) the container
// mounts — the shared auth volume that carries login, history and plugin FILES — and
// optionally overlays provider credentials (API key + endpoint + model slugs for
// non-Anthropic providers; Anthropic usage stays interactive /login) and a settings
// object. Plugins are installed into the login set's volume and ENABLED per profile.
//
// Import direction: this file may import agents/model.ts (ids, env keys) but nothing that
// imports it back except config/schema.ts, containers/model.ts and profiles/* — the pure
// volume-naming rules live in agents/model.ts next to `agentAuthVolumeFor`.
import { z } from 'zod';
import { AgentIdSchema, AgentEnvKeySchema } from '../agents/model.js';

/** profile ids are slugs, same charset as agent ids (and login set names — no `_`, see agents/model.ts) */
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Profile ids that would alias a login set with a different meaning.
 *
 * A profile without an explicit `loginSet` uses an implicit set NAMED AFTER ITS ID, and the
 * set `default` is the host-wide v0.2 volume every unprofiled container mounts. A profile
 * with the id `default` would therefore silently adopt — and, via
 * `DELETE ?removeVolumes=1`, destroy — every unprofiled container's login, history and
 * plugins. There is no legitimate use for the name, so it is refused where it enters.
 */
export const RESERVED_PROFILE_IDS = ['default'] as const;

export const ProfileIdSchema = z
  .string()
  .regex(PROFILE_ID_RE, 'profile id must be lowercase letters, digits and dashes (max 32 chars)')
  .refine((id) => !(RESERVED_PROFILE_IDS as readonly string[]).includes(id), {
    message: `'${RESERVED_PROFILE_IDS.join("', '")}' is a reserved login set name and cannot be a profile id`,
  });

/** login set names share the profile id charset; `_` is illegal so volume names stay parsable */
export const LOGIN_SET_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const LoginSetSchema = z
  .string()
  .regex(LOGIN_SET_RE, 'login set name must be lowercase letters, digits and dashes (max 32 chars)');

/** a plugin ref as the claude CLI takes it: `name` or `name@marketplace` */
export const PROFILE_PLUGIN_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$/;

export const ProfilePluginSchema = z.object({
  ref: z.string().regex(
    PROFILE_PLUGIN_REF_RE,
    'plugin ref must be `name` or `name@marketplace` (letters, digits, `.`, `_`, `-`, `/`, `@`)',
  ),
});

/** a marketplace a plugin ref may resolve against (claude: `extraKnownMarketplaces`) */
export const ProfileMarketplaceSchema = z.object({
  /** the name used in plugin refs (`name@<marketplace>`) */
  name: z.string().min(1).max(64),
  /** github shorthand (`owner/repo`) or git URL — passed verbatim */
  source: z.string().min(1).max(256),
});

/**
 * Per-agent slice of a profile. Only `claude` is consumed today; the shape is agent-neutral
 * so other agents join without a config version bump.
 */
export const ProfileAgentConfigSchema = z.object({
  /**
   * login set whose auth volume containers of this profile mount (agents/model.ts
   * `agentLoginVolumeFor`): 'default' = the host-wide shared login (the v0.2 volume), a name
   * = a set shared by every profile referencing it, null = an implicit set NAMED AFTER THE
   * PROFILE ID.
   *
   * "named after the profile id", not "private": login set names are ONE flat namespace, so
   * another profile that explicitly sets `loginSet: '<this profile id&gt;'` deliberately joins
   * this set. That is the sharing mechanism working as intended, not a leak — but it is why
   * the id `default` is reserved (RESERVED_PROFILE_IDS): it would silently join the
   * host-wide set that every unprofiled container mounts.
   */
  loginSet: LoginSetSchema.nullable().default(null),
  /** plain env merged into the agent's managed-settings env block (ANTHROPIC_BASE_URL, model vars) */
  env: z.record(AgentEnvKeySchema, z.string()).default({}),
  /** secret env; values are `enc:v1:…` blobs (config/crypto.ts), NEVER returned by the API */
  envSecretsEnc: z.record(AgentEnvKeySchema, z.string()).default({}),
  /** free-form settings.json overlay (model slugs, permissions, …), merged verbatim */
  settings: z.record(z.string(), z.unknown()).default({}),
  marketplaces: z.array(ProfileMarketplaceSchema).max(32).default([]),
  plugins: z.array(ProfilePluginSchema).max(64).default([]),
});

export const ProfileConfigSchema = z.object({
  id: ProfileIdSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(400).nullable().default(null),
  /** keyed by agent id; an id with no entry = the profile does not touch that agent */
  agents: z.record(AgentIdSchema, ProfileAgentConfigSchema).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProfilePlugin = z.infer<typeof ProfilePluginSchema>;
export type ProfileMarketplace = z.infer<typeof ProfileMarketplaceSchema>;
export type ProfileAgentConfig = z.infer<typeof ProfileAgentConfigSchema>;
export type ProfileConfig = z.infer<typeof ProfileConfigSchema>;

/**
 * Keys of the managed-settings.json the SERVER composes (profiles/apply.ts); a profile's
 * `settings` overlay may not set them — the overlay would be silently overwritten.
 */
const SERVER_OWNED_SETTINGS_KEYS = ['env', 'enabledPlugins', 'extraKnownMarketplaces'] as const;

/** POST/PUT /api/profiles body. Stricter than the stored shape: secrets arrive in PLAINTEXT
 *  (`envSecrets`) and are encrypted server-side; a stored-blob pasted back is refused. */
export const ProfileInputSchema = z.object({
  id: ProfileIdSchema.optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(400).nullable().default(null),
  agents: z
    .record(
      AgentIdSchema,
      ProfileAgentConfigSchema.omit({ envSecretsEnc: true }).extend({
        /**
         * write-only secret env: a string SETS the value, null/'' CLEARS it, an omitted key
         * KEEPS the stored one (the Portainer-credential convention).
         */
        envSecrets: z.record(AgentEnvKeySchema, z.string().nullable()).default({}),
      }),
    )
    .default({}),
});

export type ProfileInput = z.infer<typeof ProfileInputSchema>;

/** Refuse server-owned settings keys and pasted-back ciphertext at the API boundary. */
export function validateProfileInput(input: ProfileInput): string[] {
  const errors: string[] = [];
  for (const [agentId, cfg] of Object.entries(input.agents)) {
    for (const key of SERVER_OWNED_SETTINGS_KEYS) {
      if (key in cfg.settings) {
        errors.push(`agents.${agentId}.settings.${key} is set by the server and cannot be overridden`);
      }
    }
    for (const [k, v] of Object.entries(cfg.envSecrets)) {
      if (typeof v === 'string' && v.startsWith('enc:v1:')) {
        errors.push(`agents.${agentId}.envSecrets.${k} looks like a stored encrypted blob; paste the plaintext value`);
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Sanitized view (GET /api/profiles) — no secret value, no enc blob, ever.
// ---------------------------------------------------------------------------

export interface SanitizedSecretEnv {
  /** true when a stored encrypted value exists */
  set: boolean;
  /** last 4 chars of the decrypted value (the portainer apiKeyHint convention) */
  hint: string;
}

export interface SanitizedProfileAgentConfig {
  loginSet: string | null;
  env: Record<string, string>;
  envSecrets: Record<string, SanitizedSecretEnv>;
  settings: Record<string, unknown>;
  marketplaces: ProfileMarketplace[];
  plugins: ProfilePlugin[];
}

export interface SanitizedProfile {
  id: string;
  name: string;
  description: string | null;
  agents: Record<string, SanitizedProfileAgentConfig>;
  createdAt: string;
  updatedAt: string;
  /** names of the containers currently assigned to this profile */
  inUse: string[];
}
