// OWNER: B1. Mounted at /api/auth (see routes/index.ts). Public: login + session.
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';

export const LoginInputSchema = z.object({ password: z.string().min(1) });

/**
 * POST /api/auth/login    { password }            -> 200 { authenticated: true } + Set-Cookie
 *                                                    401 { error: { code: 'unauthorized' } }
 * POST /api/auth/logout                           -> 200 { authenticated: false } + clear cookie
 * GET  /api/auth/session                          -> 200 { authenticated, needsSetup }
 *
 * Rate limit login with express-rate-limit: 10 attempts / 15 min / IP, standardHeaders,
 * responding with the canonical error envelope (code 'rate_limited').
 * TODO(B1)
 */
export function createAuthRouter(ctx: AppContext): Router {
  throw new Error('TODO(B1): implement createAuthRouter');
}
