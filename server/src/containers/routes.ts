// OWNER: B2. Mounted at /api/containers behind requireAuth (see routes/index.ts).
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { asyncHandler } from '../http/async.js';
import { AppError } from '../http/errors.js';
import { parseBody, parseParams, parseQuery } from '../http/validate.js';
import { ContainerInputSchema, ContainerNameSchema } from './model.js';

const NameParams = z.object({ name: ContainerNameSchema });

const boolish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return false;
    if (typeof v === 'boolean') return v;
    return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  });

const RemoveQuery = z.object({ removeVolumes: boolish });

/** v0.2: optional host filter for the list; container NAMES stay globally unique. */
const ListQuery = z.object({ hostId: z.string().min(1).max(32).optional() });

/** `path` is absolute inside the container or relative to the workspace mount. */
const FilesQuery = z.object({ path: z.string().max(4096).optional() });

const UploadQuery = FilesQuery.extend({ name: z.string().min(1).max(255) });

const LogsQuery = z.object({
  tail: z.coerce.number().int().min(1).max(10_000).optional().default(200),
  timestamps: boolish,
});

/**
 * v0.2: containers stay FLAT (no /api/hosts/:hostId prefix) because a container name is unique
 * across hosts - that is also what lets the session websocket route container -> host with
 * nothing but the name. The host is part of the body (create only, immutable afterwards)
 * and of every ContainerView.
 *
 * GET    /api/containers?hostId=<id>     -> { containers: ContainerView[] }
 * POST   /api/containers                 ContainerInput -> 201 { container: ContainerView }
 *                                         409 conflict when the name is taken
 * GET    /api/containers/:name           -> { container: ContainerView }
 * PUT    /api/containers/:name           ContainerInput -> { container: ContainerView }  (recreates)
 * DELETE /api/containers/:name?removeVolumes=1 -> 204
 * POST   /api/containers/:name/start     -> { container: ContainerView }
 * POST   /api/containers/:name/stop      -> { container: ContainerView }
 * POST   /api/containers/:name/restart   -> { container: ContainerView }
 * POST   /api/containers/:name/recreate  -> { container: ContainerView }
 * GET    /api/containers/:name/logs?tail=200&timestamps=0 -> { logs: string }
 * GET    /api/containers/:name/files?path=<dir>            -> { listing: FileListing }
 * GET    /api/containers/:name/files/download?path=<p>     -> the file, or <dir>.tar.gz
 * POST   /api/containers/:name/files/upload?path=<dir>&name=<file>
 *                                         raw body (Content-Length required) -> 201 { file }
 * POST   /api/containers/reconcile?hostId=<id> -> { report: ReconcileReport }
 *                                         (every host, or just one)
 */
export function createContainersRouter(ctx: AppContext): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { hostId } = parseQuery(ListQuery, req);
      const containers = await ctx.containers.list(hostId ? { hostId } : undefined);
      res.json({ containers });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = parseBody(ContainerInputSchema, req);
      const container = await ctx.containers.create(input);
      // 202 = the definition is stored and the host is being prepared for it (a recipe
      // image is building, the tools volume is syncing); the container appears when that
      // finishes. `container.preparing` says what is running. 201 = it is already there.
      res.status(container.preparing ? 202 : 201).json({ container });
    }),
  );

  // literal route: MUST be registered before '/:name'
  router.post(
    '/reconcile',
    asyncHandler(async (req, res) => {
      // explicit user action: adopt orphans (the startup reconcile does not, so an
      // orphan stays visible instead of being silently rewritten)
      const { hostId } = parseQuery(ListQuery, req);
      const report = await ctx.containers.reconcile({ adopt: true, ...(hostId ? { hostId } : {}) });
      res.json({ report });
    }),
  );

  router.get(
    '/:name',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      res.json({ container: await ctx.containers.get(name) });
    }),
  );

  router.put(
    '/:name',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      const input = parseBody(ContainerInputSchema, req);
      const container = await ctx.containers.update(name, input);
      res.status(container.preparing ? 202 : 200).json({ container });
    }),
  );

  router.delete(
    '/:name',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      const { removeVolumes } = parseQuery(RemoveQuery, req);
      await ctx.containers.remove(name, { removeVolumes });
      res.status(204).end();
    }),
  );

  router.post(
    '/:name/start',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      const container = await ctx.containers.start(name);
      res.status(container.preparing ? 202 : 200).json({ container });
    }),
  );

  router.post(
    '/:name/stop',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      res.json({ container: await ctx.containers.stop(name) });
    }),
  );

  router.post(
    '/:name/restart',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      res.json({ container: await ctx.containers.restart(name) });
    }),
  );

  router.post(
    '/:name/recreate',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      res.json({ container: await ctx.containers.recreate(name) });
    }),
  );

  router.get(
    '/:name/logs',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      const { tail, timestamps } = parseQuery(LogsQuery, req);
      const logs = await ctx.containers.logs(name, { tail, timestamps });
      res.json({ logs });
    }),
  );

  // ---- workspace file transfer (containers/files.ts) ----------------------

  router.get(
    '/:name/files',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      const { path } = parseQuery(FilesQuery, req);
      res.json({ listing: await ctx.files.list(name, path) });
    }),
  );

  router.get(
    '/:name/files/download',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      const { path } = parseQuery(FilesQuery, req);
      const file = await ctx.files.download(name, path ?? '');
      res.setHeader('Content-Type', file.kind === 'dir' ? 'application/gzip' : 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition(file.filename));
      if (file.size !== null) res.setHeader('Content-Length', String(file.size));
      // the tab may be closed mid-download: stop pulling from the engine when it is
      res.on('close', () => file.stream.destroy());
      // a failure here is asynchronous and the headers are already out, so there is no error
      // envelope left to send — the truncated response IS the error signal. It must not be
      // rethrown either: nothing would catch it and the process would die.
      file.stream.on('error', (err: Error) => {
        ctx.log.warn({ err, container: name }, 'workspace download stream failed');
        res.destroy(err);
      });
      file.stream.pipe(res);
    }),
  );

  router.post(
    '/:name/files/upload',
    asyncHandler(async (req, res) => {
      const { name } = parseParams(NameParams, req);
      const { path, name: filename } = parseQuery(UploadQuery, req);
      // the tar header carries the size, so the length has to be known before the first byte
      const length = Number(req.headers['content-length']);
      if (!Number.isInteger(length) || length < 0) {
        throw AppError.badRequest('Content-Length is required for an upload');
      }
      const file = await ctx.files.upload(name, path, filename, req, length);
      res.status(201).json({ file });
    }),
  );

  return router;
}

/**
 * `attachment; filename="x"; filename*=UTF-8''x` — the quoted form for old clients (with
 * everything a header may not carry replaced), the RFC 5987 form for everyone else.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
