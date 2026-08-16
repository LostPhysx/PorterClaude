// FROZEN (planner-authored, fully implemented, v0.2). THE coding-agent contract: the shape
// of an AgentDefinition, the per-host auth volume layout, and the pure helpers that turn a
// definition into container mounts / symlinks. Used by B1 (registry, routes, hosts) and by
// B2 (sessions/container.ts, terminals, images/tools sync) alike — no I/O in this file.
//
// LAYOUT (v0.2, docs/design/backend.md §12)
// ------------------------------------------------------------------------------------
// Every agent gets EXACTLY ONE named volume per host:  <volumePrefix>auth-<agentId>
// mounted at   <containerHome>/.porterclaude/agents/<agentId>   (the "agent dir").
// Its sharedPaths are NOT mounted directly; the bootstrap creates a symlink for each of
// them into the agent dir:
//
//   ~/.claude       (dir)  ->  <agentDir>/claude
//   ~/.claude.json  (file) ->  <agentDir>/claude.json
//
// Why not mount the shared paths directly: an agent may share several directories
// (opencode shares ~/.local/share/opencode AND ~/.config/opencode) and the same volume
// cannot be mounted twice with different contents; and single-file paths cannot be bind
// mounted at all (agents rewrite them atomically via rename(2), which breaks a file bind).
// One volume + symlinks covers both cases with one rule.
//
// The private-history overlay (session.shareHistory === false) mounts its own volume at a
// path INSIDE the agent dir (e.g. <agentDir>/claude/projects) — docker sorts mounts by
// target depth, so a nested mount on top of the agent volume is well defined, whereas a
// mount THROUGH the ~/.claude symlink is not.
import { z } from 'zod';

/** agent ids are slugs: lowercase letters, digits and dashes (max 32 chars) */
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const AgentIdSchema = z
  .string()
  .regex(AGENT_ID_RE, 'agent id must be lowercase letters, digits and dashes (max 32 chars)');

/** Where an agent keeps state that must be shared between every session on a host. */
export const AgentSharedPathSchema = z.object({
  /** `~/…` (relative to the container home) or an absolute POSIX path */
  path: z.string().min(1).max(256),
  kind: z.enum(['dir', 'file']),
  /** informational: what lives there ("credentials", "settings", …) */
  note: z.string().max(200).optional(),
});

/**
 * How the tools image installs the agent into the shared tools volume. Every kind is
 * arch-aware; only `binary` needs explicit per-target URLs because the others resolve the
 * architecture themselves (installer script / npm / pip).
 *
 * Targets are the four the tools volume ships: `linux-x64`, `linux-arm64`,
 * `linux-x64-musl`, `linux-arm64-musl` (musl is best effort).
 */
export const AgentInstallSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('script'),
    /** curl'ed and piped into sh, with HOME/PREFIX pointed at the tools payload */
    url: z.string().url(),
    args: z.array(z.string()).max(32).optional(),
    /** the executable the installer leaves behind, relative to its install prefix */
    binPath: z.string().max(256).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    kind: z.literal('npm'),
    package: z.string().min(1).max(214),
    /** npm dist-tag or exact version (default 'latest') */
    version: z.string().max(64).optional(),
    /** the bin name npm links (default: the agent's `command`) */
    bin: z.string().max(64).optional(),
  }),
  z.object({
    kind: z.literal('pip'),
    package: z.string().min(1).max(214),
    version: z.string().max(64).optional(),
    bin: z.string().max(64).optional(),
    /** install with `uv tool install` when available (default true) */
    preferUv: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('binary'),
    /** download URL per target; missing targets are simply not installed */
    urls: z.record(
      z.enum(['linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl']),
      z.string().url(),
    ),
    archive: z.enum(['none', 'tar.gz', 'zip']).default('none'),
    /** path of the executable inside the archive (ignored for archive:'none') */
    path: z.string().max(256).optional(),
  }),
]);

