// FROZEN (planner-authored, fully implemented). The session model is a cross-topic
// contract: config store (B1), sessions service/routes (B2) and the web UI all use it.
// Only add fields; never rename or retype an existing one.
import { z } from 'zod';
import { SLUG_RE } from '../util/slug.js';
import { AgentIdSchema } from '../agents/model.js';
import { HostIdSchema, LEGACY_HOST_ID } from '../hosts/model.js';
import type { ContainerState, PortBinding } from '../backends/types.js';

export const SessionNameSchema = z
  .string()
  .regex(SLUG_RE, 'name must be lowercase letters, digits and dashes (max 31 chars)');

export const PortMapSchema = z.object({
  containerPort: z.number().int().min(1).max(65535),
  hostPort: z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(['tcp', 'udp']).default('tcp'),
  hostIp: z.string().optional(),
});

export const MountSchema = z.object({
  type: z.enum(['bind', 'volume', 'tmpfs']),
  source: z.string().min(1),
  target: z.string().min(1).startsWith('/'),
  readOnly: z.boolean().default(false),
});

export const ImageRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('recipe'), recipe: z.string().min(1) }),
  z.object({ type: z.literal('custom'), ref: z.string().min(1) }),
]);

/**
 * A bind workspace host path: absolute (a path ON THE DOCKER HOST) or relative to
 * `general.workspacesRoot`.
 *
 * `.`/`..` segments are rejected for the same reason the path-like general settings reject
 * them (config/schema.ts): a relative `../../../etc` is joined to workspacesRoot and would
 * silently resolve to `/etc`, i.e. the documented "relative = under workspacesRoot"
 * contract would not hold. Backslashes and NUL are rejected because they cannot appear in
 * a POSIX host path the engine can bind-mount. container.ts additionally resolves the path
 * and asserts it stays under workspacesRoot (defence in depth for stored configs, which
 * are validated laxly on purpose - see SessionConfigSchema).
 */
export const WorkspaceHostPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => !/[\0\\]/.test(p), 'hostPath must not contain a backslash or a NUL byte')
  .refine(
    (p) => p.split('/').every((seg) => seg !== '.' && seg !== '..'),
    "hostPath must not contain '.' or '..' segments",
  );

/** named volume; `volume` defaults to porterclaude-ws-<session> */
const VolumeWorkspaceSchema = z.object({ type: z.literal('volume'), volume: z.string().min(1).optional() });
/** named volume seeded by cloning a git repo on first start */
const GitWorkspaceSchema = z.object({
  type: z.literal('git'),
  url: z.string().min(1),
  branch: z.string().min(1).optional(),
  volume: z.string().min(1).optional(),
});
/** bind mount of a path ON THE DOCKER HOST (or relative to general.workspacesRoot) */
const BindWorkspaceSchema = z.object({ type: z.literal('bind'), hostPath: WorkspaceHostPathSchema });

export const WorkspaceSchema = z.discriminatedUnion('type', [
  VolumeWorkspaceSchema,
  BindWorkspaceSchema,
  GitWorkspaceSchema,
]);

/** Stored form: see SessionConfigSchema - a config.json written before the hostPath rule
 *  existed must not quarantine the whole file. buildContainerSpec still refuses to mount
 *  a path that escapes workspacesRoot. */
export const WorkspaceStoredSchema = z.discriminatedUnion('type', [
  VolumeWorkspaceSchema,
  z.object({ type: z.literal('bind'), hostPath: z.string().min(1) }),
  GitWorkspaceSchema,
]);

export const LimitsSchema = z.object({
  cpus: z.number().positive().max(256).optional(),
  memoryMb: z.number().int().positive().max(1024 * 1024).optional(),
});

/**
 * Environment variable names as accepted by every POSIX shell (and by `docker exec`'s
 * `--env`): a key like `A B` is happily stored in `Config.Env` by the engine but can never
 * be read back inside the container, so it is rejected at the API boundary.
 */
export const EnvKeySchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'environment variable names must match [A-Za-z_][A-Za-z0-9_]*');

/**
 * What the client sends to create/update a session.
 *
 * v0.2: `hostId` picks the docker engine (omitted => the default host) and is IMMUTABLE
 * after create — moving a session to another host means recreating it there. `agents`
 * picks the coding agents mounted into the container (null => every agent enabled on the
 * host, resolved at create/recreate time).
 */
