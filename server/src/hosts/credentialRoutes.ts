// OWNER: B1. Mounted at /api/credentials behind requireAuth (see routes/index.ts).
// Only Portainer credentials exist in v0.2; tcp/ssh credential kinds get their own
// sub-path when those connection types land.
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../http/async.js';
import { parseBody, parseParams } from '../http/validate.js';
import { PortainerCredentialInputSchema, PortainerImportInputSchema } from './model.js';

const IdParams = z.object({ id: z.string().min(1).max(64) });

const TestBody = PortainerCredentialInputSchema.partial().default({});

/**
 * GET    /api/credentials/portainer                 -> { credentials: SanitizedPortainerCredential[] }
 * POST   /api/credentials/portainer                 { name, url, apiKey, insecureTls? } -> 201 { credential }
 * PUT    /api/credentials/portainer/:id             partial (omit apiKey to keep it) -> { credential }
 * DELETE /api/credentials/portainer/:id             -> 204   (409 while a host uses it)
 * POST   /api/credentials/portainer/:id/test        { url?, apiKey?, insecureTls? } -> BackendTestResult
 * GET    /api/credentials/portainer/:id/endpoints   -> { endpoints: PortainerEndpoint[] }
 * POST   /api/credentials/portainer/:id/import      PortainerImportInput -> { result: PortainerImportResult }
 * POST   /api/credentials/portainer/test            { url, apiKey, insecureTls? } -> BackendTestResult (unsaved)
 */
export function createCredentialsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/portainer',
    asyncHandler(async (_req, res) => {
      res.json({ credentials: ctx.credentials.sanitizedList() });
    }),
  );

  router.post(
    '/portainer',
    asyncHandler(async (req, res) => {
      const input = parseBody(PortainerCredentialInputSchema.required({ apiKey: true }), req);
      res.status(201).json({ credential: await ctx.credentials.create(input) });
    }),
  );

  // literal route before '/portainer/:id'
  router.post(
    '/portainer/test',
    asyncHandler(async (req, res) => {
      const input = parseBody(TestBody, req);
      res.json(await ctx.credentials.test(null, input));
    }),
  );

  router.put(
    '/portainer/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(IdParams, req);
      const input = parseBody(PortainerCredentialInputSchema.partial(), req);
      res.json({ credential: await ctx.credentials.update(id, input) });
    }),
  );

  router.delete(
    '/portainer/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(IdParams, req);
      await ctx.credentials.remove(id);
      res.status(204).end();
    }),
  );

  router.post(
    '/portainer/:id/test',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(IdParams, req);
      const input = parseBody(TestBody, req);
      res.json(await ctx.credentials.test(id, input));
    }),
  );

  router.get(
    '/portainer/:id/endpoints',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(IdParams, req);
      res.json({ endpoints: await ctx.credentials.listEndpoints(id) });
    }),
  );

  router.post(
    '/portainer/:id/import',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(IdParams, req);
      const input = parseBody(PortainerImportInputSchema.default({}), req);
      res.json({ result: await ctx.hosts.importPortainerEndpoints(id, input) });
    }),
  );

  return router;
}
