// FROZEN (planner-authored, fully implemented). The session model is a cross-topic
// contract: config store (B1), sessions service/routes (B2) and the web UI all use it.
// Only add fields; never rename or retype an existing one.
import { z } from 'zod';
import { SLUG_RE } from '../util/slug.js';
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

export const WorkspaceSchema = z.discriminatedUnion('type', [
  /** named volume; `volume` defaults to porterclaude-ws-<session> */
  z.object({ type: z.literal('volume'), volume: z.string().min(1).optional() }),
  /** bind mount of a path ON THE DOCKER HOST */
  z.object({ type: z.literal('bind'), hostPath: z.string().min(1) }),
  /** named volume seeded by cloning a git repo on first start */
  z.object({ type: z.literal('git'), url: z.string().min(1), branch: z.string().min(1).optional(), volume: z.string().min(1).optional() }),
]);

export const LimitsSchema = z.object({
  cpus: z.number().positive().max(256).optional(),
  memoryMb: z.number().int().positive().max(1024 * 1024).optional(),
});

/** What the client sends to create/update a session. */
export const SessionInputSchema = z.object({
  name: SessionNameSchema,
  displayName: z.string().max(120).optional(),
  image: ImageRefSchema,
  workspace: WorkspaceSchema.default({ type: 'volume' }),
  env: z.record(z.string(), z.string()).default({}),
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
  /** 'absent' = no container exists for this session yet */
  status: ContainerState | 'absent';
  containerId: string | null;
  containerName: string;
  /** the concrete image ref the container runs / would run */
  resolvedImage: string;
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

export function workspaceVolumeFor(session: string): string {
  return `porterclaude-ws-${session}`;
}

export function historyVolumeFor(session: string): string {
  return `porterclaude-hist-${session}`;
}
