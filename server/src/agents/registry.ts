// OWNER: B1. Public API FROZEN — B2 uses `require()`, `enabledForHost()`,
// `resolveForSession()` and `installSpecsForHost()`; nothing else.
//
// The registry is the union of the built-ins (agents/builtin.ts) and the custom definitions
// stored in `config.agents.custom`. Ids are globally unique: a custom agent may not reuse a
// built-in id (409), so `list()` never has to resolve a collision.
import type { ConfigStore } from '../config/store.js';
import type { Logger } from '../logger.js';
import type { HostConfig } from '../hosts/model.js';
import type { AgentDefinition, AgentInstallSpec, AgentView } from './model.js';

export interface AgentRegistryDeps {
  config: ConfigStore;
  log: Logger;
}

export class AgentRegistry {
  constructor(private readonly deps: AgentRegistryDeps) {}

  /** built-ins first, then custom definitions, both in declaration order */
  list(): AgentView[] {
    throw new Error('TODO(B1): list');
  }

  get(id: string): AgentDefinition | null {
    void id;
    throw new Error('TODO(B1): get');
  }

  /** @throws AppError.notFound(`unknown agent '<id>'`) */
  require(id: string): AgentDefinition {
    void id;
    throw new Error('TODO(B1): require');
  }

  isBuiltin(id: string): boolean {
    void id;
    throw new Error('TODO(B1): isBuiltin');
  }

  /**
   * Create a custom agent. `409 conflict` when the id is taken (built-in or custom);
   * `422` when two sharedPaths of the definition produce the same `agentPathSlug()`, which
   * would make them the same directory inside the auth volume.
   */
  async create(def: AgentDefinition): Promise<AgentView> {
    void def;
    throw new Error('TODO(B1): create');
  }

  /** Custom agents only (`409` for a built-in); `id` is immutable. */
  async update(id: string, def: AgentDefinition): Promise<AgentView> {
    void id;
    void def;
    throw new Error('TODO(B1): update');
  }

  /**
   * Custom agents only. `409 conflict` while a host still enables it or a session still
   * pins it, unless `force` (which also strips the id from those hosts/sessions).
   */
  async remove(id: string, opts?: { force?: boolean }): Promise<void> {
    void id;
    void opts;
    throw new Error('TODO(B1): remove');
  }

  /** Definitions of `host.agents.enabled`, skipping ids that no longer exist. */
  enabledForHost(host: HostConfig): AgentDefinition[] {
    void host;
    throw new Error('TODO(B1): enabledForHost');
  }

  /**
   * The agents a session really gets: `session.agents ?? host.agents.enabled`, filtered to
   * ids that still exist. THE function sessions/container.ts uses to build mounts, so its
   * result is what the spec hash covers.
   */
  resolveForSession(host: HostConfig, session: { agents: string[] | null }): AgentDefinition[] {
    void host;
    void session;
    throw new Error('TODO(B1): resolveForSession');
  }

  /** What the tools populate container installs on this host (PORTERCLAUDE_AGENTS). */
  installSpecsForHost(host: HostConfig): AgentInstallSpec[] {
    void host;
    throw new Error('TODO(B1): installSpecsForHost');
  }
}
