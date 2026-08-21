// FROZEN (planner-authored, fully implemented). Shape of <DATA_DIR>/config.json and of the
// sanitized objects returned by GET /api/settings. Secrets are stored as opaque
// "enc:v1:..." strings (see config/crypto.ts) and are NEVER included in API responses.
//
// v0.2 (CONFIG_VERSION 2) — what changed against v1:
//   * `backend` (one global docker backend)      -> `hosts[]` + `defaultHostId`
//   * portainer url/key/endpoint inline          -> `credentials.portainer[]` (+ endpointId on the host)
//   * `sessions[].hostId`                        -> new, defaults to 'default' for stored v1 sessions
//   * `sessions[].agents`                        -> new (null = inherit the host's enabled agents)
//   * `agents.custom[]`                          -> new (user-defined AgentDefinitions)
//   * `general.volumePrefix`                     -> new; `sharedClaudeVolume` /
//     `sharedClaudeHomeVolume` are kept but are LEGACY (only the one-time claude auth import
//     reads them, see backend.md v0.2 §12.4).
// The v1 -> v2 migration is lossless and writes `<DATA_DIR>/config.json.v1.bak` first
// (ConfigStore.migrate).
//
// v0.3 (CONFIG_VERSION 3) — the phase R rename (docs/design/users.md §7):
//   * `sessions[]` (the long-lived container)    -> `containers[]`; nothing else moves.
// The v2 -> v3 migration writes `<DATA_DIR>/config.json.v2.bak` first, and a v1 file chains
// v1 -> v2 -> v3 in one pass (ConfigStore.migrate).
//
// v0.4 (CONFIG_VERSION 4) — profiles (issues #2/#3):
//   * `profiles[]`                               -> new (named per-container config sets)
//   * `containers[].profileId`                   -> new (null = no profile, the default)
// The v3 -> v4 migration writes `<DATA_DIR>/config.json.v3.bak` first, is purely additive,
// and a v1/v2 file chains through to v4 in one pass.
import { z } from 'zod';
import { GENERAL_FIELD_SCHEMAS, stored } from './fields.js';
import { ContainerConfigSchema } from '../containers/model.js';
import { HostConfigSchema, HostIdSchema, PortainerCredentialConfigSchema } from '../hosts/model.js';
import { AgentDefinitionSchema } from '../agents/model.js';
import { ProfileConfigSchema } from '../profiles/model.js';

export const CONFIG_VERSION = 4;

/** the version this config was migrated FROM (v1 = the v0.1 single-backend shape) */
export const CONFIG_VERSION_V1 = 1;

/** the version this config was migrated FROM (v2 = the v0.2 shape, `sessions[]` = containers) */
export const CONFIG_VERSION_V2 = 2;

/** the version this config was migrated FROM (v3 = the v0.3 shape, before profiles) */
export const CONFIG_VERSION_V3 = 3;

export const AuthConfigSchema = z.object({
  /** scrypt hash string "scrypt:<N>:<r>:<p>:<saltB64>:<hashB64>"; null until first boot seeds it */
  passwordHash: z.string().nullable().default(null),
  /** bumped on password change to invalidate every issued cookie */
  tokenVersion: z.number().int().nonnegative().default(1),
  updatedAt: z.string().nullable().default(null),
});

// ---------------------------------------------------------------------------
// General settings
//
// Every one of these values ends up in a docker API call (container name, volume name,
// mount target). An unchecked value therefore fails deep inside docker on the NEXT container
// create — a 502 far away from the request that caused it — instead of at the settings
// call, so they are validated where they enter the system (config/fields.ts holds the
// validators; PUT /api/settings/general and HostOverridesSchema reuse them).
//
// Per host they can be overridden (hosts/model.ts HostOverridesSchema); the effective value
// is `HostManager.settingsFor(hostId)`.
// ---------------------------------------------------------------------------

export const GeneralConfigSchema = z.object({
  /** host directory used when a container asks for a bind workspace without an absolute path */
  workspacesRoot: stored(GENERAL_FIELD_SCHEMAS.workspacesRoot, '/srv/porterclaude/workspaces'),
  /** prefix of every volume PorterClaude creates: ws-/hist-/auth-/tools */
  volumePrefix: stored(GENERAL_FIELD_SCHEMAS.volumePrefix, 'porterclaude-'),
  /** LEGACY (v0.1): source of the one-time claude auth import; not mounted any more */
  sharedClaudeVolume: stored(GENERAL_FIELD_SCHEMAS.sharedClaudeVolume, 'porterclaude-claude'),
  sharedClaudeHomeVolume: stored(GENERAL_FIELD_SCHEMAS.sharedClaudeHomeVolume, 'porterclaude-claude-home'),
  toolsVolume: stored(GENERAL_FIELD_SCHEMAS.toolsVolume, 'porterclaude-tools'),
  defaultRecipe: stored(GENERAL_FIELD_SCHEMAS.defaultRecipe, 'node'),
  containerPrefix: stored(GENERAL_FIELD_SCHEMAS.containerPrefix, 'pc-'),
  /**
   * attach every managed container to this docker network (null = default bridge).
   * The KEY keeps its v0.2 name: it is persisted in config.json and renaming it needs its
   * own migration step (out of scope for phase R). Only the UI label says "container".
   */
  sessionNetwork: stored(GENERAL_FIELD_SCHEMAS.sessionNetwork, null),
  imageNamespace: stored(GENERAL_FIELD_SCHEMAS.imageNamespace, 'porterclaude'),
  /** home dir inside managed containers; agent + workspace mounts are derived from it */
  containerHome: stored(GENERAL_FIELD_SCHEMAS.containerHome, '/home/dev'),
  workspaceMount: stored(GENERAL_FIELD_SCHEMAS.workspaceMount, '/workspace'),
  toolsMount: stored(GENERAL_FIELD_SCHEMAS.toolsMount, '/opt/porterclaude'),
});

