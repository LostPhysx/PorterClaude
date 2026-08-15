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
import { createSessionsRouter } from '../sessions/routes.js';
import { createImagesRouter } from '../images/routes.js';

/**
 * Mount order matters:
 *   /api/health           public
 *   /api/auth             public (login/logout/session)
 *   requireAuth           gate for everything below
 *   /api/settings /api/docker /api/sessions /api/images
 */
export function registerRoutes(app: Express, ctx: AppContext): void {
  app.use('/api/health', createHealthRouter(ctx));
  app.use('/api/auth', createAuthRouter(ctx));

  const gate = requireAuth(ctx);
  app.use('/api/settings', gate, createSettingsRouter(ctx));
  app.use('/api/docker', gate, createDockerRouter(ctx));
  app.use('/api/sessions', gate, createSessionsRouter(ctx));
  app.use('/api/images', gate, createImagesRouter(ctx));
}
