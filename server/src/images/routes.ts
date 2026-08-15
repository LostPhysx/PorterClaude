// OWNER: B2. Mounted at /api/images behind requireAuth (see routes/index.ts).
import { Router } from 'express';
import type { AppContext } from '../context.js';

/**
 * GET  /api/images                       -> { images: ImageSummary[] }         (docker image list)
 * GET  /api/images/recipes               -> { recipes: RecipeStatus[] }
 * POST /api/images/recipes/:name/build   { noCache?, pull? } -> 202 { job: JobSummary }
 *                                          409 when a build for that recipe is running
 * GET  /api/images/jobs                  -> { jobs: JobSummary[] }
 * GET  /api/images/jobs/:id?since=<n>    -> { job: JobSummary, lines: string[], nextIndex: number }
 *                                          (poll for live build output -- no websocket)
 * POST /api/images/jobs/:id/cancel       -> { job: JobSummary }
 * GET  /api/images/tools                 -> { status: ToolsStatus }
 * POST /api/images/tools/sync            { force? } -> 202 { job: JobSummary }
 * POST /api/images/custom/validate       { image } -> { result: CustomImageCheck }
 * POST /api/images/pull                  { image } -> 202 { job: JobSummary }
 *
 * NOTE: register /recipes, /jobs, /tools, /custom, /pull before any parameter route.
 * TODO(B2)
 */
export function createImagesRouter(ctx: AppContext): Router {
  throw new Error('TODO(B2): implement createImagesRouter');
}
