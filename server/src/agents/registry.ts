// OWNER: B1. Public API FROZEN — B2 uses `require()`, `enabledForHost()`,
// `resolveForSession()` and `installSpecsForHost()`; nothing else.
//
// The registry is the union of the built-ins (agents/builtin.ts) and the custom definitions
// stored in `config.agents.custom`. Ids are globally unique: a custom agent may not reuse a
// built-in id (409), so `list()` never has to resolve a collision.
import type { ConfigStore } from '../config/store.js';
import type { Logger } from '../logger.js';
import type { HostConfig } from '../hosts/model.js';
import { AppError } from '../http/errors.js';
import { BUILTIN_AGENTS, isBuiltinAgentId } from './builtin.js';
import { agentInstallSpec, agentPathSlug } from './model.js';
import type { AgentDefinition, AgentInstallSpec, AgentView } from './model.js';

export interface AgentRegistryDeps {
  config: ConfigStore;
  log: Logger;
}

export class AgentRegistry {
  constructor(private readonly deps: AgentRegistryDeps) {}

  /** built-ins first, then custom definitions, both in declaration order */
  list(): AgentView[] {
    const custom = this.deps.config.listCustomAgents();
    return [
      ...BUILTIN_AGENTS.map((a) => ({ ...a, builtin: true })),
      ...custom.filter((a) => !isBuiltinAgentId(a.id)).map((a) => ({ ...a, builtin: false })),
    ];
  }

  get(id: string): AgentDefinition | null {
    return this.list().find((a) => a.id === id) ?? null;
  }

  /** @throws AppError.notFound(`unknown agent '<id>'`) */
  require(id: string): AgentDefinition {
    const def = this.get(id);
    if (!def) throw AppError.notFound(`unknown agent '${id}'`);
    return def;
  }

  isBuiltin(id: string): boolean {
    return isBuiltinAgentId(id);
  }

  /**
   * Create a custom agent. `409 conflict` when the id is taken (built-in or custom);
   * `422` when two sharedPaths of the definition produce the same `agentPathSlug()`, which
   * would make them the same directory inside the auth volume.
   */
  async create(def: AgentDefinition): Promise<AgentView> {
    if (this.get(def.id)) {
      throw AppError.conflict(
        this.isBuiltin(def.id)
          ? `'${def.id}' is a built-in agent id and cannot be reused`
          : `agent '${def.id}' already exists`,
      );
    }
    assertDistinctSharedPaths(def);
    const stored = await this.deps.config.putCustomAgent(def);
    this.deps.log.info({ agentId: stored.id }, 'custom agent created');
    return { ...stored, builtin: false };
  }

  /** Custom agents only (`409` for a built-in); `id` is immutable. */
  async update(id: string, def: AgentDefinition): Promise<AgentView> {
    if (this.isBuiltin(id)) throw AppError.conflict(`the built-in agent '${id}' cannot be edited`);
    const current = this.deps.config.listCustomAgents().find((a) => a.id === id);
    if (!current) throw AppError.notFound(`unknown agent '${id}'`);
    if (def.id !== id) throw AppError.validation('the id of an agent is immutable');
    assertDistinctSharedPaths(def);
    const stored = await this.deps.config.putCustomAgent(def);
    this.deps.log.info({ agentId: id }, 'custom agent updated');
    return { ...stored, builtin: false };
  }

  /**
   * Custom agents only. `409 conflict` while a host still enables it or a session still
   * pins it, unless `force` (which also strips the id from those hosts/sessions).
   */
  async remove(id: string, opts?: { force?: boolean }): Promise<void> {
    if (this.isBuiltin(id)) throw AppError.conflict(`the built-in agent '${id}' cannot be deleted`);
    const current = this.deps.config.listCustomAgents().find((a) => a.id === id);
    if (!current) throw AppError.notFound(`unknown agent '${id}'`);

    const cfg = this.deps.config.get();
    const hostIds = cfg.hosts.filter((h) => h.agents.enabled.includes(id)).map((h) => h.id);
    const sessions = cfg.sessions.filter((s) => s.agents?.includes(id)).map((s) => s.name);

    if ((hostIds.length > 0 || sessions.length > 0) && !opts?.force) {
      throw AppError.conflict(
        `agent '${id}' is still used by ${hostIds.length} host(s) and ${sessions.length} session(s) — repeat with ?force=1 to remove it everywhere`,
        { hostIds, sessions },
      );
    }

    await this.deps.config.update((draft) => {
      draft.agents.custom = draft.agents.custom.filter((a) => a.id !== id);
      for (const host of draft.hosts) {
        host.agents.enabled = host.agents.enabled.filter((a) => a !== id);
      }
      for (const session of draft.sessions) {
        if (session.agents) session.agents = session.agents.filter((a) => a !== id);
      }
    });
    this.deps.log.info({ agentId: id, hostIds, sessions }, 'custom agent removed');
  }

  /** Definitions of `host.agents.enabled`, skipping ids that no longer exist. */
  enabledForHost(host: HostConfig): AgentDefinition[] {
    return this.resolve(host.agents.enabled);
  }

  /**
   * The agents a session really gets: `session.agents ?? host.agents.enabled`, filtered to
   * ids that still exist. THE function sessions/container.ts uses to build mounts, so its
   * result is what the spec hash covers.
   */
  resolveForSession(host: HostConfig, session: { agents: string[] | null }): AgentDefinition[] {
    return this.resolve(session.agents ?? host.agents.enabled);
  }

  /** What the tools populate container installs on this host (PORTERCLAUDE_AGENTS). */
  installSpecsForHost(host: HostConfig): AgentInstallSpec[] {
    return this.enabledForHost(host).map((def) => agentInstallSpec(def));
  }

  /** known ids only, de-duplicated and sorted by id (stable input for the spec hash). */
  private resolve(ids: string[]): AgentDefinition[] {
    const known = new Map(this.list().map((a) => [a.id, a as AgentDefinition]));
    const out: AgentDefinition[] = [];
    for (const id of new Set(ids)) {
      const def = known.get(id);
      if (def) out.push(def);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
}

/**
 * Two shared paths that slugify to the same name would be the same directory inside the
 * agent's auth volume — the second symlink would silently point at the first one's data.
 */
function assertDistinctSharedPaths(def: AgentDefinition): void {
  const seen = new Map<string, string>();
  for (const sp of def.sharedPaths) {
    const slug = agentPathSlug(sp.path);
    const first = seen.get(slug);
    if (first) {
      throw AppError.validation(
        `sharedPaths '${first}' and '${sp.path}' both map to '${slug}' inside the agent volume — give them different names`,
        { slug, paths: [first, sp.path] },
      );
    }
    seen.set(slug, sp.path);
  }
}
