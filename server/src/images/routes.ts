// OWNER: B2. Mounted at /api/hosts/:hostId/images behind requireAuth (routes/index.ts), so
// the router is created with `mergeParams: true` and resolves the host on every call.
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../http/async.js';
import { AppError } from '../http/errors.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import { HostIdParamsSchema } from '../hosts/model.js';

const RecipeParams = z.object({ name: z.string().min(1).max(64) });
const JobParams = z.object({ id: z.string().min(1).max(64) });
const SinceQuery = z.object({ since: z.coerce.number().int().min(0).optional().default(0) });
const BuildBody = z
  .object({
    noCache: z.boolean().optional(),
    pull: z.boolean().optional(),
    /** build even when the context hash still matches the built image */
    force: z.boolean().optional(),
  })
  .default({});
const SyncBody = z.object({ force: z.boolean().optional() }).default({});
const ImageBody = z.object({ image: z.string().min(1).max(400) });

/**
 * All paths below are relative to /api/hosts/:hostId/images (v0.2 — every image, job and
 * tools operation belongs to exactly one host):
 *
 * GET  .                        -> { images: ImageSummary[] }
 * GET  ./recipes                -> { recipes: RecipeStatus[] }
 * POST ./recipes/:name/build    { noCache?, pull?, force? } -> 202 { job: JobSummary }
 *   (a build whose context hash still matches the built image is skipped unless forced)
 * GET  ./jobs                   -> { jobs: JobSummary[] }        (this host only)
 * GET  ./jobs/:id?since=<n>     -> { job, lines, nextIndex }
 * POST ./jobs/:id/cancel        -> { job: JobSummary }
 * GET  ./tools                  -> { status: ToolsStatus }       (incl. per-agent state)
 * POST ./tools/sync             { force? } -> 202 { job: JobSummary }
 * POST ./custom/validate        { image } -> { result: CustomImageCheck }
 * POST ./pull                   { image } -> 202 { job: JobSummary }
 */
export function createImagesRouter(ctx: AppContext): Router {
  const router = Router({ mergeParams: true });

  /**
   * The host of this request. `hosts.require` is what makes an UNKNOWN host id a 404 on every
   * route of this router (api.md: "host-scoped URLs: an unknown id is 404 not_found") - the
   * service layer only enforces it where it needs settings or a transport, so a pure
   * in-memory route like GET ./jobs would otherwise answer 200 with an empty list.
   */
  const host = (req: Request): string => ctx.hosts.require(parseParams(HostIdParamsSchema, req).hostId).id;

  // --- literal segments first ---------------------------------------------
  router.get(
    '/recipes',
    asyncHandler(async (req, res) => {
      res.json({ recipes: await ctx.images.recipeStatuses(host(req)) });
    }),
  );

  router.post(
    '/recipes/:name/build',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(RecipeParams, req);
      const body = parseBody(BuildBody, req);
      const job = await ctx.images.buildRecipe(host(req), name, body);
      res.status(202).json({ job });
    }),
  );

  router.get(
    '/jobs',
    asyncHandler(async (req, res) => {
      res.json({ jobs: ctx.images.listJobs(host(req)) });
    }),
  );

  router.get(
    '/jobs/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(JobParams, req);
      const { since } = parseQuery(SinceQuery, req);
      // host-scoped on purpose: a job of ANOTHER host does not exist for this one (404)
      const hostId = host(req);
      const job = ctx.images.getJob(id, hostId);
      if (!job) throw AppError.notFound(`job '${id}' does not exist`);
      const { lines, nextIndex } = ctx.images.getJobLines(id, since, hostId);
      res.json({ job, lines, nextIndex });
    }),
  );

  router.post(
    '/jobs/:id/cancel',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(JobParams, req);
      res.json({ job: ctx.images.cancelJob(id, host(req)) });
    }),
  );

  router.get(
    '/tools',
    asyncHandler(async (req, res) => {
      res.json({ status: await ctx.images.toolsStatus(host(req)) });
    }),
  );

  router.post(
    '/tools/sync',
    asyncHandler(async (req, res) => {
      const body = parseBody(SyncBody, req);
      const job = await ctx.images.syncTools(host(req), body);
      res.status(202).json({ job });
    }),
  );

  router.post(
    '/custom/validate',
    asyncHandler(async (req, res) => {
      const { image } = parseBody(ImageBody, req);
      res.json({ result: await ctx.images.validateCustomImage(host(req), image) });
    }),
  );

  router.post(
    '/pull',
    asyncHandler(async (req, res) => {
      const { image } = parseBody(ImageBody, req);
      res.status(202).json({ job: await ctx.images.pull(host(req), image) });
    }),
  );

  // --- the bare list last --------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json({ images: await ctx.images.listImages(host(req)) });
    }),
  );

  return router;
}
