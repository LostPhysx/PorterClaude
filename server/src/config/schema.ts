// FROZEN (planner-authored, fully implemented). Shape of <DATA_DIR>/config.json and of the
// sanitized objects returned by GET /api/settings. Secrets are stored as opaque
// "enc:v1:..." strings (see config/crypto.ts) and are NEVER included in API responses.
import { z } from 'zod';
import { SessionConfigSchema } from '../sessions/model.js';

export const CONFIG_VERSION = 1;

export const AuthConfigSchema = z.object({
  /** scrypt hash string "scrypt:<N>:<r>:<p>:<saltB64>:<hashB64>"; null until first boot seeds it */
  passwordHash: z.string().nullable().default(null),
  /** bumped on password change to invalidate every issued cookie */
  tokenVersion: z.number().int().nonnegative().default(1),
  updatedAt: z.string().nullable().default(null),
});

export const PortainerConfigSchema = z.object({
  url: z.string().default(''),
  /** encrypted blob, never returned by the API */
  apiKeyEnc: z.string().nullable().default(null),
  endpointId: z.number().int().nullable().default(null),
  insecureTls: z.boolean().default(false),
});

export const SocketConfigSchema = z.object({
  socketPath: z.string().default('/var/run/docker.sock'),
});

export const BackendConfigSchema = z.object({
  kind: z.enum(['portainer', 'socket', 'none']).default('none'),
  portainer: PortainerConfigSchema.default({}),
  socket: SocketConfigSchema.default({}),
});

// ---------------------------------------------------------------------------
// Field validators for the path-like general settings.
//
// Every one of these values ends up in a docker API call (container name, volume name,
// mount target). An unchecked value therefore fails deep inside docker on the NEXT session
// create — a 502 far away from the request that caused it — instead of at the settings
// call, so they are validated where they enter the system (PUT /api/settings/general uses
// the very same schemas, see GeneralSettingsInputSchema).
// ---------------------------------------------------------------------------

/** docker object names (volumes, networks): [a-zA-Z0-9][a-zA-Z0-9_.-]* */
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
/** container-name-safe prefixes and image namespaces (lowercase, docker repo syntax) */
const LOWER_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** absolute POSIX path with at least one segment, no `.`/`..` segment, no backslash/NUL */
const ABS_POSIX_PATH_RE = /^(?:\/(?!\.\.?(?:\/|$))[^/\0\\]+)+\/?$/;

const dockerName = (label: string) =>
  z.string().min(1).max(128).regex(DOCKER_NAME_RE, `${label} must match [a-zA-Z0-9][a-zA-Z0-9_.-]*`);

const lowerName = (label: string) =>
  z.string().min(1).max(64).regex(LOWER_NAME_RE, `${label} must match [a-z0-9][a-z0-9._-]*`);

const absPosixPath = (label: string) =>
  z
    .string()
    .min(1)
    .max(512)
    .regex(ABS_POSIX_PATH_RE, `${label} must be an absolute POSIX path (no '.'/'..' segments)`);

/**
 * `.catch(<default>)` on the STORED shape only: a hand-edited config.json with a bad value
 * falls back to the default instead of failing AppConfigSchema, which would quarantine the
 * whole file (and with it every stored session). The API input schema below has no catch,
 * so a bad value sent to PUT /api/settings/general is a 422.
 */
const stored = <T extends z.ZodTypeAny, D extends z.infer<T>>(schema: T, fallback: D) =>
  schema.default(fallback).catch(fallback);

export const GeneralConfigSchema = z.object({
  /** host directory used when a session asks for a bind workspace without an absolute path */
  workspacesRoot: stored(absPosixPath('workspacesRoot'), '/srv/porterclaude/workspaces'),
  sharedClaudeVolume: stored(dockerName('sharedClaudeVolume'), 'porterclaude-claude'),
  sharedClaudeHomeVolume: stored(dockerName('sharedClaudeHomeVolume'), 'porterclaude-claude-home'),
  toolsVolume: stored(dockerName('toolsVolume'), 'porterclaude-tools'),
  defaultRecipe: stored(lowerName('defaultRecipe'), 'node'),
  containerPrefix: stored(lowerName('containerPrefix'), 'pc-'),
  /** attach every session container to this docker network (null = default bridge) */
  sessionNetwork: stored(dockerName('sessionNetwork').nullable(), null),
  imageNamespace: stored(lowerName('imageNamespace'), 'porterclaude'),
  /** home dir inside recipe images; mounts are derived from it */
  containerHome: stored(absPosixPath('containerHome'), '/home/dev'),
  workspaceMount: stored(absPosixPath('workspaceMount'), '/workspace'),
  toolsMount: stored(absPosixPath('toolsMount'), '/opt/porterclaude'),
});