export const UiConfigSchema = z.object({
  /** opaque GoldenLayout state saved by the web UI */
  layout: z.unknown().nullable().default(null),
  theme: z.enum(['auto', 'light', 'dark']).default('auto'),
});

export const CredentialsConfigSchema = z.object({
  portainer: z.array(PortainerCredentialConfigSchema).default([]),
});

export const AgentsConfigSchema = z.object({
  /** user-defined agents; ids may not collide with a built-in (agents/builtin.ts) */
  custom: z.array(AgentDefinitionSchema).default([]),
});

/** `pc-<12 hex>` — generated once per install, see AppConfigSchema.instanceId. */
export const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const AppConfigSchema = z.object({
  version: z.number().int().default(CONFIG_VERSION),
  /**
   * Stable identity of THIS PorterClaude install (v0.2). Generated once on first boot and
   * never changed; every container and volume this install creates carries it as
   * `porterclaude.instance=<id>`, and container discovery ignores containers that carry a
   * DIFFERENT one (backend.md §13). That is what keeps two installs on one shared engine
   * from listing — and adopting, recreating or destroying — each other's containers.
   * `null` only until ConfigStore.init() fills it in; no migration needed, a config written
   * by v0.1/v0.2.0 simply gets one on the next boot.
   */
  // `.catch(null)`: a hand-edited id that breaks the pattern must regenerate on the next
  // boot, never quarantine config.json (hosts, credentials and containers with it).
  instanceId: z.string().regex(INSTANCE_ID_RE).nullable().catch(null).default(null),
  auth: AuthConfigSchema.default({}),
  /** every managed docker engine; empty on a fresh install */
  hosts: z.array(HostConfigSchema).default([]),
  /** id of the host used when a request omits one; null while there is no host */
  defaultHostId: HostIdSchema.nullable().default(null),
  credentials: CredentialsConfigSchema.default({}),
  agents: AgentsConfigSchema.default({}),
  /** v0.4: named per-container configuration sets (profiles/model.ts); never mutated by migrations */
  profiles: z.array(ProfileConfigSchema).default([]),
  general: GeneralConfigSchema.default({}),
  containers: z.array(ContainerConfigSchema).default([]),
  ui: UiConfigSchema.default({}),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type GeneralConfig = z.infer<typeof GeneralConfigSchema>;
export type UiConfig = z.infer<typeof UiConfigSchema>;
export type CredentialsConfig = z.infer<typeof CredentialsConfigSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export function defaultConfig(): AppConfig {
  return AppConfigSchema.parse({});
}

// ---------------------------------------------------------------------------
// Sanitized views returned by the API (no secrets, ever).
// ---------------------------------------------------------------------------

export interface SanitizedSettings {
  general: GeneralConfig;
  ui: UiConfig;
  auth: { passwordSet: boolean };
  hosts: {
    count: number;
    defaultHostId: string | null;
    /** the local docker socket is reachable from the app container */
    socketAvailable: boolean;
    /** id of the existing socket host, if one is configured (at most one) */
    socketHostId: string | null;
  };
}

// ---------------------------------------------------------------------------
// Request payloads for the settings API.
// ---------------------------------------------------------------------------

/**
 * PUT /api/settings/general. NOT `GeneralConfigSchema.partial()`: the stored shape swallows
 * bad values via `.catch()` (config/fields.ts), which would silently turn
 * `containerPrefix: '../x'` into the default and answer 200. Here every field is validated
 * strictly, so the caller gets a 422 naming the field.
 */
export const GeneralSettingsInputSchema = z.object(GENERAL_FIELD_SCHEMAS).partial();

/** Compile-time guard: a field added to GeneralConfigSchema without a validator in
 *  GENERAL_FIELD_SCHEMAS (i.e. without validation on the way in) fails the build here. */
const _generalInputCoversEveryField: Record<keyof GeneralConfig, unknown> =
  GeneralSettingsInputSchema.shape;
void _generalInputCoversEveryField;

export const UiSettingsInputSchema = UiConfigSchema.partial();

export const PasswordChangeInputSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

export type GeneralSettingsInput = z.infer<typeof GeneralSettingsInputSchema>;
