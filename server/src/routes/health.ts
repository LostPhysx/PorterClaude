// OWNER: B1. PUBLIC (no auth). Must never leak secrets or backend errors in detail.
import { Router } from 'express';
import type { AppContext } from '../context.js';

export interface HealthResponse {
  status: 'ok';
  version: string;
  uptimeSec: number;
  backend: { kind: 'portainer' | 'socket' | 'none'; configured: boolean };
}

/**
 * GET /api/health -> 200 HealthResponse   (always 200 while the process is alive;
 *                                          docker healthcheck relies on this)
 */
export function createHealthRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    let kind: HealthResponse['backend']['kind'] = 'none';
    let configured = false;
    try {
      kind = ctx.config.get().backend.kind;
      configured = ctx.backends.isConfigured();
    } catch {
      // never fail the healthcheck because of a config/backend problem
    }
    const body: HealthResponse = {
      status: 'ok',
      version: ctx.version,
      uptimeSec: Math.max(0, Math.floor((Date.now() - ctx.startedAt) / 1000)),
      backend: { kind, configured },
    };
    res.json(body);
  });

  return router;
}
