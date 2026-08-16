// OWNER: B1. Thin read-only passthroughs the UI needs outside of Sessions/Images.
// v0.2: host-scoped — mounted at /api/hosts/:hostId/docker (routes/index.ts), so the router
// is created with `mergeParams: true` and resolves the host on every call.
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../http/async.js';
import { parseParams, parseQuery } from '../http/validate.js';
import { CONTAINER_LABELS } from '../sessions/model.js';
import { HostIdParamsSchema } from '../hosts/model.js';

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
 * GET /api/hosts/:hostId/docker/info        -> { info: DockerInfo }
 * GET /api/hosts/:hostId/docker/containers  -> { containers: ContainerSummary[] }  (?all=1, ?managed=1)
 * GET /api/hosts/:hostId/docker/volumes     -> { volumes: VolumeSummary[] }
 * GET /api/hosts/:hostId/docker/networks    -> { networks: NetworkSummary[] }
 * 404 for an unknown host, 409 backend_not_configured when the host connection is incomplete.
 */
export function createDockerRouter(ctx: AppContext): Router {
  const router = Router({ mergeParams: true });

  const backend = (req: Request) => {
    const { hostId } = parseParams(HostIdParamsSchema, req);
    return ctx.hosts.backendFor(hostId);
  };

  router.get(
    '/info',
    asyncHandler(async (req, res) => {
      res.json({ info: await backend(req).info() });
    }),
  );

  router.get(
    '/containers',
    asyncHandler(async (req, res) => {
      const q = parseQuery(ContainersQuerySchema, req);
      const containers = await backend(req).listContainers({
        all: q.all ?? true,
        labelFilters: q.managed ? { [CONTAINER_LABELS.managed]: 'true' } : undefined,
      });
      res.json({ containers });
    }),
  );

  router.get(
    '/volumes',
    asyncHandler(async (req, res) => {
      res.json({ volumes: await backend(req).listVolumes() });
    }),
  );

  router.get(
    '/networks',
    asyncHandler(async (req, res) => {
      res.json({ networks: await backend(req).listNetworks() });
    }),
  );

  return router;
}
