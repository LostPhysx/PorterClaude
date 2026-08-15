// OWNER: B1. Cookie-based single-user auth. Public API FROZEN — B2 uses
// `authenticateUpgradeRequest` in the terminal websocket upgrade handler.
import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';
import type { AppContext } from '../context.js';

/** Name of the signed session cookie. Frontend never reads it (httpOnly). */
export const SESSION_COOKIE = 'pc_session';

export interface SessionToken {
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
  verifyToken(token: string | undefined): SessionToken | null;
  /** Change the password: verify current, hash new, bump tokenVersion. */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  /** True when no password has been configured yet (UI shows a setup hint). */
  needsSetup(): boolean;
  cookieOptions(secure: boolean): {
    httpOnly: true; sameSite: 'lax'; secure: boolean; path: string; maxAge: number;
  };
}

/** TODO(B1) */
export function createAuthService(ctx: Pick<AppContext, 'config' | 'secrets' | 'env' | 'log'>): AuthService {
  throw new Error('TODO(B1): implement createAuthService');
}

/** Express middleware: 401 { error: { code: 'unauthorized' } } when the cookie is bad. */
export function requireAuth(ctx: AppContext): RequestHandler {
  throw new Error('TODO(B1): implement requireAuth');
}

/**
 * FROZEN SIGNATURE (used by terminals/ws.ts, owner B2).
 * Parses the Cookie header of an HTTP upgrade request and verifies the session token.
 */
export function authenticateUpgradeRequest(req: IncomingMessage, ctx: AppContext): boolean {
  throw new Error('TODO(B1): implement authenticateUpgradeRequest');
}

/** COOKIE_SECURE=auto -> derive from the request (X-Forwarded-Proto aware). */
export function shouldUseSecureCookie(ctx: AppContext, req: { secure?: boolean; headers: Record<string, unknown> }): boolean {
  throw new Error('TODO(B1)');
}
