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
 * TODO(B1)
 */
export function createHealthRouter(ctx: AppContext): Router {
  throw new Error('TODO(B1): implement createHealthRouter');
}
