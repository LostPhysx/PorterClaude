// FROZEN (planner-authored, fully implemented, v0.2). THE host contract: a host is "one
// docker engine PorterClaude manages", identified by a slug, reachable through exactly one
// connection. Everything that used to be global in v0.1 (backend, images, tools volume,
// shared login volumes) is now per host.
//
// Adding a connection type is LOCAL to two places:
//   1. `HostConnectionSchema` here (add a member to the discriminated union), and
//   2. `createBackend()` in backends/index.ts (add a case).
// Nothing else in the server switches on the connection type.
import { z } from 'zod';
import { GENERAL_FIELD_SCHEMAS } from '../config/fields.js';
import { AgentIdSchema } from '../agents/model.js';
import type { DockerInfo } from '../backends/types.js';

/** host ids are slugs: lowercase letters, digits and dashes (max 32 chars) */
export const HOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const HostIdSchema = z
  .string()
  .regex(HOST_ID_RE, 'host id must be lowercase letters, digits and dashes (max 32 chars)');

/** The id the v0.1 backend is migrated to (config schema v1 -> v2). */
export const LEGACY_HOST_ID = 'default';

/** `:hostId` path parameter of every host-scoped route. */
export const HostIdParamsSchema = z.object({ hostId: HostIdSchema });

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/** the docker socket of the machine PorterClaude itself runs on — at most one per install */
export const SocketConnectionSchema = z.object({
  type: z.literal('socket'),
  socketPath: z.string().min(1).max(512).default('/var/run/docker.sock'),
});

/** a Portainer endpoint, addressed through a stored PortainerCredential */
export const PortainerConnectionSchema = z.object({
  type: z.literal('portainer'),
  credentialId: z.string().min(1).max(64),
  endpointId: z.number().int().nonnegative(),
});

/** RESERVED (v0.3): Docker Engine API over TLS. Accepted by the schema, refused by the
 *  backend factory with `not_implemented` so a config written by a newer version loads. */
export const TcpConnectionSchema = z.object({
  type: z.literal('tcp'),
  /** `tcp://host:2376` */
  url: z.string().min(1).max(512),
  /** id of a (future) TLS credential holding ca/cert/key */
  credentialId: z.string().min(1).max(64).nullable().default(null),
  insecureTls: z.boolean().default(false),
});

/** RESERVED (v0.3): docker over ssh. Same rules as `tcp`. */
export const SshConnectionSchema = z.object({
  type: z.literal('ssh'),
  /** `ssh://user@host[:port]` */
  url: z.string().min(1).max(512),
  /** id of a (future) ssh credential holding the private key */
  credentialId: z.string().min(1).max(64).nullable().default(null),
  socketPath: z.string().min(1).max(512).default('/var/run/docker.sock'),
});

export const HostConnectionSchema = z.discriminatedUnion('type', [
  SocketConnectionSchema,
  PortainerConnectionSchema,
  TcpConnectionSchema,
  SshConnectionSchema,
]);

export type HostConnection = z.infer<typeof HostConnectionSchema>;
export type HostConnectionType = HostConnection['type'];

/** Connection types this version can actually talk to. */
export const IMPLEMENTED_CONNECTION_TYPES: HostConnectionType[] = ['socket', 'portainer'];

// ---------------------------------------------------------------------------
// Host config
// ---------------------------------------------------------------------------

/**
 * Per-host overrides of the general settings. `HostManager.settingsFor(hostId)` returns
 * `{ ...config.general, ...host.overrides }`, so a host may e.g. use a different
 * `workspacesRoot` or `containerHome` without a second settings page.
 */
export const HostOverridesSchema = z.object(GENERAL_FIELD_SCHEMAS).partial();
export type HostOverrides = z.infer<typeof HostOverridesSchema>;

export const HostAgentsConfigSchema = z.object({
  /** agent ids installed into this host's tools volume and mounted into its sessions */
  enabled: z.array(AgentIdSchema).max(64).default([]),
});

