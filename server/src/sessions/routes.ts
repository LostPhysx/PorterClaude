// OWNER: B2. Mounted at /api/sessions behind requireAuth (see routes/index.ts).
import { Router } from 'express';
import type { AppContext } from '../context.js';

/**
 * GET    /api/sessions                 -> { sessions: SessionView[] }
 * POST   /api/sessions                 SessionInput -> 201 { session: SessionView }
 *                                       409 conflict when the name is taken
 * GET    /api/sessions/:name           -> { session: SessionView }
 * PUT    /api/sessions/:name           SessionInput -> { session: SessionView }  (recreates)
 * DELETE /api/sessions/:name?removeVolumes=1 -> 204
 * POST   /api/sessions/:name/start     -> { session: SessionView }
 * POST   /api/sessions/:name/stop      -> { session: SessionView }
 * POST   /api/sessions/:name/restart   -> { session: SessionView }
 * POST   /api/sessions/:name/recreate  -> { session: SessionView }
 * GET    /api/sessions/:name/logs?tail=200&timestamps=0 -> { logs: string }
 * POST   /api/sessions/reconcile       -> { report: ReconcileReport }
 *
 * Use parseBody/parseParams/parseQuery from http/validate.js and asyncHandler from
 * http/async.js so errors reach the canonical envelope. NOTE: register the literal
 * /reconcile route BEFORE /:name so it is not swallowed by the parameter route.
 * TODO(B2)
 */
export function createSessionsRouter(ctx: AppContext): Router {
  throw new Error('TODO(B2): implement createSessionsRouter');
}
