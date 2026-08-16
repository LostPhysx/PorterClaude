// OWNER: B1. Thin read-only passthroughs the UI needs outside of Sessions/Images.
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../http/async.js';
import { parseQuery } from '../http/validate.js';
import { CONTAINER_LABELS } from '../sessions/model.js';

const flag = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    if (v === undefined) return undefined;
    return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  });

const ContainersQuerySchema = z.object({ all: flag, managed: flag });

/**
 * GET /api/docker/info        -> { info: DockerInfo }
 * GET /api/docker/containers  -> { containers: ContainerSummary[] }   (?all=1, ?managed=1)
 * GET /api/docker/volumes     -> { volumes: VolumeSummary[] }
 * GET /api/docker/networks    -> { networks: NetworkSummary[] }
 * All require auth (mounted behind the gate) and 409 backend_not_configured when there is
 * no backend.
 */
export function createDockerRouter(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/info',
    asyncHandler(async (_req, res) => {
      res.json({ info: await ctx.backends.get().info() });
    }),
  );

  router.get(
    '/containers',
    asyncHandler(async (req, res) => {
      const q = parseQuery(ContainersQuerySchema, req);
      const containers = await ctx.backends.get().listContainers({
        all: q.all ?? true,
        labelFilters: q.managed ? { [CONTAINER_LABELS.managed]: 'true' } : undefined,
      });
      res.json({ containers });
    }),
  );

  router.get(
    '/volumes',
    asyncHandler(async (_req, res) => {
      res.json({ volumes: await ctx.backends.get().listVolumes() });
    }),
  );

  router.get(
    '/networks',
    asyncHandler(async (_req, res) => {
      res.json({ networks: await ctx.backends.get().listNetworks() });
    }),
  );

  return router;
}
