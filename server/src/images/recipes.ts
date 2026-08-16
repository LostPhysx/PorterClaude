// OWNER: B2 (registry data). `name` MUST match the directory docker/recipes/<name>/ owned
// by the orchestration topic. Tags: <ns>/<name>:latest.
//
// v0.2: a recipe image is a TOOLCHAIN only - it no longer bakes a coding agent in. Every
// session (recipe and custom alike) mounts the host's tools volume read-only and gets the
// agents from there, so adding an agent never means rebuilding six images.
export interface RecipeDef {
  name: string;
  title: string;
  description: string;
  /** informational: the FROM line of the recipe Dockerfile */
  baseImage: string;
  /** ports the image exposes by default (php serves nginx on 80) */
  defaultPorts?: number[];
  /** shown in the UI when the recipe needs extra explanation */
  notes?: string;
}

export const RECIPES: RecipeDef[] = [
  { name: 'node', title: 'Node.js 22', description: 'node:22-bookworm with npm and pnpm', baseImage: 'node:22-bookworm' },
  { name: 'dotnet', title: '.NET SDK 9', description: 'mcr.microsoft.com/dotnet/sdk:9.0', baseImage: 'mcr.microsoft.com/dotnet/sdk:9.0' },
  { name: 'php', title: 'PHP 8.3 + nginx', description: 'php:8.3-fpm with nginx, composer and supervisord', baseImage: 'php:8.3-fpm-bookworm', defaultPorts: [80], notes: 'serves /workspace/public on port 80; set the session env var PC_HTTP_PORT (and publish the same port) when the host does not allow uid 1000 to bind port 80' },
  { name: 'python', title: 'Python 3.13', description: 'python:3.13-bookworm with pip and uv', baseImage: 'python:3.13-bookworm' },
  { name: 'go', title: 'Go 1.23', description: 'golang:1.23-bookworm', baseImage: 'golang:1.23-bookworm' },
  { name: 'base', title: 'Debian base', description: 'debian:bookworm-slim with the standard toolchain only', baseImage: 'debian:bookworm-slim' },
];

export const DEFAULT_RECIPE = 'node';

export function getRecipe(name: string): RecipeDef | null {
  return RECIPES.find((r) => r.name === name) ?? null;
}

/** <namespace>/<recipe>:<tag> */
export function recipeImageRef(namespace: string, recipe: string, tag = 'latest'): string {
  return `${namespace}/${recipe}:${tag}`;
}

/** The image built from docker/tools/ that populates the shared tools volume. */
export function toolsImageRef(namespace: string): string {
  return `${namespace}/tools:latest`;
}
