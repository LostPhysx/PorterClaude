// OWNER: B1. Mounted at /api/hosts behind requireAuth (see routes/index.ts).
//
// NOTE the mount order in routes/index.ts: `/api/hosts/:hostId/images`,
// `/api/hosts/:hostId/docker` and `/api/hosts/:hostId/agents` are mounted BEFORE this
// router, so nothing here can shadow them.
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../http/async.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import {
  HostIdParamsSchema,
  HostInputSchema,
  HostTestInputSchema,
  HostUpdateInputSchema,
} from './model.js';

const boolish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return false;
    if (typeof v === 'boolean') return v;
    return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  });

const ListQuery = z.object({ probe: boolish });
const RemoveQuery = z.object({ force: boolish });

/**
 * GET    /api/hosts?probe=1          -> { hosts: HostView[], defaultHostId }
 * POST   /api/hosts                  HostInput -> 201 { host: HostView }
 * POST   /api/hosts/test             HostTestInput -> BackendTestResult (always 200, nothing saved)
 * GET    /api/hosts/:hostId          -> { host: HostView }   (always probes)
 * PUT    /api/hosts/:hostId          HostUpdateInput -> { host: HostView }
 * DELETE /api/hosts/:hostId?force=1  -> 204   (409 while containers reference it)
 * POST   /api/hosts/:hostId/default  -> { host: HostView, defaultHostId }
 * POST   /api/hosts/:hostId/test     -> BackendTestResult (always 200)
 * GET    /api/hosts/:hostId/info     -> { info: DockerInfo }
 */
export function createHostsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { probe } = parseQuery(ListQuery, req);
      const hosts = await ctx.hosts.views({ probe });
      res.json({ hosts, defaultHostId: ctx.hosts.defaultHostId() });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = parseBody(HostInputSchema, req);
      const host = await ctx.hosts.create(input);
      res.status(201).json({ host: await ctx.hosts.view(host.id, { probe: true }) });
    }),
  );

  // literal route: MUST be registered before '/:hostId'
  router.post(
    '/test',
    asyncHandler(async (req, res) => {
      const input = parseBody(HostTestInputSchema, req);
      res.json(await ctx.hosts.testConnection(input.connection, { ...(input.apiKey ? { apiKey: input.apiKey } : {}) }));
    }),
  );

  router.get(
    '/:hostId',
    asyncHandler(async (req, res) => {
      const { hostId } = parseParams(HostIdParamsSchema, req);
      res.json({ host: await ctx.hosts.view(hostId, { probe: true }) });
    }),
  );

  router.put(
    '/:hostId',
    asyncHandler(async (req, res) => {
      const { hostId } = parseParams(HostIdParamsSchema, req);
      const input = parseBody(HostUpdateInputSchema, req);
      const host = await ctx.hosts.update(hostId, input);
      res.json({ host: await ctx.hosts.view(host.id, { probe: true }) });
    }),
  );

  router.delete(
    '/:hostId',
    asyncHandler(async (req, res) => {
      const { hostId } = parseParams(HostIdParamsSchema, req);
      const { force } = parseQuery(RemoveQuery, req);
      await ctx.hosts.remove(hostId, { force });
      res.status(204).end();
    }),
  );

  router.post(
    '/:hostId/default',
    asyncHandler(async (req, res) => {
      const { hostId } = parseParams(HostIdParamsSchema, req);
      const host = await ctx.hosts.setDefault(hostId);
      res.json({ host: await ctx.hosts.view(host.id), defaultHostId: ctx.hosts.defaultHostId() });
    }),
  );

  router.post(
    '/:hostId/test',
    asyncHandler(async (req, res) => {
      const { hostId } = parseParams(HostIdParamsSchema, req);
      res.json(await ctx.hosts.test(hostId));
    }),
  );

  router.get(
    '/:hostId/info',
    asyncHandler(async (req, res) => {
      const { hostId } = parseParams(HostIdParamsSchema, req);
      res.json({ info: await ctx.hosts.info(hostId) });
    }),
  );

  return router;
}