export const AgentDefinitionSchema = z.object({
  id: AgentIdSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  /** executable name as it must be callable inside a session (PATH is wired by the tools volume) */
  command: z.string().min(1).max(64),
  /** extra argv appended when a terminal opens the agent */
  args: z.array(z.string().max(200)).max(32).default([]),
  /** argv that prints the installed version, e.g. ['claude','--version'] */
  versionCommand: z.array(z.string().min(1).max(200)).min(1).max(8),
  install: AgentInstallSchema,
  sharedPaths: z.array(AgentSharedPathSchema).min(1).max(8),
  /**
   * Conversation history INSIDE one of the sharedPaths (e.g. `~/.claude/projects`).
   * `session.shareHistory === false` gives the session its own volume for it.
   */
  historyPath: z.string().max(256).nullable().default(null),
  /** extra container env this agent needs (merged before the session's own env) */
  env: z.record(z.string(), z.string()).default({}),
  /** one line telling the user how to authenticate ("run `claude` and use /login") */
  loginHint: z.string().max(300).optional(),
  homepage: z.string().url().optional(),
});

export type AgentSharedPath = z.infer<typeof AgentSharedPathSchema>;
export type AgentInstall = z.infer<typeof AgentInstallSchema>;
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** What `GET /api/agents` returns: the definition plus where it came from. */
export interface AgentView extends AgentDefinition {
  builtin: boolean;
}

/** Per-host agent state — definition + config + what the tools volume really holds. */
export interface HostAgentView extends AgentView {
  /** the host is configured to install/mount this agent */
  enabled: boolean;
  /** the tools volume of this host carries it (from <toolsMount>/AGENTS.json) */
  installed: boolean;
  /** version reported by the last tools sync, null when unknown */
  version: string | null;
  installedAt: string | null;
  /** last install error reported by the tools sync, if any */
  error: string | null;
  /** the per-host auth volume name */
  authVolume: string;
}

/** Input for POST/PUT /api/agents (custom agents). `id` is immutable on PUT. */
export const AgentDefinitionInputSchema = AgentDefinitionSchema;
export type AgentDefinitionInput = z.infer<typeof AgentDefinitionInputSchema>;

// ---------------------------------------------------------------------------
// Tools-volume contract (consumed by docker/tools, produced by images/service.ts)
// ---------------------------------------------------------------------------

/** One entry of the `PORTERCLAUDE_AGENTS` JSON array handed to the tools populate container. */
export interface AgentInstallSpec {
  id: string;
  command: string;
  install: AgentInstall;
  versionCommand: string[];
}

/** `<toolsMount>/AGENTS.json`, written by the tools populate container. */
export interface ToolsAgentManifest {
  syncedAt: string;
  agents: Array<{
    id: string;
    command: string;
    installed: boolean;
    version: string | null;
    error?: string | null;
  }>;
}

/** Filename of the manifest inside the tools volume. */
export const TOOLS_AGENT_MANIFEST = 'AGENTS.json';

/** Directory inside the tools volume that holds one subdirectory per installed agent. */
export const TOOLS_AGENTS_DIR = 'agents';

/** env var carrying the install specs into the tools populate container */
export const TOOLS_AGENTS_ENV = 'PORTERCLAUDE_AGENTS';

/** env var of a SESSION container: comma separated ids of the agents mounted into it */
export const SESSION_AGENTS_ENV = 'PORTERCLAUDE_AGENT_IDS';

/** env var of a SESSION container: the symlinks the bootstrap must create (encodeAgentLinks) */
export const SESSION_AGENT_LINKS_ENV = 'PORTERCLAUDE_AGENT_LINKS';

// ---------------------------------------------------------------------------
// Pure helpers — the naming rules both packages must agree on
// ---------------------------------------------------------------------------

/** `<volumePrefix>auth-<agentId>`, e.g. `porterclaude-auth-claude`. Per host (per engine). */
export function agentAuthVolumeFor(volumePrefix: string, agentId: string): string {
  return `${volumePrefix}auth-${agentId}`;
}

