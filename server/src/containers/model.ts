// FROZEN (planner-authored, fully implemented). The container model is a cross-topic
// contract: config store (B1), containers service/routes (B2) and the web UI all use it.
// Only add fields; never rename or retype an existing one.
import { z } from 'zod';
import { SLUG_RE } from '../util/slug.js';
import { AgentIdSchema, CONTAINER_AGENTS_ENV } from '../agents/model.js';
import { HostIdSchema, LEGACY_HOST_ID } from '../hosts/model.js';
import { ProfileIdSchema } from '../profiles/model.js';
import type { ContainerState, PortBinding } from '../backends/types.js';

export const ContainerNameSchema = z
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
 * are validated laxly on purpose - see ContainerConfigSchema).
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

/** named volume; `volume` defaults to porterclaude-ws-<container> */
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

/** Stored form: see ContainerConfigSchema - a config.json written before the hostPath rule
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
 * What the client sends to create/update a container.
 *
 * v0.2: `hostId` picks the docker engine (omitted => the default host) and is IMMUTABLE
 * after create — moving a container to another host means recreating it there. `agents`
 * picks the coding agents mounted into the container (null => every agent enabled on the
 * host, resolved at create/recreate time).
 */
export const ContainerInputSchema = z.object({
  name: ContainerNameSchema,
  /** the host this container runs on; omitted => `config.defaultHostId` */
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
  /** false => this container gets a private ~/.claude/projects volume */
  shareHistory: z.boolean().default(true),
  /** restart policy unless-stopped when true */
  autoStart: z.boolean().default(true),
  network: z.string().min(1).nullable().default(null),
  /** override the container user (custom images that are not uid 1000) */
  user: z.string().min(1).nullable().default(null),
  /**
   * v0.4: the profile this container runs with (null = no profile, the default and the
   * pre-v0.4 behavior). Changing it changes the mounted login-set volumes, so it always
   * flips needsRecreate. Validated to a KNOWN profile id by the container service.
   */
  profileId: ProfileIdSchema.nullable().default(null),
});

/** Persisted form: input + bookkeeping. */
export const ContainerConfigSchema = ContainerInputSchema.extend({
  /** stored form: always set. A v1 config.json is migrated to the 'default' host, and the
   *  default keeps a hand-written/older file loadable instead of quarantining it. */
  hostId: z.string().min(1).default(LEGACY_HOST_ID),
  /** deliberately laxer than the input: a container adopted from a running container may
   *  carry an env var the engine accepted before this rule existed, and rejecting it here
   *  would fail AppConfigSchema and quarantine the whole config.json. */
  env: z.record(z.string(), z.string()).default({}),
  /** laxer than the input for the same reason as `env`: an existing config.json (or an
   *  adopted container) may carry a hostPath that today's rule rejects, and failing here
   *  would quarantine every stored container. */
  workspace: WorkspaceStoredSchema.default({ type: 'volume' }),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** sha256 of the normalised spec that produced the running container */
  specHash: z.string().optional(),
});

export type ContainerInput = z.infer<typeof ContainerInputSchema>;
export type ContainerConfig = z.infer<typeof ContainerConfigSchema>;
export type ContainerWorkspace = z.infer<typeof WorkspaceSchema>;
export type ContainerImageRef = z.infer<typeof ImageRefSchema>;

/**
 * v0.2.2: a container whose host was not ready yet (recipe image not built, tools volume
 * never synced) is no longer refused — the server does the work and reports it here while
 * the request is long over. `null` on every container that is simply ready.
 */
export interface ContainerPreparation {
  phase: 'building-image' | 'syncing-tools' | 'creating' | 'starting';
  /** human-readable version of `phase`, including what is being built/synced */
  detail: string;
  /** the image jobs this preparation is waiting on (GET /api/hosts/:id/images/jobs/:jobId) */
  jobs: { id: string; kind: string; target: string }[];
  startedAt: string;
}

