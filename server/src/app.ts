// OWNER: B1. Express application factory (no listening, no process concerns -> testable).
import type { ErrorRequestHandler, Express } from 'express';
import type { AppContext } from './context.js';

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
 *
 * TODO(B1)
 */
export function createApp(ctx: AppContext): Express {
  throw new Error('TODO(B1): implement createApp');
}

/** Exported for tests: the terminal error middleware. TODO(B1) */
export const errorMiddleware: ErrorRequestHandler = () => {
  throw new Error('TODO(B1): implement errorMiddleware');
};
