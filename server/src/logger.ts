// OWNER: B1. pino logger. NEVER log secrets: redact api keys / passwords / cookies.
import pino from 'pino';
import type { Env } from './env.js';

export type Logger = pino.Logger;

export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  // the response header carries a freshly issued session JWT -- never write it to a log
  'res.headers["set-cookie"]',
  '*.apiKey',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  'apiKey',
  'password',
];

/** pretty transport when NODE_ENV=development, plain JSON otherwise. */
export function createLogger(env: Env): Logger {
  const options: pino.LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };

  if (env.NODE_ENV === 'development') {
    try {
      return pino({
        ...options,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      });
    } catch {
      // pino-pretty is a devDependency: fall through to plain JSON when it is absent.
    }
  }

  return pino(options);
}
