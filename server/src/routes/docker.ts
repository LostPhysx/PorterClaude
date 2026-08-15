// OWNER: B1. Thin read-only passthroughs the UI needs outside of Sessions/Images.
import { Router } from 'express';
import type { AppContext } from '../context.js';

/**
 * GET /api/docker/info        -> DockerInfo
 * GET /api/docker/containers  -> ContainerSummary[]   (?all=1, ?managed=1)
 * GET /api/docker/volumes     -> VolumeSummary[]
 * GET /api/docker/networks    -> NetworkSummary[]
 * All require auth (mounted behind the gate) and 409 backend_not_configured when there is
 * no backend. TODO(B1)
 */
export function createDockerRouter(ctx: AppContext): Router {
  throw new Error('TODO(B1): implement createDockerRouter');
}
