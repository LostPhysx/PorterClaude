// FROZEN (planner-authored). The single place that wires routers onto the app, so B1 and
// B2 never edit the same mount file. Implemented here; both coders only fill in the
// routers it imports.
import type { Express } from 'express';
import type { AppContext } from '../context.js';
import { requireAuth } from '../auth/index.js';
import { createAuthRouter } from '../auth/routes.js';
import { createHealthRouter } from './health.js';
import { createSettingsRouter } from './settings.js';
import { createDockerRouter } from './docker.js';
import { createHostsRouter } from '../hosts/routes.js';
import { createCredentialsRouter } from '../hosts/credentialRoutes.js';
import { createAgentsRouter, createHostAgentsRouter } from '../agents/routes.js';
import { createSessionsRouter } from '../sessions/routes.js';
import { createImagesRouter } from '../images/routes.js';

/**
 * Mount order matters:
 *   /api/health                     public
 *   /api/auth                       public (login/logout/session)
 *   requireAuth                     gate for everything below
 *   /api/hosts/:hostId/images       B2   (host-scoped: images, recipes, jobs, tools)
 *   /api/hosts/:hostId/docker       B1   (host-scoped read-only helpers)
 *   /api/hosts/:hostId/agents       B1   (per-host agent enable + install state)
 *   /api/hosts                      B1   (host CRUD; mounted AFTER the three above so a
 *                                         host id can never shadow them)
 *   /api/credentials                B1
 *   /api/agents                     B1   (definitions)
 *   /api/settings                   B1   (general/ui/password only — the backend section is gone)
 *   /api/sessions                   B2   (flat: session names are unique across hosts)
 *
 * The host-scoped routers are created with `Router({ mergeParams: true })` so they see
 * `req.params.hostId` from their mount path (hosts/model.ts `HostIdParamsSchema`).
 */
export function registerRoutes(app: Express, ctx: AppContext): void {
  app.use('/api/health', createHealthRouter(ctx));
  app.use('/api/auth', createAuthRouter(ctx));

  const gate = requireAuth(ctx);
  app.use('/api/hosts/:hostId/images', gate, createImagesRouter(ctx));
  app.use('/api/hosts/:hostId/docker', gate, createDockerRouter(ctx));
  app.use('/api/hosts/:hostId/agents', gate, createHostAgentsRouter(ctx));
  app.use('/api/hosts', gate, createHostsRouter(ctx));
  app.use('/api/credentials', gate, createCredentialsRouter(ctx));
  app.use('/api/agents', gate, createAgentsRouter(ctx));
  app.use('/api/settings', gate, createSettingsRouter(ctx));
  app.use('/api/sessions', gate, createSessionsRouter(ctx));
}
