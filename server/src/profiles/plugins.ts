// OWNER: v0.4 profiles (issue #3). THE PLUGIN SYNC ENGINE.
//
// Split of responsibilities (docs/design/users.md §0, approved design):
//
//     FILES belong to the LOGIN SET     — `~/.claude/plugins` lives inside the mounted
//                                         login-set volume, which several profiles may share;
//     ENABLEMENT belongs to the PROFILE — `enabledPlugins` in the managed settings
//                                         (profiles/apply.ts), which is per container.
//
// So this file only does the part that needs the network and a running container: making
// sure the plugin FILES the profile's refs name are present in the volume. Which of them
// are switched ON is decided, exec-free, by the managed settings.
//
// Everything here is BEST EFFORT and idempotent:
//   * a marker file inside the volume records what we installed, so a restart of an
//     already-synced container costs exactly ONE `cat` exec and no network at all;
//   * a per-ref failure (offline host, typo'd ref, dead marketplace) becomes ONE warning
//     on the container view and is simply not recorded as installed, so the next start
//     retries it. Nothing in here ever throws — a container must start without its
//     plugins rather than not start.
//
// Import direction: same as apply.ts — may import profiles/model.ts and agents/model.ts;
// containers/service.ts is the only consumer.
import type { DockerBackend } from '../backends/types.js';
import type { Logger } from '../logger.js';
import { agentDataDir, DEFAULT_LOGIN_SET } from '../agents/model.js';
import { shQuote } from '../util/slug.js';
import type { ProfileAgentConfig } from './model.js';

/** the agent whose login volume carries `~/.claude/plugins` */
export const PLUGIN_AGENT_ID = 'claude';

/**
 * Basename of the sync marker. It sits at the TOP of the login-set volume
 * (`<home>/.porterclaude/agents/claude/`), NEXT TO — never inside — the `claude/` slug
 * that is symlinked to `~/.claude`: the agent owns everything below that slug and rewrites
 * it wholesale, while this file is ours and must survive a `/plugin` round trip.
 */
export const PLUGIN_MARKER_FILE = '.porterclaude-plugins.json';

/** owner fallback when the container has no explicit user and $HOME is root-owned (apply.ts) */
const FALLBACK_OWNER = '1000:1000';

/** `claude plugin install` may pull a whole git repo over a slow link */
const INSTALL_TIMEOUT_MS = 180_000;
const MARKER_TIMEOUT_MS = 30_000;

/** `<home>/.porterclaude/agents/claude/.porterclaude-plugins.json` */
export function pluginMarkerPath(home: string): string {
  return `${agentDataDir(home, PLUGIN_AGENT_ID)}/${PLUGIN_MARKER_FILE}`;
}

/** What the marker file holds. `installed` is what WE put into this volume, in ref form. */
export interface PluginMarker {
  syncedAt: string;
  installed: string[];
}

/**
 * The plugin NAME without its marketplace: a ref is `name` or `name@marketplace`, and a
 * name may itself be npm-scoped (`@acme/tools@market`), so the LAST `@` separates.
 *
 * NOT what `uninstall` is called with — see `uninstallArgFor`.
 */
export function pluginNameOf(ref: string): string {
  const at = ref.lastIndexOf('@');
  return at > 0 ? ref.slice(0, at) : ref;
}

/**
 * The argument `claude plugin uninstall` is called with.
 *
 * The CLI reference spells the parameter `<name>`, but the plugin docs' own example passes
 * the FULL `plugin-name@marketplace-name` ref, and the marketplace half appears to be
 * optional rather than rejected. The full ref is therefore the safer call: it is what the
 * documented example uses, and it disambiguates two marketplaces shipping the same plugin
 * name — where a bare name could uninstall the wrong one. Verified per host by the
 * `POST /api/profiles/:id/verify` probe (issue #4), since this is exactly the kind of CLI
 * detail that drifts between versions.
 */
export function uninstallArgFor(ref: string): string {
  return ref;
}

/**
 * Is the login set PRIVATE to this profile? Only then may we uninstall.
 *
 * `loginSetFor` yields the profile id for an implicit private set (and for a dangling
 * profileId, which keeps the container on that same private volume). The `default` set is
 * the host-wide v0.2 volume and a NAMED set is shared by every profile referencing it: a
 * plugin this profile stopped wanting may still be enabled by a sibling profile mounting
 * the same volume, and uninstalling it would break that container's next session. On a
 * shared set we therefore only forget the ref (drop it from the marker) and leave the
 * files alone — they cost disk, not correctness, and `enabledPlugins` keeps them off.
 */
