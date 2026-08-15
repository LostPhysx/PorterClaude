// FROZEN (planner-authored, fully implemented). One place that knows where things live.
// Layout assumption: this file compiles to <repo>/server/dist/paths.js and runs from there,
// or is executed via tsx from <repo>/server/src/paths.ts. Both resolve to <repo>/server.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from './env.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
export const NODE_MODULES_DIR = path.join(REPO_ROOT, 'node_modules');
export const SERVER_NODE_MODULES_DIR = path.join(SERVER_ROOT, 'node_modules');

export interface Paths {
  repoRoot: string;
  serverRoot: string;
  nodeModules: string;
  /** static web root served at "/" */
  webPublic: string;
  /** holds recipes/ and tools/ */
  dockerDir: string;
  recipesDir: string;
  toolsDir: string;
  dataDir: string;
  configFile: string;
  secretFile: string;
}

export function resolvePaths(env: Env): Paths {
  const dataDir = path.resolve(env.DATA_DIR);
  const dockerDir = env.PORTERCLAUDE_DOCKER_DIR
    ? path.resolve(env.PORTERCLAUDE_DOCKER_DIR)
    : path.join(REPO_ROOT, 'docker');
  return {
    repoRoot: REPO_ROOT,
    serverRoot: SERVER_ROOT,
    nodeModules: NODE_MODULES_DIR,
    webPublic: env.WEB_DIR ? path.resolve(env.WEB_DIR) : path.join(REPO_ROOT, 'web', 'public'),
    dockerDir,
    recipesDir: path.join(dockerDir, 'recipes'),
    toolsDir: path.join(dockerDir, 'tools'),
    dataDir,
    configFile: path.join(dataDir, 'config.json'),
    secretFile: path.join(dataDir, 'secret.key'),
  };
}
