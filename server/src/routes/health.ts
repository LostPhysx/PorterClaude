// OWNER: B1. PUBLIC (no auth). Must never leak secrets or backend errors in detail.
import { Router } from 'express';
import type { AppContext } from '../context.js';

export interface HealthResponse {
  status: 'ok';
  version: string;
  uptimeSec: number;
  /** v0.2: one global backend became N hosts; this is the summary the healthcheck needs */
  hosts: { count: number; configured: boolean; defaultHostId: string | null };
}

/**
 * GET /api/health -> 200 HealthResponse   (always 200 while the process is alive;
 *                                          docker healthcheck relies on this)
 */
export function createHealthRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    let count = 0;
    let configured = false;
    let defaultHostId: string | null = null;
    try {
      count = ctx.config.get().hosts.length;
      defaultHostId = ctx.config.get().defaultHostId;
      configured = ctx.hosts.isConfigured();
    } catch {
      // never fail the healthcheck because of a config/host problem
    }
    const body: HealthResponse = {
      status: 'ok',
      version: ctx.version,
      uptimeSec: Math.max(0, Math.floor((Date.now() - ctx.startedAt) / 1000)),
      hosts: { count, configured, defaultHostId },
    };
    res.json(body);
  });

  return router;
}