export function loginSetIsPrivate(loginSet: string, profileId: string): boolean {
  return loginSet !== DEFAULT_LOGIN_SET && loginSet === profileId;
}

/**
 * Concurrency guard. A stop/start storm (or two reconcile loops meeting) can run
 * `afterStart` twice for the same container while the first install is still fetching, and
 * two `claude plugin install` processes writing one volume is how a plugin dir ends up half
 * unpacked. Keyed by container id; always released in a `finally`.
 */
const inFlight = new Set<string>();

export interface SyncProfilePluginsOptions {
  backend: DockerBackend;
  containerId: string;
  /** the container's $HOME (containers/container.ts `containerHomeFor`) */
  home: string;
  /** the container's explicit `user`, if any (owner probe for the marker) */
  user?: string | null;
  /** the agent slice of the container's profile */
  agent: ProfileAgentConfig;
  /** the login set this container mounts for `claude` (agents/model.ts `loginSetFor`) */
  loginSet: string;
  /** the container's profile id — private-set test, see `loginSetIsPrivate` */
  profileId: string;
  log?: Logger;
}

/**
 * Install/uninstall so the login-set volume carries exactly the profile's plugin refs.
 *
 * @returns human-readable warnings (one per failed ref), empty on success. NEVER throws.
 */
export async function syncProfilePlugins(opts: SyncProfilePluginsOptions): Promise<string[]> {
  const desired = [...new Set(opts.agent.plugins.map((p) => p.ref))];
  // the overwhelmingly common case: no plugins configured -> not a single exec
  if (desired.length === 0) return [];

  if (inFlight.has(opts.containerId)) {
    opts.log?.debug({ containerId: opts.containerId }, 'plugin sync already in flight for this container; skipped');
    return [];
  }
  inFlight.add(opts.containerId);
  try {
    return await syncLocked(opts, desired);
  } catch (err) {
    // defence in depth: syncLocked already swallows every per-ref failure
    return [`syncing the profile plugins failed: ${err instanceof Error ? err.message : String(err)}`];
  } finally {
    inFlight.delete(opts.containerId);
  }
}

async function syncLocked(opts: SyncProfilePluginsOptions, desired: string[]): Promise<string[]> {
  const marker = await readMarker(opts);
  const installed = [...new Set(marker.installed)];

  // FAST PATH: the volume already holds exactly what the profile asks for. One `cat` exec
  // total, no network — this is what every restart of a steady-state container costs.
  //
  // KNOWN TRADE-OFF: the marker describes the VOLUME, the desired set describes the PROFILE.
  // Two profiles sharing one login set with different plugin lists therefore alternate the
  // marker and re-run an install on each other's starts. That is idempotent (the CLI no-ops
  // on an already-installed plugin) and the containers still see the right plugins, because
  // ENABLEMENT rides each container's own managed settings — it merely costs one exec per
  // alternating start. Splitting the marker per profile would trade that for plugin files
  // that no marker owns.
  if (sameSet(installed, desired)) return [];

  const warnings: string[] = [];
  const present = new Set(installed);
  const wanted = new Set(desired);
  const canUninstall = loginSetIsPrivate(opts.loginSet, opts.profileId);

  for (const ref of desired) {
    if (present.has(ref)) continue;
    const failure = await runPluginCommand(opts, ['claude', 'plugin', 'install', ref, '-y']);
    if (failure) {
      // NOT recorded as installed: the next start retries it by itself
      warnings.push(`installing the plugin '${ref}' failed${failure}`);
      continue;
    }
    present.add(ref);
  }

  for (const ref of installed) {
    if (wanted.has(ref)) continue;
    if (!canUninstall) {
      // shared/default login set: forget the ref, never touch another profile's files
      present.delete(ref);
      opts.log?.debug({ ref, loginSet: opts.loginSet }, 'plugin dropped from a shared login set without uninstalling');
      continue;
    }
    const failure = await runPluginCommand(opts, ['claude', 'plugin', 'uninstall', uninstallArgFor(ref), '-y']);
    if (failure) {
      // still listed, so the next start retries the uninstall
      warnings.push(`removing the plugin '${ref}' failed${failure}`);
      continue;
    }
    present.delete(ref);
  }

  const writeWarning = await writeMarker(opts, {
    syncedAt: new Date().toISOString(),
    installed: [...present].sort(),
  });
  if (writeWarning) warnings.push(writeWarning);
  return warnings;
}

