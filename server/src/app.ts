// OWNER: B1. Express application factory (no listening, no process concerns -> testable).
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { ErrorRequestHandler, Express, Request } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { AppContext } from './context.js';
import { AppError, toAppError } from './http/errors.js';
import { REDACT_PATHS } from './logger.js';
import { registerRoutes } from './routes/index.js';
import { mountVendorRoutes } from './vendor.js';

/**
 * Middleware order (do not reorder without updating docs/design/backend.md):
 *   1. app.set('trust proxy', env.TRUST_PROXY)
 *   2. helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false })
 *      -- CSP is off because the UI loads vendor assets and inline bootstrap glue.
 *   3. pino-http (skipped when ENABLE_REQUEST_LOG=false), with REDACT_PATHS
 *   4. express.json({ limit: '1mb' }) + express.urlencoded({ extended: false })
 *   5. cookieParser()
 *   6. registerRoutes(app, ctx)                     -> /api/**
 *   7. mountVendorRoutes(app, paths, log)           -> /vendor/**
 *   8. express.static(paths.webPublic, { index: 'index.html' })
 *   9. SPA fallback: GET requests that are not /api/** and not /vendor/** -> index.html
 *      (Express 5 uses path-to-regexp v8: NEVER register a bare '*' route; use a
 *       terminal app.use((req,res,next) => ...) handler instead.)
 *  10. 404 handler for unmatched /api/** -> canonical error envelope
 *  11. error middleware: AppError -> err.toBody() with err.status; anything else ->
 *      500 { error: { code: 'internal', message: 'internal error' } } and log.error(err)
 */
export function createApp(ctx: AppContext): Express {
  const app = express();

  // 1. proxy awareness (X-Forwarded-Proto drives the `secure` cookie flag)
  app.set('trust proxy', parseTrustProxy(ctx.env.TRUST_PROXY));
  app.set('x-powered-by', false);

  // 2. security headers; CSP off (vendor assets + inline glue in index.html)
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

  // 3. request log
  if (ctx.env.ENABLE_REQUEST_LOG) {
    app.use(
      pinoHttp({
        logger: ctx.log,
        redact: { paths: REDACT_PATHS, censor: '[redacted]' },
        autoLogging: {
          ignore: (req: { url?: string }) => {
            const url = req.url ?? '';
            return url === '/api/health' || url.startsWith('/vendor/');
          },
        },
      }),
    );
  }

  // 4. body parsing
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // 5. cookies
  app.use(cookieParser());

  // 6. the API
  registerRoutes(app, ctx);

  // 7. vendored browser libraries
  mountVendorRoutes(app, ctx.paths, ctx.log);

  // 8. static web root
  app.use(express.static(ctx.paths.webPublic, { index: 'index.html', maxAge: '5m', etag: true }));

  // 9. + 10. SPA fallback for non-API GETs, canonical 404 for everything else
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/api') {
      next(AppError.notFound(`no such endpoint: ${req.method} ${req.path}`));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next(AppError.notFound(`no such route: ${req.method} ${req.path}`));
      return;
    }
    if (req.path.startsWith('/vendor/')) {
      next(AppError.notFound(`no such vendor asset: ${req.path}`));
      return;
    }
    const indexFile = path.join(ctx.paths.webPublic, 'index.html');
    if (!fs.existsSync(indexFile)) {
      next(AppError.notFound('the web UI is not built into this deployment'));
      return;
    }
    res.sendFile(indexFile, (err) => {
      if (err) next(err);
    });
  });

  // 11. terminal error middleware
  app.use(errorMiddleware);

  return app;
}

/** '1' -> 1, 'true'/'false' -> boolean, anything else -> the raw string (subnet list). */
export function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 0 && String(n) === value.trim()) return n;
  return value;
}

/** Exported for tests: the terminal error middleware. */
export const errorMiddleware: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const log = (req as Request & { log?: { error: (...args: unknown[]) => void } }).log;
  const appErr = toAppError(err);

  if (appErr.status >= 500 && appErr.code === 'internal') {
    log?.error({ err }, 'unhandled error');
    res.status(500).json(AppError.internal('internal error').toBody());
    return;
  }
  if (appErr.status >= 500) log?.error({ err }, 'request failed');
  res.status(appErr.status).json(appErr.toBody());
};
