// OWNER: B2. Mounted at /api/images behind requireAuth (see routes/index.ts).
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../http/async.js';
import { AppError } from '../http/errors.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';

const RecipeParams = z.object({ name: z.string().min(1).max(64) });
const JobParams = z.object({ id: z.string().min(1).max(64) });
const SinceQuery = z.object({ since: z.coerce.number().int().min(0).optional().default(0) });
const BuildBody = z.object({ noCache: z.boolean().optional(), pull: z.boolean().optional() }).default({});
const SyncBody = z.object({ force: z.boolean().optional() }).default({});
const ImageBody = z.object({ image: z.string().min(1).max(400) });

/**
 * GET  /api/images                       -> { images: ImageSummary[] }
 * GET  /api/images/recipes               -> { recipes: RecipeStatus[] }
 * POST /api/images/recipes/:name/build   { noCache?, pull? } -> 202 { job: JobSummary }
 * GET  /api/images/jobs                  -> { jobs: JobSummary[] }
 * GET  /api/images/jobs/:id?since=<n>    -> { job, lines, nextIndex }
 * POST /api/images/jobs/:id/cancel       -> { job: JobSummary }
 * GET  /api/images/tools                 -> { status: ToolsStatus }
 * POST /api/images/tools/sync            { force? } -> 202 { job: JobSummary }
 * POST /api/images/custom/validate       { image } -> { result: CustomImageCheck }
 * POST /api/images/pull                  { image } -> 202 { job: JobSummary }
 */
export function createImagesRouter(ctx: AppContext): Router {
  const router = Router();

  // --- literal segments first ---------------------------------------------
  router.get(
    '/recipes',
    asyncHandler(async (_req, res) => {
      res.json({ recipes: await ctx.images.recipeStatuses() });
    }),
  );

  router.post(
    '/recipes/:name/build',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(RecipeParams, req);
      const body = parseBody(BuildBody, req);
      const job = await ctx.images.buildRecipe(name, body);
      res.status(202).json({ job });
    }),
  );

  router.get(
    '/jobs',
    asyncHandler(async (_req, res) => {
      res.json({ jobs: ctx.images.listJobs() });
    }),
  );

  router.get(
    '/jobs/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(JobParams, req);
      const { since } = parseQuery(SinceQuery, req);
      const job = ctx.images.getJob(id);
      if (!job) throw AppError.notFound(`job '${id}' does not exist`);
      const { lines, nextIndex } = ctx.images.getJobLines(id, since);
      res.json({ job, lines, nextIndex });
    }),
  );

  router.post(
    '/jobs/:id/cancel',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(JobParams, req);
      res.json({ job: ctx.images.cancelJob(id) });
    }),
  );

  router.get(
    '/tools',
    asyncHandler(async (_req, res) => {
      res.json({ status: await ctx.images.toolsStatus() });
    }),
  );

  router.post(
    '/tools/sync',
    asyncHandler(async (req, res) => {
      const body = parseBody(SyncBody, req);
      const job = await ctx.images.syncTools(body);
      res.status(202).json({ job });
    }),
  );

  router.post(
    '/custom/validate',
    asyncHandler(async (req, res) => {
      const { image } = parseBody(ImageBody, req);
      res.json({ result: await ctx.images.validateCustomImage(image) });
    }),
  );

  router.post(
    '/pull',
    asyncHandler(async (req, res) => {
      const { image } = parseBody(ImageBody, req);
      res.status(202).json({ job: await ctx.images.pull(image) });
    }),
  );

  // --- the bare list last --------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json({ images: await ctx.images.listImages() });
    }),
  );

  return router;
}
