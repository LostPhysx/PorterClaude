// OWNER: v0.4 profiles (issue #2). THE MANAGED SETTINGS APPLIER.
//
// A profile's per-agent slice becomes a Claude Code *managed settings* file inside the
// running container:
//
//     /etc/claude-code/managed-settings.json
//
// That path is the highest-precedence settings source of the claude CLI, so a profile
// wins over anything the user wrote into ~/.claude/settings.json — which is exactly what
// a server-managed profile has to do.
//
// The file is composed here and written by ONE root exec (`user: '0'`), the same shape
// containers/service.ts already uses for `ensureAgentDirs` / `ensureHomeWritable`. The
// JSON travels base64-encoded inside the script and is `base64 -d`'d in-container: a
// settings overlay is free-form user JSON and would otherwise have to survive two levels
// of sh quoting.
//
// Import direction: this file may import profiles/model.ts and config/crypto.ts; nothing
// in profiles/* imports it back — containers/service.ts is its only consumer.
import type { DockerBackend } from '../backends/types.js';
import type { SecretBox } from '../config/crypto.js';
import type { Logger } from '../logger.js';
import { shQuote } from '../util/slug.js';
import type { ProfileAgentConfig } from './model.js';

export const MANAGED_SETTINGS_DIR = '/etc/claude-code';
export const MANAGED_SETTINGS_PATH = `${MANAGED_SETTINGS_DIR}/managed-settings.json`;

/** owner fallback when the container has no explicit user and $HOME is root-owned */
const FALLBACK_OWNER = '1000:1000';

/**
 * The managed settings of ONE agent slice, or null when the profile has nothing to say
 * about it (an empty overlay AND no env) — the caller then removes a stale file instead.
 *
 *     { ...settings, env: { ...env, ...secretEnv } }
 *
 * Secrets win over plain env: the same key typed in both places is a user correcting the
 * plain value with a secret one, never the other way round. `env` is omitted entirely
 * when it would be `{}` (an empty block would still shadow nothing, but it makes the
 * file noise and defeats the "nothing to write" check above).
 *
 * PLUGINS (#3) — ENABLEMENT lives here, the FILES live in the login-set volume
 * (profiles/plugins.ts). Both keys are server-owned (model.ts
 * `SERVER_OWNED_SETTINGS_KEYS`), so a profile's overlay can never claim them:
 *
 *     "extraKnownMarketplaces": { "<name>": { "source": <source> } }
 *     "enabledPlugins":         { "<ref>": true }
 *
 * `<source>` is the github/git object the claude CLI takes: a bare `owner/repo`
 * shorthand becomes `{ source: 'github', repo }`, anything else (a git URL, an
 * absolute path) is passed on as `{ source: 'git', url }` — `ProfileMarketplace.source`
 * is documented as "shorthand or git URL, passed verbatim" and this is the only place
 * that has to decide which of the two it is.
 *
 * A ref that names a marketplace the profile does not declare is left alone: the CLI
 * resolves it against the marketplaces the login set already knows.
 */
export function composeManagedSettings(
  agent: ProfileAgentConfig,
  secretEnv: Record<string, string> = {},
): Record<string, unknown> | null {
  const settings: Record<string, unknown> = { ...agent.settings };
  const env = { ...agent.env, ...secretEnv };
  if (Object.keys(env).length > 0) settings.env = env;

  if (agent.marketplaces.length > 0) {
    const known: Record<string, unknown> = {};
    for (const m of agent.marketplaces) known[m.name] = { source: marketplaceSource(m.source) };
    settings.extraKnownMarketplaces = known;
  }
  if (agent.plugins.length > 0) {
    const enabled: Record<string, boolean> = {};
    for (const p of agent.plugins) enabled[p.ref] = true;
    settings.enabledPlugins = enabled;
  }

  return Object.keys(settings).length > 0 ? settings : null;
}

/** `owner/repo` -> a github source; everything else -> a git URL source. */
function marketplaceSource(source: string): Record<string, string> {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(source)
    ? { source: 'github', repo: source }
    : { source: 'git', url: source };
}

/**
 * Decrypt an agent slice's secret env. A value that no longer decrypts (rotated
 * APP_SECRET) is SKIPPED with a warning rather than failing the start — the container
 * comes up without that variable, which the user can see and fix, instead of not at all.
 * Mirrors `ProfileStore.secretEnvFor`; duplicated because the container machinery reaches
 * the SecretBox through ServiceDeps and never through the (route-facing) ProfileStore.
 */
