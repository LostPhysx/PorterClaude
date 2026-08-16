// OWNER: B2. Mounted at /api/sessions behind requireAuth (see routes/index.ts).
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../http/async.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import { SessionInputSchema, SessionNameSchema } from './model.js';

const NameParams = z.object({ name: SessionNameSchema });

const boolish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return false;
    if (typeof v === 'boolean') return v;
    return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  });

const RemoveQuery = z.object({ removeVolumes: boolish });

/** v0.2: optional host filter for the list; session NAMES stay globally unique. */
const ListQuery = z.object({ hostId: z.string().min(1).max(32).optional() });

const LogsQuery = z.object({
  tail: z.coerce.number().int().min(1).max(10_000).optional().default(200),
  timestamps: boolish,
});

/**
 * v0.2: sessions stay FLAT (no /api/hosts/:hostId prefix) because a session name is unique
 * across hosts - that is also what lets the terminal websocket route session -> host with
 * nothing but the name. The host is part of the body (create only, immutable afterwards)
 * and of every SessionView.
 *
 * GET    /api/sessions?hostId=<id>     -> { sessions: SessionView[] }
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
 * POST   /api/sessions/reconcile?hostId=<id> -> { report: ReconcileReport }
 *                                       (every host, or just one)
 */
export function createSessionsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { hostId } = parseQuery(ListQuery, req);
      const sessions = await ctx.sessions.list(hostId ? { hostId } : undefined);
      res.json({ sessions });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = parseBody(SessionInputSchema, req);
      const session = await ctx.sessions.create(input);
      res.status(201).json({ session });
    }),
  );

  // literal route: MUST be registered before '/:name'
  router.post(
    '/reconcile',
    asyncHandler(async (req, res) => {
      // explicit user action: adopt orphans (the startup reconcile does not, so an
      // orphan stays visible instead of being silently rewritten)
      const { hostId } = parseQuery(ListQuery, req);
      const report = await ctx.sessions.reconcile({ adopt: true, ...(hostId ? { hostId } : {}) });
      res.json({ report });
    }),
  );

  router.get(
    '/:name',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      res.json({ session: await ctx.sessions.get(name) });
    }),
  );

  router.put(
    '/:name',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      const input = parseBody(SessionInputSchema, req);
      res.json({ session: await ctx.sessions.update(name, input) });
    }),
  );

  router.delete(
    '/:name',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      const { removeVolumes } = parseQuery(RemoveQuery, req);
      await ctx.sessions.remove(name, { removeVolumes });
      res.status(204).end();
    }),
  );

  router.post(
    '/:name/start',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      res.json({ session: await ctx.sessions.start(name) });
    }),
  );

  router.post(
    '/:name/stop',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      res.json({ session: await ctx.sessions.stop(name) });
    }),
  );

  router.post(
    '/:name/restart',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      res.json({ session: await ctx.sessions.restart(name) });
    }),
  );

  router.post(
    '/:name/recreate',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      res.json({ session: await ctx.sessions.recreate(name) });
    }),
  );

  router.get(
    '/:name/logs',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      const { tail, timestamps } = parseQuery(LogsQuery, req);
      const logs = await ctx.sessions.logs(name, { tail, timestamps });
      res.json({ logs });
    }),
  );

  return router;
}