/** `<containerHome>/.porterclaude/agents` */
export function agentDataRoot(containerHome: string): string {
  return `${containerHome.replace(/\/+$/, '')}/.porterclaude/agents`;
}

/** `<containerHome>/.porterclaude/agents/<agentId>` — where the auth volume is mounted. */
export function agentDataDir(containerHome: string, agentId: string): string {
  return `${agentDataRoot(containerHome)}/${agentId}`;
}

/** `~/.foo/bar` -> `<containerHome>/.foo/bar`; absolute paths pass through. */
export function resolveAgentPath(containerHome: string, p: string): string {
  const home = containerHome.replace(/\/+$/, '');
  if (p === '~') return home;
  if (p.startsWith('~/')) return `${home}/${p.slice(2)}`;
  if (p.startsWith('/')) return p.replace(/\/+$/, '') || '/';
  return `${home}/${p}`;
}

/**
 * Name of a shared path INSIDE the agent volume. Derived from the whole path (not the
 * basename) so that two shared paths of one agent can never collide:
 *   `~/.claude`                  -> `claude`
 *   `~/.claude.json`             -> `claude.json`
 *   `~/.local/share/opencode`    -> `local-share-opencode`
 *   `~/.config/opencode`         -> `config-opencode`
 */
export function agentPathSlug(p: string): string {
  const cleaned = p.replace(/^~\/?/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const slug = cleaned
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.replace(/^\.+/, ''))
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'data';
}

export interface AgentLink {
  /** absolute path inside the container that the agent expects (`/home/dev/.claude`) */
  target: string;
  /** absolute path inside the mounted auth volume the target points at */
  source: string;
  kind: 'dir' | 'file';
}

/** Every symlink the bootstrap must create for one agent. */
export function agentLinks(def: AgentDefinition, containerHome: string): AgentLink[] {
  const dir = agentDataDir(containerHome, def.id);
  return def.sharedPaths.map((sp) => ({
    target: resolveAgentPath(containerHome, sp.path),
    source: `${dir}/${agentPathSlug(sp.path)}`,
    kind: sp.kind,
  }));
}

/**
 * The path INSIDE the auth volume that backs `def.historyPath` (null when the definition
 * declares none, or when it is not below one of the shared dir paths). This is the mount
 * target of the private-history volume — never the `~/...` path, which is a symlink.
 */
export function agentHistoryTarget(def: AgentDefinition, containerHome: string): string | null {
  if (!def.historyPath) return null;
  const wanted = resolveAgentPath(containerHome, def.historyPath);
  const links = agentLinks(def, containerHome).filter((l) => l.kind === 'dir');
  // longest matching shared dir wins
  const match = links
    .filter((l) => wanted === l.target || wanted.startsWith(`${l.target}/`))
    .sort((a, b) => b.target.length - a.target.length)[0];
  if (!match) return null;
  const rest = wanted.slice(match.target.length);
  return `${match.source}${rest}`;
}

/** `target|source|kind;target|source|kind` — the SESSION_AGENT_LINKS_ENV encoding. */
export function encodeAgentLinks(links: AgentLink[]): string {
  return links.map((l) => `${l.target}|${l.source}|${l.kind}`).join(';');
}

export function decodeAgentLinks(value: string): AgentLink[] {
  const out: AgentLink[] = [];
  for (const entry of value.split(';')) {
    const parts = entry.split('|');
    if (parts.length !== 3) continue;
    const [target, source, kind] = parts as [string, string, string];
    if (!target || !source) continue;
    out.push({ target, source, kind: kind === 'file' ? 'file' : 'dir' });
  }
  return out;
}

/** What the tools populate container needs to install an agent. */
export function agentInstallSpec(def: AgentDefinition): AgentInstallSpec {
  return { id: def.id, command: def.command, install: def.install, versionCommand: def.versionCommand };
}

/** argv a terminal runs for this agent (`command` + `args`). */
export function agentCommandLine(def: AgentDefinition): string[] {
  return [def.command, ...def.args];
}
