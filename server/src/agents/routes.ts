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
import { HostIdParamsSchema, HostAgentsInputSchema } from '../hosts/model.js';
import { AgentDefinitionInputSchema, AgentIdSchema } from './model.js';

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
 * TODO(B1): merge three sources into HostAgentView[]:
 *   ctx.agents.list()                     definitions (+ builtin flag)
 *   host.agents.enabled                   enabled flag + authVolume (agentAuthVolumeFor)
 *   ctx.images.agentStatuses(hostId)      installed / version / installedAt / error
 * A failing tools read must degrade to installed:false + error, never a 502 — the panel has
 * to render for an unreachable host too.
 */
export function createHostAgentsRouter(ctx: AppContext): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { hostId } = parseParams(HostIdParamsSchema, req);
      void ctx;
      void hostId;
      void res;
      throw new Error('TODO(B1): GET /api/hosts/:hostId/agents');
    }),
  );

  router.put(
    '/',
    asyncHandler(async (req, res) => {
      const { hostId } = parseParams(HostIdParamsSchema, req);
      const input = parseBody(HostAgentsInputSchema, req);
      void ctx;
      void hostId;
      void input;
      void res;
      throw new Error('TODO(B1): PUT /api/hosts/:hostId/agents');
    }),
  );

  return router;
}

function notFoundAgent(id: string): Error {
  // TODO(B1): AppError.notFound(`unknown agent '${id}'`)
  return new Error(`unknown agent '${id}'`);
}