export const HostConfigSchema = z.object({
  id: HostIdSchema,
  name: z.string().min(1).max(80),
  connection: HostConnectionSchema,
  overrides: HostOverridesSchema.default({}),
  agents: HostAgentsConfigSchema.default({}),
  /** free-form operator note shown in the UI */
  notes: z.string().max(500).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type HostConfig = z.infer<typeof HostConfigSchema>;

/** POST /api/hosts */
export const HostInputSchema = z.object({
  /** optional: derived from `name` when omitted (slugified, de-duplicated) */
  id: HostIdSchema.optional(),
  name: z.string().min(1).max(80),
  connection: HostConnectionSchema,
  overrides: HostOverridesSchema.optional(),
  agents: z.array(AgentIdSchema).max(64).optional(),
  notes: z.string().max(500).nullable().optional(),
  /** make this the default host */
  makeDefault: z.boolean().optional(),
});
export type HostInput = z.infer<typeof HostInputSchema>;

/** PUT /api/hosts/:hostId — `id` is immutable (a rename is a new host). */
export const HostUpdateInputSchema = HostInputSchema.omit({ id: true }).partial();
export type HostUpdateInput = z.infer<typeof HostUpdateInputSchema>;

/** POST /api/hosts/test and POST /api/hosts/:hostId/test — probe without saving. */
export const HostTestInputSchema = z.object({
  connection: HostConnectionSchema,
  /** portainer only: use this key instead of the stored one (never persisted) */
  apiKey: z.string().min(1).optional(),
});
export type HostTestInput = z.infer<typeof HostTestInputSchema>;

/** PUT /api/hosts/:hostId/agents */
export const HostAgentsInputSchema = z.object({ enabled: z.array(AgentIdSchema).max(64) });
export type HostAgentsInput = z.infer<typeof HostAgentsInputSchema>;

// ---------------------------------------------------------------------------
// Views (API projections; never contain a secret)
// ---------------------------------------------------------------------------

export type HostStatus = 'ok' | 'unreachable' | 'not_configured' | 'unknown';

export interface HostView {
  id: string;
  name: string;
  connection: HostConnection;
  /** resolved connection summary for the UI, e.g. "portainer: https://…#2" */
  connectionLabel: string;
  /** name of the referenced credential (portainer), null otherwise */
  credentialName: string | null;
  isDefault: boolean;
  /** this version can talk to `connection.type` */
  supported: boolean;
  status: HostStatus;
  /** filled by GET /api/hosts?probe=1 and GET /api/hosts/:hostId — null when not probed */
  info: DockerInfo | null;
  error: string | null;
  /** effective general settings of this host (general + overrides) */
  settings: Record<string, unknown>;
  overrides: HostOverrides;
  agents: { enabled: string[] };
  /** number of stored sessions pinned to this host */
  sessionCount: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Portainer credentials
// ---------------------------------------------------------------------------

export const PortainerCredentialConfigSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  url: z.string().min(1).max(512),
  /** encrypted blob (config/crypto.ts); never returned by the API */
  apiKeyEnc: z.string().nullable().default(null),
  insecureTls: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PortainerCredentialConfig = z.infer<typeof PortainerCredentialConfigSchema>;

export const PortainerCredentialInputSchema = z.object({
  name: z.string().min(1).max(80),
  url: z.string().url(),
  /** omit on PUT to keep the stored key; required on POST */
  apiKey: z.string().min(1).optional(),
  insecureTls: z.boolean().optional(),
});
export type PortainerCredentialInput = z.infer<typeof PortainerCredentialInputSchema>;

export interface SanitizedPortainerCredential {
  id: string;
  name: string;
  url: string;
  insecureTls: boolean;
  apiKeySet: boolean;
  /** last 4 chars of the stored key, or null */
  apiKeyHint: string | null;
  /** ids of the hosts referencing this credential */
  hostIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** POST /api/credentials/portainer/:id/import — one host per Portainer endpoint. */
export const PortainerImportInputSchema = z.object({
  /** omit to import every endpoint the credential can see */
  endpointIds: z.array(z.number().int().nonnegative()).max(200).optional(),
  /** `{name}` is replaced by the endpoint name (default `{name}`) */
  nameTemplate: z.string().min(1).max(80).optional(),
  /** update hosts that already point at an imported endpoint (default true) */
  update: z.boolean().optional(),
});
export type PortainerImportInput = z.infer<typeof PortainerImportInputSchema>;

export interface PortainerImportResult {
  created: string[];
  updated: string[];
  /** endpoints that were skipped, with the reason ("not a docker endpoint", "id taken") */
  skipped: Array<{ endpointId: number; name: string; reason: string }>;
  hosts: HostView[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** `My Docker box!` -> `my-docker-box`; empty/invalid input -> `host`. */
export function slugifyHostId(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return HOST_ID_RE.test(slug) ? slug : 'host';
}

/** `base`, `base-2`, `base-3`, … — first id not present in `taken`. */
export function uniqueHostId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base.slice(0, 29)}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 24)}-${Date.now().toString(36)}`;
}

/** Short human label of a connection; NEVER contains a secret. */
export function connectionLabel(conn: HostConnection, credentialUrl?: string | null): string {
  switch (conn.type) {
    case 'socket':
      return `socket: ${conn.socketPath}`;
    case 'portainer':
      return `portainer: ${credentialUrl ?? conn.credentialId}#${conn.endpointId}`;
    case 'tcp':
      return `tcp: ${conn.url}`;
    case 'ssh':
      return `ssh: ${conn.url}`;
    default:
      return 'unknown';
  }
}

/** Stable identity of the engine a connection points at (DockerBackend.id). */
export function connectionKey(conn: HostConnection, credentialUrl?: string | null): string {
  switch (conn.type) {
    case 'socket':
      return `socket:${conn.socketPath}`;
    case 'portainer':
      return `portainer:${credentialUrl ?? conn.credentialId}#${conn.endpointId}`;
    case 'tcp':
      return `tcp:${conn.url}`;
    case 'ssh':
      return `ssh:${conn.url}`;
    default:
      return 'unknown';
  }
}

export function isImplementedConnection(conn: HostConnection): boolean {
  return IMPLEMENTED_CONNECTION_TYPES.includes(conn.type);
}
