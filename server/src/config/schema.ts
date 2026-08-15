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

export const GeneralConfigSchema = z.object({
  /** host directory used when a session asks for a bind workspace without an absolute path */
  workspacesRoot: z.string().default('/srv/porterclaude/workspaces'),
  sharedClaudeVolume: z.string().default('porterclaude-claude'),
  sharedClaudeHomeVolume: z.string().default('porterclaude-claude-home'),
  toolsVolume: z.string().default('porterclaude-tools'),
  defaultRecipe: z.string().default('node'),
  containerPrefix: z.string().default('pc-'),
  /** attach every session container to this docker network (null = default bridge) */
  sessionNetwork: z.string().nullable().default(null),
  imageNamespace: z.string().default('porterclaude'),
  /** home dir inside recipe images; mounts are derived from it */
  containerHome: z.string().default('/home/dev'),
  workspaceMount: z.string().default('/workspace'),
  toolsMount: z.string().default('/opt/porterclaude'),
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

export const GeneralSettingsInputSchema = GeneralConfigSchema.partial();

export const UiSettingsInputSchema = UiConfigSchema.partial();

export const PasswordChangeInputSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

export type BackendSettingsInput = z.infer<typeof BackendSettingsInputSchema>;
export type BackendTestInput = z.infer<typeof BackendTestInputSchema>;
export type GeneralSettingsInput = z.infer<typeof GeneralSettingsInputSchema>;
