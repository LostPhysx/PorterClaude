// OWNER: B1. pino logger. NEVER log secrets: redact api keys / passwords / cookies.
import pino from 'pino';
import type { Env } from './env.js';

export type Logger = pino.Logger;

export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  '*.apiKey',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  'apiKey',
  'password',
];

/** TODO(B1): pretty transport when NODE_ENV=development, plain JSON otherwise. */
export function createLogger(env: Env): Logger {
  throw new Error('TODO(B1): implement createLogger');
}
