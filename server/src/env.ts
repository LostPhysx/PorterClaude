// OWNER: B1. Process environment -> typed, validated config bootstrap. Env only *seeds*
// runtime settings; the source of truth after first boot is <DATA_DIR>/config.json.
import { z } from 'zod';

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** first-run bootstrap password; hashed into config.json on first boot */
  APP_PASSWORD: z.string().min(1).optional(),
  /** key for encrypting secrets at rest; auto-generated into <DATA_DIR>/secret.key when absent */
  APP_SECRET: z.string().min(16).optional(),
  /** seeds for unattended installs */
  PORTERCLAUDE_BACKEND: z.enum(['socket', 'portainer']).optional(),
  PORTAINER_URL: z.string().url().optional(),
  PORTAINER_API_KEY: z.string().optional(),
  PORTAINER_ENDPOINT_ID: z.coerce.number().int().optional(),
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  /** 'auto' => secure cookie when the request arrived over https (X-Forwarded-Proto aware) */
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  TRUST_PROXY: z.string().default('1'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** override the directory that holds docker/recipes + docker/tools (default <repo>/docker) */
  PORTERCLAUDE_DOCKER_DIR: z.string().optional(),
  /** override the static web root (default <repo>/web/public) */
  WEB_DIR: z.string().optional(),
  ENABLE_REQUEST_LOG: boolish.default(true),
});

export type Env = z.infer<typeof EnvSchema>;

/** TODO(B1): load .env via dotenv (dev only), parse, and produce a friendly error on failure. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  throw new Error('TODO(B1): implement loadEnv');
}
