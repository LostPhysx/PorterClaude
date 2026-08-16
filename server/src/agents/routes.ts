// OWNER: B1. Two routers:
//   createAgentsRouter      -> /api/agents                  (definitions: built-in + custom)
//   createHostAgentsRouter  -> /api/hosts/:hostId/agents    (per-host enable + install state)
//
// The per-host router needs `mergeParams: true` to see `:hostId` from its mount path.
// The INSTALLED/version half of a HostAgentView comes from the tools volume, i.e. from B2's
// ImageService.agentStatuses(hostId) — this router only merges it with the definitions and
// the host's enabled list.
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../http/async.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import { AppError } from '../http/errors.js';
import { HostIdParamsSchema, HostAgentsInputSchema } from '../hosts/model.js';
import { AgentDefinitionInputSchema, AgentIdSchema, agentAuthVolumeFor } from './model.js';
import type { HostAgentView } from './model.js';
import type { AgentToolStatus } from '../images/service.js';

const AgentParams = z.object({ id: AgentIdSchema });

const boolish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return false;
    if (typeof v === 'boolean') return v;
    return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  });

const RemoveQuery = z.object({ force: boolish });

/**
 * GET    /api/agents            -> { agents: AgentView[] }        (built-in + custom)
 * POST   /api/agents            AgentDefinition -> 201 { agent: AgentView }
 * GET    /api/agents/:id        -> { agent: AgentView }
 * PUT    /api/agents/:id        AgentDefinition -> { agent: AgentView }   (custom only)
 * DELETE /api/agents/:id?force=1 -> 204                                   (custom only)
 */
export function createAgentsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json({ agents: ctx.agents.list() });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const def = parseBody(AgentDefinitionInputSchema, req);
      res.status(201).json({ agent: await ctx.agents.create(def) });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(AgentParams, req);
      const agent = ctx.agents.list().find((a) => a.id === id);
      if (!agent) throw notFoundAgent(id);
      res.json({ agent });
    }),
  );

  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(AgentParams, req);
      const def = parseBody(AgentDefinitionInputSchema, req);
      res.json({ agent: await ctx.agents.update(id, def) });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(AgentParams, req);
      const { force } = parseQuery(RemoveQuery, req);
      await ctx.agents.remove(id, { force });
      res.status(204).end();
    }),
  );

  return router;
}

/**
 * GET /api/hosts/:hostId/agents  -> { agents: HostAgentView[], enabled: string[] }
 * PUT /api/hosts/:hostId/agents  { enabled: string[] } -> { agents: HostAgentView[], enabled }
 *
 * A HostAgentView merges three sources:
 *   ctx.agents.list()                     definitions (+ builtin flag)
 *   host.agents.enabled                   enabled flag + authVolume (agentAuthVolumeFor)
 *   ctx.images.agentStatuses(hostId)      installed / version / installedAt / error
 * A failing tools read degrades to installed:false + an error string, never a 502 — the
 * panel has to render for an unreachable host too.
 */
export function createHostAgentsRouter(ctx: AppContext): Router {
  const router = Router({ mergeParams: true });

  const render = async (hostId: string): Promise<{ agents: HostAgentView[]; enabled: string[] }> => {
    const host = ctx.hosts.require(hostId);
    const settings = ctx.hosts.settingsForHost(host);
    const enabled = new Set(host.agents.enabled);

    let statuses = new Map<string, AgentToolStatus>();
    let readError: string | null = null;
    try {
      statuses = new Map((await ctx.images.agentStatuses(hostId)).map((s) => [s.id, s]));
    } catch (err) {
      // an unreachable host / missing tools volume must not break the panel
      readError = (err as Error).message;
      ctx.log.debug({ hostId, err: readError }, 'reading the tools manifest of a host failed');
    }

    const agents: HostAgentView[] = ctx.agents.list().map((agent) => {
      const status = statuses.get(agent.id);
      return {
        ...agent,
        enabled: enabled.has(agent.id),
        installed: status?.installed ?? false,
        version: status?.version ?? null,
        installedAt: status?.installedAt ?? null,
        error: status?.error ?? readError,
        authVolume: agentAuthVolumeFor(settings.volumePrefix, agent.id),
      };
    });
    return { agents, enabled: [...host.agents.enabled] };
  };

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { hostId } = parseParams(HostIdParamsSchema, req);
      res.json(await render(hostId));
    }),
  );

  router.put(
    '/',
    asyncHandler(async (req, res) => {
      const { hostId } = parseParams(HostIdParamsSchema, req);
      const input = parseBody(HostAgentsInputSchema, req);
      ctx.hosts.require(hostId);
      const unknown = input.enabled.filter((id) => !ctx.agents.get(id));
      if (unknown.length > 0) {
        throw AppError.validation(`unknown agent id(s): ${unknown.join(', ')}`, { unknown });
      }
      await ctx.hosts.setEnabledAgents(hostId, input.enabled);
      res.json(await render(hostId));
    }),
  );

  return router;
}

function notFoundAgent(id: string): Error {
  return AppError.notFound(`unknown agent '${id}'`);
}