/**
 * One `claude plugin …` exec AS THE CONTAINER USER — deliberately NOT `user: '0'`. The CLI
 * writes into `~/.claude/plugins` (and rewrites `~/.claude.json`); root-owned files there
 * break the user's very next `/login` or `/plugin` with EACCES, in a way that survives
 * every restart.
 *
 * @returns a detail suffix for the warning, or null on success.
 */
async function runPluginCommand(opts: SyncProfilePluginsOptions, argv: string[]): Promise<string | null> {
  try {
    const res = await opts.backend.runExec(opts.containerId, argv, { timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.exitCode === 0) return null;
    const detail = (res.stderr || res.stdout).trim().slice(0, 300);
    return ` (exit ${res.exitCode})${detail ? `: ${detail}` : ''}`;
  } catch (err) {
    // an offline host / a dead container: the exec throws or times out
    return `: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * ONE exec. A missing or corrupt marker reads as "nothing installed" — we then re-install,
 * which is exactly what `claude plugin install` is idempotent for.
 */
async function readMarker(opts: SyncProfilePluginsOptions): Promise<PluginMarker> {
  const empty: PluginMarker = { syncedAt: '', installed: [] };
  const path = pluginMarkerPath(opts.home);
  try {
    const res = await opts.backend.runExec(
      opts.containerId,
      ['sh', '-c', `cat ${shQuote(path)} 2>/dev/null || true`],
      { timeoutMs: MARKER_TIMEOUT_MS },
    );
    const raw = (res.stdout || '').trim();
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<PluginMarker>;
    const installed = Array.isArray(parsed.installed)
      ? parsed.installed.filter((r): r is string => typeof r === 'string' && r.length > 0)
      : [];
    return { syncedAt: typeof parsed.syncedAt === 'string' ? parsed.syncedAt : '', installed };
  } catch (err) {
    opts.log?.debug({ err }, 'the plugin marker could not be read; treating the login set as empty');
    return empty;
  }
}

/** `sh -c` script that writes the marker; the owner probe is apply.ts's, verbatim. */
export function pluginMarkerWriteScript(
  marker: PluginMarker,
  opts: { home: string; user?: string | null },
): string {
  const blob = Buffer.from(JSON.stringify(marker, null, 2), 'utf8').toString('base64');
  const user = (opts.user ?? '').trim();
  const path = pluginMarkerPath(opts.home);
  const file = shQuote(path);
  return [
    'set -u',
    `h=${shQuote(opts.home)}`,
    user ? `own=${shQuote(user)}` : 'own=',
    `case "\${own:-}" in '') own=$(stat -c '%u:%g' "$h" 2>/dev/null || echo);; esac`,
    `case "\${own:-}" in ''|0:*) own=${shQuote(FALLBACK_OWNER)};; esac`,
    `printf '%s' ${shQuote(blob)} | base64 -d > ${file} || { echo "cannot write ${path}" >&2; exit 1; }`,
    `chmod 0644 ${file} 2>/dev/null || echo "chmod ${path} failed" >&2`,
    `chown "$own" ${file} 2>/dev/null || echo "chown ${path} failed" >&2`,
  ].join('\n');
}

/** Root exec (a fresh volume's agent dir may still be root-owned), then chown it back. */
async function writeMarker(opts: SyncProfilePluginsOptions, marker: PluginMarker): Promise<string | null> {
  const script = pluginMarkerWriteScript(marker, { home: opts.home, user: opts.user });
  try {
    const res = await opts.backend.runExec(opts.containerId, ['sh', '-c', script], {
      user: '0',
      timeoutMs: MARKER_TIMEOUT_MS,
    });
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout).trim().slice(0, 300);
      // not fatal: the plugins ARE installed, the next start simply re-checks them
      return `recording the installed plugins failed (exit ${res.exitCode})${detail ? `: ${detail}` : ''}`;
    }
    return null;
  } catch (err) {
    return `recording the installed plugins failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}
