// OWNER: B1. Mounted at /api/auth (see routes/index.ts). Public: login + me.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AppError } from '../http/errors.js';
import { asyncHandler } from '../http/async.js';
import { parseBody } from '../http/validate.js';
import { AUTH_COOKIE, shouldUseSecureCookie } from './index.js';

export const LoginInputSchema = z.object({ password: z.string().min(1) });

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_ATTEMPTS = 10;

/**
 * POST /api/auth/login    { password }            -> 200 { authenticated: true } + Set-Cookie
 *                                                    401 { error: { code: 'unauthorized' } }
 * POST /api/auth/logout                           -> 200 { authenticated: false } + clear cookie
 * GET  /api/auth/me                               -> 200 { authenticated, needsSetup }
 *
 * Login is rate limited to 10 attempts / 15 min / IP; the throttle answers with the
 * canonical error envelope (code 'rate_limited'). Successful logins do not consume budget.
 */
export function createAuthRouter(ctx: AppContext): Router {
  const router = Router();

  const loginLimiter = rateLimit({
    windowMs: LOGIN_WINDOW_MS,
    limit: LOGIN_MAX_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res) => {
      ctx.log.warn({ ip: req.ip }, 'login throttled');
      const err = new AppError('rate_limited', 'too many login attempts, please try again later');
      res.status(err.status).json(err.toBody());
    },
  });

  router.post(
    '/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const { password } = parseBody(LoginInputSchema, req);
      const ok = await ctx.auth.verifyPassword(password);
      if (!ok) {
        ctx.log.warn({ ip: req.ip }, 'failed login attempt');
        throw AppError.unauthorized('invalid password');
      }
      const secure = shouldUseSecureCookie(ctx, req as unknown as { secure?: boolean; headers: Record<string, unknown> });
      res.cookie(AUTH_COOKIE, ctx.auth.issueToken(), ctx.auth.cookieOptions(secure));
      res.json({ authenticated: true });
    }),
  );

  router.post('/logout', (req, res) => {
    const secure = shouldUseSecureCookie(ctx, req as unknown as { secure?: boolean; headers: Record<string, unknown> });
    const { maxAge: _maxAge, ...clearOpts } = ctx.auth.cookieOptions(secure);
    res.clearCookie(AUTH_COOKIE, clearOpts);
    res.json({ authenticated: false });
  });

  router.get('/me', (req, res) => {
    const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
    const token = cookies?.[AUTH_COOKIE];
    res.json({
      authenticated: ctx.auth.verifyToken(token) !== null,
      needsSetup: ctx.auth.needsSetup(),
    });
  });

  return router;
}