/** Runtime status merged over the stored config; this is what GET /api/containers returns. */
export interface ContainerView extends ContainerConfig {
  /** non-null while the server is preparing the host for this container (v0.2.2) */
  preparing: ContainerPreparation | null;
  /** name of `hostId`, or the id itself when the host is gone (dangling container) */
  hostName: string;
  /** the host this container points at no longer exists */
  hostMissing: boolean;
  /** the agent ids actually mounted into the container: `agents ?? host.agents.enabled`,
   *  filtered to agents that still exist in the registry */
  resolvedAgents: string[];
  /** 'absent' = no container exists for this definition yet */
  status: ContainerState | 'absent';
  containerId: string | null;
  containerName: string;
  /**
   * The STABLE image ref of this container: `<imageNamespace>/<recipe>:latest` for a recipe,
   * the custom ref otherwise. Deliberately not what docker reports for the container: a
   * recipe rebuild untags the image the container runs, and docker then answers a bare
   * `sha256:…` digest that means nothing to a user (see containerImage/imageOutdated).
   */
  resolvedImage: string;
  /** what docker says the container runs — a ref or, after a rebuild, a bare `sha256:…` */
  containerImage: string | null;
  /** the container runs an older image than `resolvedImage` resolves to today: recreate
   *  the container to pick the new one up (never true without a container) */
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
  container: 'porterclaude.container',
  /** v0.2: the host id the container belongs to (reconcile/adoption reads it back) */
  host: 'porterclaude.host',
  /**
   * v0.2: the PorterClaude INSTALL that created this container (config.instanceId).
   * Container discovery only ever touches containers that carry this install's id or NO id at
   * all (v0.1 / v0.2.0 containers) — see containers/service.ts `ownedByThisInstance`.
   */
  instance: 'porterclaude.instance',
  /** v0.2: comma separated agent ids mounted into this container */
  agents: 'porterclaude.agents',
  imageType: 'porterclaude.image-type',
  recipe: 'porterclaude.recipe',
  /** v0.4: the profile id the container runs with (recovered by synthesizeConfig on adoption) */
  profile: 'porterclaude.profile',
  specHash: 'porterclaude.spec-hash',
  createdAt: 'porterclaude.created-at',
} as const;

/**
 * v0.3: the pre-rename name of `CONTAINER_LABELS.container`. COMPATIBILITY READ ONLY — it is
 * never written any more, and every live container created before v0.3 carries it instead of
 * the new one. Discovery matches on this label, so dropping the fallback would turn every
 * running container into an orphan. Remove in v0.4, by which time every container has been
 * relabelled on its next recreate.
 */
export const LEGACY_CONTAINER_LABEL = 'porterclaude.session';

/**
 * The container name a set of docker labels claims: the v0.3 label, else the v0.2 one.
 *
 * THE ONLY way anything may read the container label — matchContainer, reconcile and
 * synthesizeConfig all go through it so the compatibility read cannot be missed at one of
 * them (which would strand every pre-v0.3 container as an orphan).
 */
export function containerLabelOf(labels?: Record<string, string> | null): string | undefined {
  return labels?.[CONTAINER_LABELS.container] ?? labels?.[LEGACY_CONTAINER_LABEL];
}

export const IMAGE_LABELS = {
  recipe: 'porterclaude.recipe',
  claudeVersion: 'porterclaude.claude-version',
  contextHash: 'porterclaude.context-hash',
  builtAt: 'porterclaude.built-at',
} as const;

/**
 * The agent ids a CONTAINER really mounts — the only truthful source for "can this pane
 * start agent X?".
 *
 * `agents ?? host.agents.enabled` describes what a container SHOULD mount, which drifts the
 * moment an agent is enabled on the host after the container was created (ContainerView then
 * reports needsRecreate). Starting an agent the container has no auth volume for would hand
 * the user a fresh, unauthenticated instance, so sessions gate on this instead.
 *
 * Reads the `porterclaude.agents` label (set by buildContainerSpec) and falls back to the
 * `PORTERCLAUDE_AGENT_IDS` env of the container inspect. Returns `null` when the container
 * carries neither — a v0.1 container, where the caller has to fall back to the config.
 * An empty label ("no agents at all") is a real answer and comes back as `[]`.
 */
export function containerAgentIds(
  labels?: Record<string, string> | null,
  env?: readonly string[] | null,
): string[] | null {
  const raw =
    labels?.[CONTAINER_LABELS.agents] ??
    env?.find((e) => e.startsWith(`${CONTAINER_AGENTS_ENV}=`))?.slice(CONTAINER_AGENTS_ENV.length + 1);
  if (raw === undefined) return null;
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function containerNameFor(prefix: string, container: string): string {
  return `${prefix}${container}`;
}

/** `<volumePrefix>ws-<container>` (v0.1 name with the default prefix `porterclaude-`). */
export function workspaceVolumeFor(volumePrefix: string, container: string): string {
  return `${volumePrefix}ws-${container}`;
}

/**
 * Private conversation history volume of ONE agent.
 *
 * The claude agent keeps the v0.1 name (`<prefix>hist-<container>`) so an existing container
 * keeps its history across the upgrade; every other agent gets the id suffix.
 */
export function historyVolumeFor(volumePrefix: string, container: string, agentId: string): string {
  return agentId === 'claude'
    ? `${volumePrefix}hist-${container}`
    : `${volumePrefix}hist-${container}-${agentId}`;
}
