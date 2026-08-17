// OWNER: B1. Cookie-based single-user auth. Public API FROZEN — B2 uses
// `authenticateUpgradeRequest` in the session websocket upgrade handler.
//
// "session" used to mean three things in this repo; here it always meant the LOGIN, so the
// names are AUTH_*, never `container` (docs/design/users.md §0).
import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { AppContext } from '../context.js';
import { AppError } from '../http/errors.js';
import { hashPassword, verifyPassword } from '../config/crypto.js';

/** Name of the signed login cookie. Frontend never reads it (httpOnly). */
export const AUTH_COOKIE = 'pc_auth';

export interface AuthToken {
  sub: 'admin';
  /** config.auth.tokenVersion at issue time; a password change invalidates old cookies */
  v: number;
  iat: number;
  exp: number;
}

export interface AuthService {
  /** Verify the password against config.auth.passwordHash. */
  verifyPassword(password: string): Promise<boolean>;
  /** Sign a JWT for the current tokenVersion. */
  issueToken(): string;
  /** Returns null for missing/invalid/expired/stale-version tokens. */
  verifyToken(token: string | undefined): AuthToken | null;
  /** Change the password: verify current, hash new, bump tokenVersion. */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  /** True when no password has been configured yet (UI shows a setup hint). */
  needsSetup(): boolean;
  cookieOptions(secure: boolean): {
    httpOnly: true; sameSite: 'lax'; secure: boolean; path: string; maxAge: number;
  };
}

export function createAuthService(ctx: Pick<AppContext, 'config' | 'secrets' | 'env' | 'log'>): AuthService {
  const ttlSec = ctx.env.SESSION_TTL_DAYS * 24 * 60 * 60;

  return {
    async verifyPassword(password: string): Promise<boolean> {
      const hash = ctx.config.get().auth.passwordHash;
      if (!hash) return false;
      return verifyPassword(password, hash);
    },

    issueToken(): string {
      const version = ctx.config.get().auth.tokenVersion;
      return jwt.sign({ sub: 'admin', v: version }, ctx.secrets.jwtSecret(), {
        algorithm: 'HS256',
        expiresIn: ttlSec,
      });
    },

    verifyToken(token: string | undefined): AuthToken | null {
      if (!token) return null;
      try {
        const payload = jwt.verify(token, ctx.secrets.jwtSecret(), { algorithms: ['HS256'] });
        if (!payload || typeof payload !== 'object') return null;
        const p = payload as Record<string, unknown>;
        if (p.sub !== 'admin' || typeof p.v !== 'number') return null;
        if (p.v !== ctx.config.get().auth.tokenVersion) return null;
        return {
          sub: 'admin',
          v: p.v,
          iat: typeof p.iat === 'number' ? p.iat : 0,
          exp: typeof p.exp === 'number' ? p.exp : 0,
        };
      } catch {
        return null;
      }
    },

    async changePassword(currentPassword: string, newPassword: string): Promise<void> {
      const cfg = ctx.config.get();
      if (cfg.auth.passwordHash) {
        const ok = await verifyPassword(currentPassword, cfg.auth.passwordHash);
        if (!ok) throw AppError.unauthorized('current password is incorrect');
      }
      const hash = await hashPassword(newPassword);
      await ctx.config.update((draft) => {
        draft.auth.passwordHash = hash;
        draft.auth.tokenVersion = draft.auth.tokenVersion + 1;
        draft.auth.updatedAt = new Date().toISOString();
      });
      ctx.log.info('app password changed; every previously issued cookie is now invalid');
    },

    needsSetup(): boolean {
      return !ctx.config.get().auth.passwordHash;
    },

    cookieOptions(secure: boolean) {
      return {
        httpOnly: true as const,
        sameSite: 'lax' as const,
        secure,
        path: '/',
        maxAge: ttlSec * 1000,
      };
    },
  };
}

/** Express middleware: 401 { error: { code: 'unauthorized' } } when the cookie is bad. */
export function requireAuth(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
    const token = cookies?.[AUTH_COOKIE] ?? readCookie(req.headers.cookie, AUTH_COOKIE);
    if (!ctx.auth.verifyToken(token)) {
      next(AppError.unauthorized());
      return;
    }
    next();
  };
}

/**
 * FROZEN SIGNATURE (used by sessions/ws.ts, owner B2).
 * Parses the Cookie header of an HTTP upgrade request and verifies the login token.
 */
export function authenticateUpgradeRequest(req: IncomingMessage, ctx: AppContext): boolean {
  const token = readCookie(req.headers.cookie, AUTH_COOKIE);
  return ctx.auth.verifyToken(token) !== null;
}

/** COOKIE_SECURE=auto -> derive from the request (X-Forwarded-Proto aware). */
export function shouldUseSecureCookie(
  ctx: AppContext,
  req: { secure?: boolean; headers: Record<string, unknown> },
): boolean {
  const mode = ctx.env.COOKIE_SECURE;
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  if (req.secure === true) return true;
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof proto === 'string') {
    return proto.split(',')[0]?.trim().toLowerCase() === 'https';
  }
  return false;
}

/** Minimal Cookie header parser (upgrade requests never went through cookie-parser). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}
