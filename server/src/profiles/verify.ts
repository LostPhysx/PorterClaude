// OWNER: v0.4 profiles (issue #4). THE PROFILE VERIFY PROBE.
//
// Everything v0.4 delivers to a container rests on two assumptions about the `claude`
// binary that ships in the host's TOOLS VOLUME — assumptions taken from the docs, never
// from the installed build:
//
//   1. `claude plugin install <ref> -y` exists and is non-interactive (profiles/plugins.ts);
//   2. `/etc/claude-code/managed-settings.json` is honoured, including the keys `env`,
//      `enabledPlugins` and `extraKnownMarketplaces` (profiles/apply.ts).
//
// Plugin sync fails SOFT by design, so a binary that disagrees does not error — it merely
// produces a container whose plugins are mysteriously absent. This probe asks the actual
// binary, inside the actual container, and reports what it found.
//
// THREE HARD RULES, in the order they matter:
//
//   READ ONLY   — only `--version`, `--help`, `list`, `test -f` and `cat`. Nothing here may
//                 install, uninstall, write or delete. A verify must be safe to hit on a
//                 container someone is working in.
//   NO SECRETS  — the managed settings file holds decrypted API keys. Only its EXISTENCE,
//                 its JSON validity and its TOP-LEVEL KEY NAMES are reported; the probe
//                 that reads it carries a redaction placeholder instead of its output, so
//                 no code path can put a value into the response (see `REDACTED_OUTPUT`).
//   NEVER THROW — a failed or timed-out exec becomes `available: false` plus a warning.
//                 The report is diagnostics: half an answer beats a 500.
//
// Every exec runs as the CONTAINER USER (never `user: '0'`): the settings file is 0600 owned
// by that user, so root buys nothing and would only risk root-owned artefacts.
import type { AppContext } from '../context.js';
import { AppError } from '../http/errors.js';
import { agentLoginVolumeFor, loginSetFor } from '../agents/model.js';
import { containerHomeFor } from '../containers/container.js';
import { shQuote } from '../util/slug.js';
import { MANAGED_SETTINGS_PATH } from './apply.js';
import { PLUGIN_AGENT_ID, pluginMarkerPath } from './plugins.js';

/** per-probe ceiling: a hung `claude` must not hold the request open */
const PROBE_TIMEOUT_MS = 15_000;
/** `probes[].output` is a diagnostics excerpt, not a log sink */
export const MAX_PROBE_OUTPUT = 600;
/** hard cap on the number of recorded probes (defence in depth; we run at most six) */
export const MAX_PROBES = 8;

/** stand-in for the one output that must never be reported (see NO SECRETS above) */
export const REDACTED_OUTPUT = '(redacted: the managed settings may contain API keys)';

export interface ProbeResult {
  cmd: string;
  exitCode: number;
  output: string;
}

export interface ProfileVerifyReport {
  profileId: string;
  container: string;
  agentId: string;
  loginSet: string;
  loginVolume: string;
  checkedAt: string;
  cli: { available: boolean; version: string | null };
  pluginCommand: {
    available: boolean;
    supportsYesFlag: boolean;
    listWorks: boolean;
    supportsJsonList: boolean;
    installed: string[];
  };
  managedSettings: { present: boolean; valid: boolean; keys: string[] };
  marker: { present: boolean; installed: string[] };
  desiredPlugins: string[];
  missingPlugins: string[];
  probes: ProbeResult[];
  warnings: string[];
  ok: boolean;
}

// ---------------------------------------------------------------------------
// pure derivation — every rule below is unit-testable without docker
// ---------------------------------------------------------------------------

/** `probes[].output`: trimmed and capped, so one chatty `--help` cannot dominate a report. */
export function capOutput(raw: string): string {
  const text = (raw ?? '').trim();
  return text.length > MAX_PROBE_OUTPUT ? `${text.slice(0, MAX_PROBE_OUTPUT)}…` : text;
}

/**
 * Does this help text advertise the non-interactive flag plugins.ts passes?
 * Both spellings count, but only where they appear as a FLAG (surrounded by whitespace or
 * the usual usage punctuation) — never as part of a longer option or an English word.
 *
 * Feed it the help of the SUBCOMMAND (`claude plugin install --help`): commander prints
 * only `-h, --help` in the Options block of a parent that merely groups subcommands, so
 * asking `claude plugin --help` reports every build as lacking `-y` — measured against
 * 2.1.224, which does accept the flag on `install`.
 */
export function supportsYesFlag(help: string): boolean {
  return /(^|[\s,[(|])(-y|--yes)(?=$|[\s,\]).=|])/.test(help ?? '');
}

