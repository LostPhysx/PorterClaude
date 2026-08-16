// FROZEN (planner-authored, fully implemented, v0.2). The field validators shared by the
// stored config (config/schema.ts), the per-host overrides (hosts/model.ts) and the
// settings API. Kept in its own leaf module so hosts/model.ts and config/schema.ts can
// both use them without an import cycle.
//
// Import DAG (must stay acyclic):
//   config/fields.ts  <-  hosts/model.ts, agents/model.ts, sessions/model.ts  <-  config/schema.ts
import { z } from 'zod';

/** docker object names (volumes, networks): [a-zA-Z0-9][a-zA-Z0-9_.-]* */
export const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
/** container-name-safe prefixes and image namespaces (lowercase, docker repo syntax) */
export const LOWER_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** absolute POSIX path with at least one segment, no `.`/`..` segment, no backslash/NUL */
export const ABS_POSIX_PATH_RE = /^(?:\/(?!\.\.?(?:\/|$))[^/\0\\]+)+\/?$/;

export const dockerName = (label: string) =>
  z.string().min(1).max(128).regex(DOCKER_NAME_RE, `${label} must match [a-zA-Z0-9][a-zA-Z0-9_.-]*`);

export const lowerName = (label: string) =>
  z.string().min(1).max(64).regex(LOWER_NAME_RE, `${label} must match [a-z0-9][a-z0-9._-]*`);

export const absPosixPath = (label: string) =>
  z
    .string()
    .min(1)
    .max(512)
    .regex(ABS_POSIX_PATH_RE, `${label} must be an absolute POSIX path (no '.'/'..' segments)`);

/**
 * `.catch(<default>)` on the STORED shape only: a hand-edited config.json with a bad value
 * falls back to the default instead of failing AppConfigSchema, which would quarantine the
 * whole file (and with it every stored session). API input schemas have no catch, so a bad
 * value sent to the settings API is a 422.
 */
export const stored = <T extends z.ZodTypeAny, D extends z.infer<T>>(schema: T, fallback: D) =>
  schema.default(fallback).catch(fallback);

/**
 * The STRICT shape of every general setting. `GeneralConfigSchema` (config/schema.ts) wraps
 * these in `stored(...)` with defaults; `HostOverridesSchema` (hosts/model.ts) makes them
 * partial; `GeneralSettingsInputSchema` re-uses them verbatim for `PUT /api/settings/general`.
 * Adding a field here is the ONE place a new general setting is declared.
 */
export const GENERAL_FIELD_SCHEMAS = {
  workspacesRoot: absPosixPath('workspacesRoot'),
  /** v0.2: prefix of every volume PorterClaude creates (`porterclaude-ws-<slug>`, ...) */
  volumePrefix: lowerName('volumePrefix'),
  /** v0.1 shared claude volumes; kept ONLY for the legacy auth import (backend.md v0.2 §7) */
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
} as const;

export type GeneralFieldName = keyof typeof GENERAL_FIELD_SCHEMAS;