export const UiConfigSchema = z.object({
  /** opaque GoldenLayout state saved by the web UI */
  layout: z.unknown().nullable().default(null),
  theme: z.enum(['auto', 'light', 'dark']).default('auto'),
});

export const AppConfigSchema = z.object({
  version: z.number().int().default(CONFIG_VERSION),
  auth: AuthConfigSchema.default({}),
  backend: BackendConfigSchema.default({}),
  general: GeneralConfigSchema.default({}),
  sessions: z.array(SessionConfigSchema).default([]),
  ui: UiConfigSchema.default({}),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type PortainerConfig = z.infer<typeof PortainerConfigSchema>;
export type SocketConfig = z.infer<typeof SocketConfigSchema>;
export type BackendConfig = z.infer<typeof BackendConfigSchema>;
export type GeneralConfig = z.infer<typeof GeneralConfigSchema>;
export type UiConfig = z.infer<typeof UiConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export function defaultConfig(): AppConfig {
  return AppConfigSchema.parse({});
}

// ---------------------------------------------------------------------------
// Sanitized views returned by the API (no secrets, ever).
// ---------------------------------------------------------------------------

export interface SanitizedPortainer {
  url: string;
  endpointId: number | null;
  insecureTls: boolean;
  apiKeySet: boolean;
  /** last 4 chars of the stored key, or null */
  apiKeyHint: string | null;
}

export interface SanitizedSettings {
  backend: {
    kind: 'portainer' | 'socket' | 'none';
    portainer: SanitizedPortainer;
    socket: SocketConfig;
    /** the local docker socket exists and is reachable (auto-detection hint for the UI) */
    socketAvailable: boolean;
  };
  general: GeneralConfig;
  ui: UiConfig;
  auth: { passwordSet: boolean };
}

// ---------------------------------------------------------------------------
// Request payloads for the settings API.
// ---------------------------------------------------------------------------

export const BackendSettingsInputSchema = z.object({
  kind: z.enum(['portainer', 'socket', 'none']),
  portainer: z
    .object({
      url: z.string().url(),
      /** omit to keep the stored key */
      apiKey: z.string().min(1).optional(),
      endpointId: z.number().int().nullable().optional(),
      insecureTls: z.boolean().optional(),
    })
    .optional(),
  socket: z.object({ socketPath: z.string().min(1) }).optional(),
});

export const BackendTestInputSchema = z.object({
  kind: z.enum(['portainer', 'socket']),
  portainer: z
    .object({
      url: z.string().url(),
      apiKey: z.string().min(1).optional(),
      endpointId: z.number().int().nullable().optional(),
      insecureTls: z.boolean().optional(),
    })
    .optional(),
  socket: z.object({ socketPath: z.string().min(1) }).optional(),
});

export const PortainerEndpointsInputSchema = z.object({
  url: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  insecureTls: z.boolean().optional(),
});

/**
 * PUT /api/settings/general. NOT `GeneralConfigSchema.partial()`: the stored shape swallows
 * bad values via `.catch()` (see above), which would silently turn `containerPrefix: '../x'`
 * into the default and answer 200. Here every field is validated strictly, so the caller
 * gets a 422 naming the field.
 */
export const GeneralSettingsInputSchema = z
  .object({
    workspacesRoot: absPosixPath('workspacesRoot'),
    sharedClaudeVolume: dockerName('sharedClaudeVolume'),
    sharedClaudeHomeVolume: dockerName('sharedClaudeHomeVolume'),
    toolsVolume: dockerName('toolsVolume'),
    defaultRecipe: lowerName('defaultRecipe'),
    containerPrefix: lowerName('containerPrefix'),
    sessionNetwork: dockerName('sessionNetwork').nullable(),
    imageNamespace: lowerName('imageNamespace'),
    containerHome: absPosixPath('containerHome'),
    workspaceMount: absPosixPath('workspaceMount'),
    toolsMount: absPosixPath('toolsMount'),
  })
  .partial();

/** Compile-time guard: a field added to GeneralConfigSchema without a rule above (i.e.
 *  without validation on the way in) fails the build here. */
const _generalInputCoversEveryField: Record<keyof GeneralConfig, unknown> =
  GeneralSettingsInputSchema.shape;
void _generalInputCoversEveryField;

export const UiSettingsInputSchema = UiConfigSchema.partial();

export const PasswordChangeInputSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

export type BackendSettingsInput = z.infer<typeof BackendSettingsInputSchema>;
export type BackendTestInput = z.infer<typeof BackendTestInputSchema>;
export type GeneralSettingsInput = z.infer<typeof GeneralSettingsInputSchema>;