/** `claude --version` prints e.g. `1.2.3 (Claude Code)`; keep the whole trimmed first line. */
export function parseVersion(stdout: string): string | null {
  const line = (stdout ?? '').trim().split(/\r?\n/)[0]?.trim();
  return line ? line : null;
}

/**
 * ANSI colour, built from a char code: an ESC literal inside a regex literal is a control
 * character (eslint `no-control-regex`) and an invisible one in the source at that.
 */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

/** a plugin ref: `name`, `@scope/name`, either optionally `@marketplace` */
const REF_RE = /^@?[A-Za-z0-9][A-Za-z0-9._/-]*(@[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

/**
 * `claude plugin list --json`, best effort over the shapes a JSON list can plausibly take:
 * an array of strings, an array of objects (`ref`, or `name` plus an optional marketplace),
 * an object keyed by ref, or any of those wrapped in `{ plugins: … }`. Anything else — and
 * anything that is not JSON at all — yields `null`: an unparsable list must be reported as
 * "the list did not parse", never as "no plugins installed".
 */
export function parseJsonPluginList(stdout: string): string[] | null {
  let data: unknown;
  try {
    data = JSON.parse((stdout ?? '').trim());
  } catch {
    return null;
  }
  const unwrapped =
    data && typeof data === 'object' && !Array.isArray(data) && 'plugins' in (data as Record<string, unknown>)
      ? (data as Record<string, unknown>).plugins
      : data;

  if (Array.isArray(unwrapped)) return dedupe(unwrapped.map(refOfEntry).filter(isRef));
  if (unwrapped && typeof unwrapped === 'object') return dedupe(Object.keys(unwrapped).filter(isRef));
  return null;
}

function refOfEntry(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.trim();
  if (!entry || typeof entry !== 'object') return null;
  const rec = entry as Record<string, unknown>;
  const ref = typeof rec.ref === 'string' ? rec.ref.trim() : '';
  if (ref) return ref;
  const name = typeof rec.name === 'string' ? rec.name.trim() : '';
  if (!name) return null;
  const market =
    typeof rec.marketplace === 'string'
      ? rec.marketplace.trim()
      : typeof rec.source === 'string'
        ? rec.source.trim()
        : '';
  return market && !name.includes('@', 1) ? `${name}@${market}` : name;
}

/**
 * The plain-text fallback. Deliberately CONSERVATIVE: a line contributes a ref only when it
 * is a single token, or when its first token already carries an `@marketplace`. That drops
 * headers ("Installed plugins:"), prose ("No plugins installed") and error text without
 * needing to know this build's exact wording — a false "installed" would tell the user a
 * plugin is present when it is not, which is the one mistake this probe exists to prevent.
 */
export function parseTextPluginList(stdout: string): string[] {
  const out: string[] = [];
  for (const rawLine of (stdout ?? '').split(/\r?\n/)) {
    // strip ANSI colour and a leading bullet
    const line = rawLine
      .replace(ANSI_RE, '')
      .replace(/^\s*[-*•]\s+/, '')
      .trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    const first = tokens[0] as string;
    if (tokens.length > 1 && !first.includes('@', 1)) continue;
    if (isRef(first)) out.push(first);
  }
  return dedupe(out);
}

function isRef(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && REF_RE.test(value);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * TOP-LEVEL KEY NAMES of the managed settings, and nothing else. The raw text goes in and
 * only key names come out — this is the ONLY place the file contents exist, and it returns
 * no value, no nested key and no excerpt of the input, not even on the error path.
 */
export function parseManagedSettingsKeys(raw: string): { valid: boolean; keys: string[] } {
  try {
    const parsed: unknown = JSON.parse((raw ?? '').trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false, keys: [] };
    return { valid: true, keys: Object.keys(parsed as Record<string, unknown>).sort() };
  } catch {
    return { valid: false, keys: [] };
  }
}

/** the marker is ours (plugins.ts) and holds refs only — still parsed defensively. */
export function parseMarker(raw: string): { present: boolean; installed: string[] } {
  const text = (raw ?? '').trim();
  if (!text) return { present: false, installed: [] };
  try {
    const parsed = JSON.parse(text) as { installed?: unknown };
    const installed = Array.isArray(parsed.installed) ? parsed.installed.filter(isRef) : [];
    return { present: true, installed: dedupe(installed) };
  } catch {
    return { present: true, installed: [] };
  }
}

/**
 * Desired minus installed — ONLY meaningful when the list actually worked. A build whose
 * `plugin list` we could not read must report "unknown", i.e. no missing plugins, rather
 * than accusing every configured ref of being absent.
 *
 * A ref matches either exactly or by plugin NAME: `claude plugin list` may print the bare
 * name of something the profile asked for as `name@marketplace`.
 */
export function missingPluginsOf(desired: string[], installed: string[], listWorks: boolean): string[] {
  if (!listWorks) return [];
  const present = new Set(installed);
  const presentNames = new Set(installed.map(pluginNameOnly));
  return desired.filter((ref) => !present.has(ref) && !presentNames.has(pluginNameOnly(ref)));
}

/** `name@marketplace` -> `name`; an npm scope keeps its leading `@` (the LAST `@` separates). */
function pluginNameOnly(ref: string): string {
  const at = ref.lastIndexOf('@');
  return at > 0 ? ref.slice(0, at) : ref;
}

/** The verdict: the CLI is there, it speaks `plugin`, and nothing the profile wants is absent. */
export function computeOk(
  report: Pick<ProfileVerifyReport, 'cli' | 'pluginCommand' | 'desiredPlugins' | 'missingPlugins'>,
): boolean {
  return (
    report.cli.available &&
    report.pluginCommand.available &&
    (report.desiredPlugins.length === 0 || report.missingPlugins.length === 0)
  );
}

// ---------------------------------------------------------------------------
// the probe itself
// ---------------------------------------------------------------------------

/** what one exec returned, or why it did not run at all */
interface ProbeOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  error: string | null;
}

/** the exec surface this probe needs; the real one is `DockerBackend.runExec` bound to an id */
export interface ProbeExec {
  (cmd: string[], opts: { timeoutMs: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * `sh -c` that prints the file only when it exists; exit 3 = "not there". Its output is
 * NEVER recorded (see `REDACTED_OUTPUT`), so `present` costs no second exec.
 */
function settingsReadScript(): string {
  const file = shQuote(MANAGED_SETTINGS_PATH);
  return `[ -f ${file} ] || exit 3\ncat ${file}`;
}

export interface RunVerifyProbesInput {
  exec: ProbeExec;
  /** the container's $HOME — only used to locate the plugin sync marker */
  home: string;
  desiredPlugins: string[];
}

/** everything in the report that comes out of the container */
export type ProfileVerifyProbeResult = Pick<
  ProfileVerifyReport,
  'cli' | 'pluginCommand' | 'managedSettings' | 'marker' | 'missingPlugins' | 'probes' | 'warnings' | 'ok'
>;

/**
 * Run the (at most six) read-only probes and derive the report body. Split from
 * `verifyProfile` so the exec-level behaviour can be tested against a scripted exec, with
 * no config store, no host manager and no docker anywhere.
 */
export async function runVerifyProbes(input: RunVerifyProbesInput): Promise<ProfileVerifyProbeResult> {
  const probes: ProbeResult[] = [];
  const warnings: string[] = [];

  const run = async (cmd: string[], opts: { label?: string; redact?: boolean } = {}): Promise<ProbeOutcome> => {
    const label = opts.label ?? cmd.join(' ');
    let outcome: ProbeOutcome;
    try {
      const res = await input.exec(cmd, { timeoutMs: PROBE_TIMEOUT_MS });
      outcome = { exitCode: res.exitCode, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: null };
    } catch (err) {
      // a dead engine, a killed exec, a timeout: a probe failure is data, never a 500
      outcome = { exitCode: -1, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) };
      warnings.push(`the probe '${label}' could not be run: ${outcome.error}`);
    }
    if (probes.length < MAX_PROBES) {
      probes.push({
        cmd: label,
        exitCode: outcome.exitCode,
        // the settings probe is redacted HERE, before its text can reach the report at all
        output: opts.redact ? REDACTED_OUTPUT : capOutput(outcome.error ?? `${outcome.stdout}\n${outcome.stderr}`),
      });
    }
    return outcome;
  };

  // 1. is there a claude CLI at all?
  const version = await run(['claude', '--version']);
  const cli = {
    available: version.exitCode === 0,
    version: version.exitCode === 0 ? parseVersion(version.stdout) : null,
  };
  if (!cli.available && !version.error) {
    warnings.push('`claude --version` did not succeed: the tools volume may not carry a claude CLI');
  }

  // 2. does it know `plugin`, and does `install` take -y?
  const pluginCommand = {
    available: false,
    supportsYesFlag: false,
    listWorks: false,
    supportsJsonList: false,
    installed: [] as string[],
  };
  if (cli.available) {
    const help = await run(['claude', 'plugin', '--help']);
    pluginCommand.available = help.exitCode === 0;
    if (pluginCommand.available) {
      // the flag lives on the SUBCOMMAND, not on the group that contains it
      const installHelp = await run(['claude', 'plugin', 'install', '--help']);
      pluginCommand.supportsYesFlag =
        installHelp.exitCode === 0
          ? supportsYesFlag(`${installHelp.stdout}
${installHelp.stderr}`)
          : supportsYesFlag(`${help.stdout}
${help.stderr}`);
      if (!pluginCommand.supportsYesFlag) {
        warnings.push(
          'this claude build does not advertise `-y`/`--yes` for `plugin install`: server-side plugin ' +
            'installs may hang on a prompt and be reported as failed',
        );
      }

      // 3. the machine-readable listing first, the human one only when that failed
      const json = await run(['claude', 'plugin', 'list', '--json']);
      const parsed = json.exitCode === 0 ? parseJsonPluginList(json.stdout) : null;
      if (parsed) {
        pluginCommand.supportsJsonList = true;
        pluginCommand.listWorks = true;
        pluginCommand.installed = parsed;
      } else {
        const text = await run(['claude', 'plugin', 'list']);
        if (text.exitCode === 0) {
          pluginCommand.listWorks = true;
          pluginCommand.installed = parseTextPluginList(text.stdout);
        } else if (!text.error) {
          warnings.push('`claude plugin list` did not succeed: the installed plugins cannot be verified');
        }
      }
    } else if (!help.error) {
      warnings.push(
        '`claude plugin --help` did not succeed: this build has no plugin command, so profile ' +
          'plugins will never be installed',
      );
    }
  }

  // 4. the managed settings — EXISTENCE, VALIDITY AND KEY NAMES ONLY
  const settings = await run(['sh', '-c', settingsReadScript()], {
    label: `sh -c '[ -f ${MANAGED_SETTINGS_PATH} ] && cat'`,
    redact: true,
  });
  const managedSettings =
    settings.exitCode === 0
      ? { present: true, ...parseManagedSettingsKeys(settings.stdout) }
      : { present: false, valid: false, keys: [] as string[] };
  if (settings.exitCode === 0 && !managedSettings.valid) {
    warnings.push(`${MANAGED_SETTINGS_PATH} exists but does not parse as a JSON object`);
  }
  if (settings.exitCode > 0 && settings.exitCode !== 3) {
    warnings.push(`${MANAGED_SETTINGS_PATH} could not be read as the container user (exit ${settings.exitCode})`);
  }

  // 5. our own sync marker (the plugin files THIS server put into the login volume)
  const markerPath = pluginMarkerPath(input.home);
  const markerRead = await run(['sh', '-c', `cat ${shQuote(markerPath)} 2>/dev/null || true`], {
    label: `cat ${markerPath}`,
  });
  const marker = markerRead.exitCode === 0 ? parseMarker(markerRead.stdout) : { present: false, installed: [] };

  const missingPlugins = missingPluginsOf(input.desiredPlugins, pluginCommand.installed, pluginCommand.listWorks);
  if (missingPlugins.length > 0) {
    warnings.push(`the profile wants plugins this container does not have installed: ${missingPlugins.join(', ')}`);
  }

  return {
    cli,
    pluginCommand,
    managedSettings,
    marker,
    missingPlugins,
    probes,
    warnings,
    ok: computeOk({ cli, pluginCommand, desiredPlugins: input.desiredPlugins, missingPlugins }),
  };
}

/**
 * `POST /api/profiles/:id/verify` — resolve the profile and the running container, then run
 * the read-only probes inside it.
 *
 * @throws AppError.notFound (unknown profile / unknown container),
 *         AppError.conflict (container not running, or it does not mount the claude agent)
 */
export async function verifyProfile(
  ctx: AppContext,
  profileId: string,
  container: string,
): Promise<ProfileVerifyReport> {
  // 404 before anything touches docker
  ctx.profiles.require(profileId);
  const profile = ctx.profiles.stored(profileId);

  // notFound / conflict('not running') come from requireRunningContainer verbatim
  const target = await ctx.containers.resolveExecTarget(container);
  if (target.containerAgents && !target.containerAgents.includes(PLUGIN_AGENT_ID)) {
    throw AppError.conflict(
      `container '${container}' does not mount the '${PLUGIN_AGENT_ID}' agent, so there is nothing to verify`,
    );
  }

  const home = containerHomeFor(target.general);
  const loginSet = loginSetFor(profileId, profile, PLUGIN_AGENT_ID);
  const desiredPlugins = [...new Set((profile?.agents[PLUGIN_AGENT_ID]?.plugins ?? []).map((p) => p.ref))];

  const body = await runVerifyProbes({
    exec: (cmd, opts) => target.backend.runExec(target.containerId, cmd, opts),
    home,
    desiredPlugins,
  });

  return {
    profileId,
    container,
    agentId: PLUGIN_AGENT_ID,
    loginSet,
    loginVolume: agentLoginVolumeFor(target.general.volumePrefix, PLUGIN_AGENT_ID, loginSet),
    checkedAt: new Date().toISOString(),
    desiredPlugins,
    ...body,
  };
}