export function decryptSecretEnv(
  agent: ProfileAgentConfig,
  secrets: SecretBox | undefined,
  log?: Logger,
): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = Object.keys(agent.envSecretsEnc);
  if (keys.length === 0) return out;
  if (!secrets) {
    log?.warn({ keys }, 'no SecretBox available: profile secret env is skipped');
    return out;
  }
  for (const key of keys) {
    try {
      out[key] = secrets.decrypt(agent.envSecretsEnc[key] as string);
    } catch {
      log?.warn(
        { key },
        'a stored profile secret cannot be decrypted (APP_SECRET changed?); re-enter it in Settings > Profiles',
      );
    }
  }
  return out;
}

/**
 * `sh -c` script that writes the composed settings. The owner is probed the way
 * `ensureAgentDirs` does it — explicit container user, else the owner of $HOME, else
 * 1000:1000 — so the file is readable by the process that runs `claude`; 0600 keeps the
 * API keys inside it away from every other uid in the container.
 */
export function managedSettingsWriteScript(
  settings: Record<string, unknown>,
  opts: { home: string; user?: string | null },
): string {
  const blob = Buffer.from(JSON.stringify(settings, null, 2), 'utf8').toString('base64');
  const user = (opts.user ?? '').trim();
  const file = shQuote(MANAGED_SETTINGS_PATH);
  return [
    'set -u',
    `h=${shQuote(opts.home)}`,
    user ? `own=${shQuote(user)}` : 'own=',
    `case "\${own:-}" in '') own=$(stat -c '%u:%g' "$h" 2>/dev/null || echo);; esac`,
    `case "\${own:-}" in ''|0:*) own=${shQuote(FALLBACK_OWNER)};; esac`,
    `mkdir -p ${shQuote(MANAGED_SETTINGS_DIR)} || { echo "cannot create ${MANAGED_SETTINGS_DIR}" >&2; exit 1; }`,
    `printf '%s' ${shQuote(blob)} | base64 -d > ${file} || { echo "cannot write ${MANAGED_SETTINGS_PATH}" >&2; exit 1; }`,
    `chmod 0600 ${file} 2>/dev/null || echo "chmod ${MANAGED_SETTINGS_PATH} failed" >&2`,
    `chown "$own" ${file} 2>/dev/null || echo "chown ${MANAGED_SETTINGS_PATH} failed" >&2`,
  ].join('\n');
}

/** `sh -c` script that removes a stale managed-settings file (profile emptied/detached). */
export function managedSettingsRemoveScript(): string {
  return `rm -f ${shQuote(MANAGED_SETTINGS_PATH)} 2>/dev/null || true`;
}

export interface ApplyManagedSettingsOptions {
  backend: DockerBackend;
  containerId: string;
  /** the container's $HOME (containers/container.ts `containerHomeFor`) */
  home: string;
  /** the container's explicit `user`, if any */
  user?: string | null;
  /** the agent slice of the container's profile, or null: then a stale file is removed */
  agent: ProfileAgentConfig | null;
  secrets?: SecretBox;
  log?: Logger;
}

/**
 * Compose + write (or remove) the managed settings in ONE root exec.
 *
 * The caller decides WHETHER to call this at all: a container with `profileId: null` must
 * see zero execs, so that the vast majority of containers are bit-for-bit unaffected by
 * the profiles feature. Once a container HAS a profileId, both outcomes are exec'd — the
 * removal branch is what makes "the profile no longer sets anything" actually take effect
 * on the next start instead of leaving yesterday's API key in place.
 *
 * @returns a human-readable warning, or null on success. Never throws.
 */
export async function applyManagedSettings(opts: ApplyManagedSettingsOptions): Promise<string | null> {
  const settings = opts.agent ? composeManagedSettings(opts.agent, decryptSecretEnv(opts.agent, opts.secrets, opts.log)) : null;
  const script = settings
    ? managedSettingsWriteScript(settings, { home: opts.home, user: opts.user })
    : managedSettingsRemoveScript();
  try {
    const res = await opts.backend.runExec(opts.containerId, ['sh', '-c', script], { user: '0', timeoutMs: 30_000 });
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout).trim().slice(0, 400);
      return `applying the profile settings failed (exit ${res.exitCode})${detail ? `: ${detail}` : ''}`;
    }
    return null;
  } catch (err) {
    return `applying the profile settings failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