export const SessionInputSchema = z.object({
  name: SessionNameSchema,
  /** the host this session runs on; omitted => `config.defaultHostId` */
  hostId: HostIdSchema.optional(),
  /** null = inherit the host's enabled agents (the usual case) */
  agents: z.array(AgentIdSchema).max(64).nullable().default(null),
  displayName: z.string().max(120).optional(),
  image: ImageRefSchema,
  workspace: WorkspaceSchema.default({ type: 'volume' }),
  env: z.record(EnvKeySchema, z.string()).default({}),
  ports: z.array(PortMapSchema).default([]),
  extraMounts: z.array(MountSchema).default([]),
  limits: LimitsSchema.default({}),
  /** false => this session gets a private ~/.claude/projects volume */
  shareHistory: z.boolean().default(true),
  /** restart policy unless-stopped when true */
  autoStart: z.boolean().default(true),
  network: z.string().min(1).nullable().default(null),
  /** override the container user (custom images that are not uid 1000) */
  user: z.string().min(1).nullable().default(null),
});

/** Persisted form: input + bookkeeping. */
export const SessionConfigSchema = SessionInputSchema.extend({
  /** stored form: always set. A v1 config.json is migrated to the 'default' host, and the
   *  default keeps a hand-written/older file loadable instead of quarantining it. */
  hostId: z.string().min(1).default(LEGACY_HOST_ID),
  /** deliberately laxer than the input: a session adopted from a container may carry an
   *  env var the engine accepted before this rule existed, and rejecting it here would
   *  fail AppConfigSchema and quarantine the whole config.json. */
  env: z.record(z.string(), z.string()).default({}),
  /** laxer than the input for the same reason as `env`: an existing config.json (or an
   *  adopted container) may carry a hostPath that today's rule rejects, and failing here
   *  would quarantine every stored session. */
  workspace: WorkspaceStoredSchema.default({ type: 'volume' }),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** sha256 of the normalised spec that produced the running container */
  specHash: z.string().optional(),
});

export type SessionInput = z.infer<typeof SessionInputSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type SessionWorkspace = z.infer<typeof WorkspaceSchema>;
export type SessionImageRef = z.infer<typeof ImageRefSchema>;

/** Runtime status merged over the stored config; this is what GET /api/sessions returns. */
export interface SessionView extends SessionConfig {
  /** name of `hostId`, or the id itself when the host is gone (dangling session) */
  hostName: string;
  /** the host this session points at no longer exists */
  hostMissing: boolean;
  /** the agent ids actually mounted into the container: `agents ?? host.agents.enabled`,
   *  filtered to agents that still exist in the registry */
  resolvedAgents: string[];
  /** 'absent' = no container exists for this session yet */
  status: ContainerState | 'absent';
  containerId: string | null;
  containerName: string;
  /**
   * The STABLE image ref of this session: `<imageNamespace>/<recipe>:latest` for a recipe,
   * the custom ref otherwise. Deliberately not what docker reports for the container: a
   * recipe rebuild untags the image the container runs, and docker then answers a bare
   * `sha256:…` digest that means nothing to a user (see containerImage/imageOutdated).
   */
  resolvedImage: string;
  /** what docker says the container runs — a ref or, after a rebuild, a bare `sha256:…` */
  containerImage: string | null;
  /** the container runs an older image than `resolvedImage` resolves to today: recreate
   *  the session to pick the new one up (never true without a container) */
  imageOutdated: boolean;
  startedAt: string | null;
  uptimeSec: number | null;
  runtimePorts: PortBinding[];
  /** container exists but its labels/spec-hash no longer match the stored config */
  needsRecreate: boolean;
  /** container carries porterclaude labels but has no stored config */
  orphan: boolean;
  warnings: string[];
}

export const CONTAINER_LABELS = {
  managed: 'porterclaude.managed',
  session: 'porterclaude.session',
  /** v0.2: the host id the session belongs to (reconcile/adoption reads it back) */
  host: 'porterclaude.host',
  /** v0.2: comma separated agent ids mounted into this container */
  agents: 'porterclaude.agents',
  imageType: 'porterclaude.image-type',
  recipe: 'porterclaude.recipe',
  specHash: 'porterclaude.spec-hash',
  createdAt: 'porterclaude.created-at',
} as const;

export const IMAGE_LABELS = {
  recipe: 'porterclaude.recipe',
  claudeVersion: 'porterclaude.claude-version',
  contextHash: 'porterclaude.context-hash',
  builtAt: 'porterclaude.built-at',
} as const;

export function containerNameFor(prefix: string, session: string): string {
  return `${prefix}${session}`;
}

/** `<volumePrefix>ws-<session>` (v0.1 name with the default prefix `porterclaude-`). */
export function workspaceVolumeFor(volumePrefix: string, session: string): string {
  return `${volumePrefix}ws-${session}`;
}

/**
 * Private conversation history volume of ONE agent.
 *
 * The claude agent keeps the v0.1 name (`<prefix>hist-<session>`) so an existing session
 * keeps its history across the upgrade; every other agent gets the id suffix.
 */
export function historyVolumeFor(volumePrefix: string, session: string, agentId: string): string {
  return agentId === 'claude'
    ? `${volumePrefix}hist-${session}`
    : `${volumePrefix}hist-${session}-${agentId}`;
}
