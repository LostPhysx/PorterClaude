// OWNER: B2. Recipe builds, the shared tools volume, custom-image validation, job registry.
//
// v0.2: every public method takes the HOST it works on as its first argument.
//   * settings come from `hosts.settingsFor(hostId)`, transports from
//     `hosts.backendFor(hostId)` / `tryBackendFor(hostId)`; the private helpers take the
//     resolved backend so nothing below re-resolves a host;
//   * the job registry is keyed per host: `JobSummary.hostId`, the "already running" checks
//     and `listJobs(hostId)` are host-scoped, so a build on host A never blocks host B, and
//     a job of another host is invisible (the routes answer 404);
//   * the tools sync INSTALLS THE AGENTS of the host (PORTERCLAUDE_AGENTS) and performs the
//     one-time legacy claude import; `<toolsMount>/AGENTS.json` is what `ToolsStatus.agents`
//     and `agentStatuses()` report.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { ServiceDeps } from '../context.js';
import type { GeneralConfig } from '../config/schema.js';
import type { BuildLogLine, DockerBackend, ImageSummary } from '../backends/types.js';
import { AppError } from '../http/errors.js';
import { IMAGE_LABELS } from '../sessions/model.js';
import type { HostConfig } from '../hosts/model.js';
import type { AgentDefinition, ToolsAgentManifest } from '../agents/model.js';
import { TOOLS_AGENTS_ENV, TOOLS_AGENT_MANIFEST, agentAuthVolumeFor } from '../agents/model.js';
import { shortId } from '../util/ids.js';
import type { RecipeDef } from './recipes.js';
import { RECIPES, getRecipe, recipeImageRef, toolsImageRef } from './recipes.js';
import { createTarContext, hashContext } from './tarContext.js';
import type { TarContextOptions } from './tarContext.js';

export type JobKind = 'build' | 'pull' | 'tools-sync';
export type JobStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled';

export interface JobSummary {
  id: string;
  /** the host this job runs against (v0.2) */
  hostId: string;
  kind: JobKind;
  /** recipe name, image ref or volume name */
  target: string;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** number of log lines produced so far (poll GET /api/images/jobs/:id?since=) */
  lineCount: number;
}

export interface RecipeStatus extends RecipeDef {
  /** <ns>/<name>:latest */
  imageRef: string;
  built: boolean;
  imageId: string | null;
  /** when the ENGINE created the image, i.e. when the build finished */
  builtAt: string | null;
  sizeBytes: number | null;
  /**
   * The Claude Code version actually installed in the image, read out of
   * /etc/porterclaude/claude-version (see docker/recipes/common.sh). `null` while it is
   * still unknown: the first status call after a restart kicks off the read in the
   * background and answers it on the next poll.
   */
  claudeVersion: string | null;
  /** what the image was BUILT with ('stable' | 'latest' | an exact version) */
  claudeChannel: string | null;
  /** stored porterclaude.context-hash differs from the current docker/recipes/<name> hash */
  outdated: boolean;
  /** a build job for this recipe is running */
  building: boolean;
  jobId: string | null;
}

/**
 * One look INSIDE the tools volume: `error` separates "cannot read" from "there is none".
 *
 * `bootstrap` is what makes a session startable at all — every v0.2 container runs
 * `<toolsMount>/entrypoint.sh` as its entrypoint (sessions/container.ts), so a volume without
 * it crash-loops the container before anything else can go wrong. `null` means the volume
 * could not be looked into (no image on the engine to read it with), which callers must treat
 * as "unknown", never as "not synced".
 */
export interface ToolsProbeRead {
  manifest: ToolsAgentManifest | null;
  bootstrap: boolean | null;
  error: string | null;
}

/** What the tools volume of a host really carries for one agent (from AGENTS.json). */
export interface AgentToolStatus {
  id: string;
  installed: boolean;
  version: string | null;
  installedAt: string | null;
  error: string | null;
}

export interface ToolsStatus {
  /** the host this status describes (v0.2) */
  hostId: string;
  volume: string;
  imageRef: string;
  /** agents the tools volume carries, read from <toolsMount>/AGENTS.json (v0.2) */
  agents: AgentToolStatus[];
  /** the tools volume exists on the engine */
  present: boolean;
  lastSyncedAt: string | null;
  /** the version in the image's /payload/VERSION (null while unknown, see RecipeStatus) */
  claudeVersion: string | null;
  /** what the image was BUILT with ('stable' | 'latest' | an exact version) */
  claudeChannel: string | null;
  /** hash of the current docker/tools context (null when it cannot be read) */
  contextHash: string | null;
  /**
   * the tools image is missing or its stored porterclaude.context-hash differs from
   * `contextHash`, i.e. the volume still holds the entrypoint.sh / claude binaries of an
   * older PorterClaude build. The next sync rebuilds it (mirrors RecipeStatus.outdated).
   */
  outdated: boolean;
  syncing: boolean;
  jobId: string | null;
  /**
   * Why this status is incomplete: the host has no usable transport, or reading its volumes /
   * tools image / AGENTS.json failed. `null` when everything could be read — that is what
   * separates "nothing was ever synced here" (present:false, error:null) from "the engine did
   * not answer" (present:false + error).
   */
  error: string | null;
}

export interface CustomImageCheck {
  image: string;
  ok: boolean;
  existsLocally: boolean;
  pulled: boolean;
  architecture: string | null;
  user: string | null;
  /** e.g. "no tmux: terminals will not survive a reload", "no package manager detected" */
  warnings: string[];
  error: string | null;
}

const MAX_JOBS = 50;
const MAX_JOB_LINES = 2000;
const TOOLS_SYNC_LABEL = 'porterclaude.tools-sync';

/**
 * env var of the populate container that turns off the carry-over of an unchanged agent
 * (docker/tools/install-agents.sh). Without it an installed agent is NEVER reinstalled —
 * its SPEC.json does not change when a new upstream version is released, so `claude`,
 * `opencode`, … would stay at the version of the first sync forever. `force: true` sets it:
 * that is the (only) upgrade path for the agents themselves.
 */
const TOOLS_FORCE_ENV = 'PORTERCLAUDE_TOOLS_FORCE';

/** how long a read tools volume (AGENTS.json + entrypoint.sh) is served from memory */
const MANIFEST_TTL_MS = 30_000;

/** what the volume probe prints when `<toolsMount>/entrypoint.sh` is there and executable */
const TOOLS_BOOTSTRAP_MARKER = 'PC_TOOLS_BOOTSTRAP_OK';

/**
 * One `sh -c` that answers both questions the tools volume is asked: is the bootstrap the
 * session entrypoint needs there, and what does AGENTS.json say. The marker carries no
 * braces, so `parseAgentManifest` (first `{` .. last `}`) is unaffected by it.
 */
const TOOLS_PROBE_CMD =
  `[ -x /out/entrypoint.sh ] && echo ${TOOLS_BOOTSTRAP_MARKER}; ` +
  `cat /out/${TOOLS_AGENT_MANIFEST} 2>/dev/null || true`;

/** marker file inside `<prefix>auth-claude` that records the one-time v0.1 login import */
const LEGACY_IMPORT_MARKER = '.pc-import-v1';

/** what the legacy-import container prints so the job log (and this process) can tell */
const IMPORT_DONE = 'PC_IMPORT_DONE';
const IMPORT_SKIPPED = 'PC_IMPORT_SKIPPED';

/**
 * Where an image records the exact Claude Code version it ships: recipes write
 * /etc/porterclaude/claude-version (docker/recipes/common.sh), the tools image writes
 * /payload/VERSION (docker/tools/fetch-claude.sh). Neither can be labelled at build time -
 * the version is only known once the installer ran - so it is read back out of the built
 * image with a one-shot container.
 */
const VERSION_PROBE_CMD =
  'cat /etc/porterclaude/claude-version 2>/dev/null || cat /payload/VERSION 2>/dev/null || true';

/** the build prints this so an uncached build needs no probe at all (common.sh). */
const VERSION_LOG_RE = /PORTERCLAUDE_CLAUDE_VERSION=([^\s]+)/;

/** how long a failed version read is remembered before it is tried again. */
const VERSION_RETRY_MS = 5 * 60_000;

interface VersionEntry {
  version: string | null;
  at: number;
}

/**
 * Pick the version out of whatever the probe container printed. Docker's non-tty log
 * framing puts 8 binary bytes in front of every line, so the text is stripped down to
 * printable ASCII first and a semver-shaped token wins over the rest of the line
 * (`claude --version` prints "2.1.233 (Claude Code)").
 */
export function parseClaudeVersion(raw: string): string | null {
  for (const line of raw.split('\n')) {
    const text = line.replace(/[^\x20-\x7e]/g, '').trim();
    if (!text) continue;
    const semver = /\d+\.\d+\.\d+[A-Za-z0-9.+-]*/.exec(text);
    if (semver) return semver[0];
    // anything else must at least LOOK like a version; log noise ("log output", a docker
    // error line, ...) is not a version and must stay null rather than reach the UI
    if (/^\d[A-Za-z0-9._+-]{0,63}$/.test(text)) return text;
  }
  return null;
}

/**
 * `<toolsMount>/AGENTS.json` as printed by a one-shot `cat`. Defensive on purpose: the log
 * may carry a docker error line, a shell message or nothing at all, and a tools volume
 * written by an older PorterClaude has no manifest — all of that must read as "unknown"
 * rather than throw inside a status call.
 */
export function parseAgentManifest(raw: string): ToolsAgentManifest | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as { syncedAt?: unknown; agents?: unknown };
  if (!Array.isArray(record.agents)) return null;
  const agents: ToolsAgentManifest['agents'] = [];
  for (const entry of record.agents) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Record<string, unknown>;
    if (typeof a.id !== 'string' || !a.id) continue;
    agents.push({
      id: a.id,
      command: typeof a.command === 'string' ? a.command : a.id,
      installed: a.installed === true,
      version: typeof a.version === 'string' && a.version ? a.version : null,
      error: typeof a.error === 'string' && a.error ? a.error : null,
    });
  }
  return {
    syncedAt: typeof record.syncedAt === 'string' ? record.syncedAt : new Date(0).toISOString(),
    agents,
  };
}

interface JobRecord {
  id: string;
  /** the host this job runs against; set by startJob() */
  hostId: string;
  kind: JobKind;
  target: string;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** ring buffer of the last MAX_JOB_LINES lines */
  lines: string[];
  /** how many lines were evicted from the front (keeps `since` an append-only cursor) */
  dropped: number;
  abort: AbortController;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** the PORTERCLAUDE_CLAUDE_VERSION=<v> marker common.sh prints, if this line carries it. */
function versionFromBuildLine(line: BuildLogLine): string | null {
  const text = line.stream ?? '';
  const match = VERSION_LOG_RE.exec(text);
  return match ? (parseClaudeVersion(match[1] ?? '') ?? null) : null;
}

/** `sha256:0123456789ab…` — enough to identify an image in a job log. */
/** cache key of a tools-volume read: the answer belongs to a (host, volume) pair. */
function manifestKey(hostId: string, toolsVolume: string): string {
  return `${hostId}\n${toolsVolume}`;
}

function shortImageId(id: string): string {
  const hex = id.startsWith('sha256:') ? id.slice(7) : id;
  return `sha256:${hex.slice(0, 12)}`;
}

export class ImageService {
  private readonly jobs = new Map<string, JobRecord>();
  /** hostId -> when its tools volume was last populated by THIS process */
  private readonly lastToolsSync = new Map<string, string>();
  /**
   * `manifestKey(hostId, volume)` -> cached look into the tools volume (invalidated after
   * every sync). Only SUCCESSFUL reads are cached: a manifest that came back null because the
   * engine was unreachable must not make a recovered host report `installed:false` for
   * another MANIFEST_TTL_MS. The VOLUME is part of the key because it is a per-host setting a
   * user can repoint - the answer belongs to the volume that was read, not to the host.
   */
  private readonly manifests = new Map<
    string,
    { at: number; manifest: ToolsAgentManifest | null; bootstrap: boolean | null }
  >();
  /** hosts whose legacy claude login was imported in this process (the marker is authoritative) */
  private readonly legacyImported = new Set<string>();
  /** image id -> the Claude Code version that image ships (null = read failed) */
  private readonly claudeVersions = new Map<string, VersionEntry>();
  /** in-flight version reads, so a polling UI cannot start one container per poll */
  private readonly versionProbes = new Map<string, Promise<string | null>>();

  constructor(private readonly deps: ServiceDeps) {}

  // -------------------------------------------------------------------------
  // images / recipes
  // -------------------------------------------------------------------------

  /** Plain docker image list for the picker. */
  async listImages(hostId: string): Promise<ImageSummary[]> {
    return this.deps.hosts.backendFor(hostId).listImages();
  }

  /** RECIPES joined with inspectImage() + the current context hash. */
  async recipeStatuses(hostId: string): Promise<RecipeStatus[]> {
    const general = this.deps.hosts.settingsFor(hostId);
    const backend = this.tryBackend(hostId);

    return Promise.all(
      RECIPES.map(async (recipe): Promise<RecipeStatus> => {
        const imageRef = recipeImageRef(general.imageNamespace, recipe.name);
        const job = this.runningJobFor(hostId, 'build', recipe.name);

        let inspect = null;
        if (backend) {
          try {
            inspect = await backend.inspectImage(imageRef);
          } catch (err) {
            this.deps.log.debug({ err, imageRef }, 'inspecting recipe image failed');
          }
        }

        let contextHash: string | null = null;
        try {
          contextHash = await hashContext(this.recipeContext(recipe.name));
        } catch (err) {
          this.deps.log.debug({ err, recipe: recipe.name }, 'hashing recipe context failed');
        }

        const labels = inspect?.labels ?? {};
        return {
          ...recipe,
          imageRef,
          built: Boolean(inspect),
          imageId: inspect?.id ?? null,
          // the engine stamps Created when the build FINISHES; the legacy
          // porterclaude.built-at label (build start) only serves images built before.
          builtAt: inspect?.createdAt ?? labels[IMAGE_LABELS.builtAt] ?? null,
          sizeBytes: inspect?.sizeBytes ?? null,
          claudeVersion: this.claudeVersionOf(backend, inspect?.id ?? null),
          claudeChannel: labels[IMAGE_LABELS.claudeVersion] ?? null,
          outdated: Boolean(inspect && contextHash && labels[IMAGE_LABELS.contextHash] !== contextHash),
          building: Boolean(job),
          jobId: job?.id ?? null,
        };
      }),
    );
  }

  /**
   * Start a build job (returns immediately; poll the job for output).
   * 409 (AppError.conflict) when a build for that recipe is already running.
   *
   * A rebuild whose context hash still matches the built image is SKIPPED (exactly like
   * syncTools): a fully cached rebuild used to produce a new image id anyway - the labels
   * carried a fresh timestamp - which untagged the image every existing session runs, so
   * those sessions started reporting a bare `sha256:…` and the old image could not be
   * collected. `force` (or `noCache`/`pull`, which only make sense when the user wants a
   * real rebuild, e.g. to pick up a new base image) always builds.
   */
  async buildRecipe(
    hostId: string,
    name: string,
    opts?: { noCache?: boolean; pull?: boolean; force?: boolean },
  ): Promise<JobSummary> {
    const recipe = getRecipe(name);
    if (!recipe) throw AppError.notFound(`unknown recipe '${name}'`);
    const running = this.runningJobFor(hostId, 'build', name);
    if (running) {
      throw AppError.conflict(`a build for recipe '${name}' is already running on this host`, {
        jobId: running.id,
      });
    }

    const general = this.deps.hosts.settingsFor(hostId);
    const backend = this.deps.hosts.backendFor(hostId);
    const tag = recipeImageRef(general.imageNamespace, recipe.name);
    const forced = Boolean(opts?.force || opts?.noCache || opts?.pull);

    return this.startJob(hostId, 'build', recipe.name, async (job) => {
      const context = this.recipeContext(recipe.name);
      await this.requireDir(context.dir, `recipe context '${context.dir}'`);

      // Remembered BEFORE the build so the image this tag is about to leave behind can be
      // collected afterwards (see removeReplacedImage).
      const existing = await backend.inspectImage(tag).catch(() => null);
      const previousId = existing?.id ?? null;

      const contextHash = await hashContext(context);
      if (!forced && existing && existing.labels[IMAGE_LABELS.contextHash] === contextHash) {
        this.append(
          job,
          `${tag} is up to date (context hash ${contextHash.slice(0, 12)}); nothing to build. ` +
            'Use force to rebuild anyway.',
        );
        await this.recordClaudeVersion(backend, job, existing.id, null);
        return;
      }

      this.append(job, `building ${tag} (context hash ${contextHash.slice(0, 12)})`);

      const stream = this.contextStream(job, context);
      let logged: string | null = null;
      await backend.buildImage({
        tag,
        context: stream,
        dockerfile: 'Dockerfile',
        // No porterclaude.built-at label: it made every rebuild produce a different image
        // id even when nothing changed, and it recorded the build START. The engine's
        // own image Created timestamp is the build finish time and is used instead.
        labels: {
          [IMAGE_LABELS.recipe]: recipe.name,
          [IMAGE_LABELS.contextHash]: contextHash,
        },
        pull: opts?.pull ?? false,
        noCache: opts?.noCache ?? false,
        onLog: (line) => {
          logged = logged ?? versionFromBuildLine(line);
          this.appendBuildLine(job, line);
        },
        signal: job.abort.signal,
      });
      stream.destroy();
      this.append(job, `built ${tag}`);
      const built = await backend.inspectImage(tag).catch(() => null);
      await this.recordClaudeVersion(backend, job, built?.id ?? null, logged);
      await this.removeReplacedImage(backend, job, previousId, tag);
    });
  }

  async pull(hostId: string, image: string): Promise<JobSummary> {
    const backend = this.deps.hosts.backendFor(hostId);
    const running = this.runningJobFor(hostId, 'pull', image);
    if (running) throw AppError.conflict(`a pull for '${image}' is already running`, { jobId: running.id });

    return this.startJob(hostId, 'pull', image, async (job) => {
      this.append(job, `pulling ${image}`);
      await backend.pullImage(image, {
        onLog: (line) => this.appendBuildLine(job, line),
        signal: job.abort.signal,
      });
      this.append(job, `pulled ${image}`);
    });
  }

  // -------------------------------------------------------------------------
  // tools volume
  // -------------------------------------------------------------------------

  async toolsStatus(hostId: string): Promise<ToolsStatus> {
    const general = this.deps.hosts.settingsFor(hostId);
    const imageRef = toolsImageRef(general.imageNamespace);
    const job = this.runningJobFor(hostId, 'tools-sync', general.toolsVolume);
    const transport = this.backendOrError(hostId);

    let present = false;
    let claudeVersion: string | null = null;
    let claudeChannel: string | null = null;
    let lastSyncedAt = this.lastToolsSync.get(hostId) ?? null;
    let imageHash: string | null = null;
    let built = false;

    let contextHash: string | null = null;
    try {
      contextHash = await hashContext(this.toolsContext());
    } catch (err) {
      this.deps.log.debug({ err }, 'hashing the tools context failed');
    }

    // first transport/read failure wins: it is what the panel shows instead of pretending
    // "not built / not populated" for a host that simply did not answer
    let error: string | null = transport.error;
    if (transport.backend) {
      const engine = transport.backend;
      try {
        const volumes = await engine.listVolumes();
        present = volumes.some((v) => v.name === general.toolsVolume);
      } catch (err) {
        error = error ?? errMessage(err);
        this.deps.log.debug({ err }, 'listing volumes for tools status failed');
      }
      try {
        const inspect = await engine.inspectImage(imageRef);
        built = Boolean(inspect);
        claudeVersion = this.claudeVersionOf(engine, inspect?.id ?? null);
        claudeChannel = inspect?.labels[IMAGE_LABELS.claudeVersion] ?? null;
        imageHash = inspect?.labels[IMAGE_LABELS.contextHash] ?? null;
        lastSyncedAt = lastSyncedAt ?? inspect?.createdAt ?? inspect?.labels[IMAGE_LABELS.builtAt] ?? null;
      } catch (err) {
        error = error ?? errMessage(err);
        this.deps.log.debug({ err, imageRef }, 'inspecting tools image failed');
      }
    }

    // A missing image counts as outdated only once the volume claims to be populated:
    // on a fresh install "nothing built yet" is already reported by present:false.
    const outdated = Boolean(contextHash) && (built ? imageHash !== contextHash : present);

    const { statuses: agents, error: manifestError } = await this.agentStatusesWithError(hostId);
    error = error ?? manifestError;
    // the `claude` entry of the manifest is the authoritative version once a v0.2 sync ran;
    // the image probe above only says what the tools IMAGE ships (kept for compatibility)
    const claudeAgent = agents.find((a) => a.id === 'claude');
    if (claudeAgent?.version) claudeVersion = claudeAgent.version;

    return {
      hostId,
      agents,
      volume: general.toolsVolume,
      imageRef,
      present,
      lastSyncedAt,
      claudeVersion,
      claudeChannel,
      contextHash,
      outdated,
      syncing: Boolean(job),
      jobId: job?.id ?? null,
      error,
    };
  }

  /**
   * Populate the shared read-only tools volume:
   *   1. build <ns>/tools:latest from <paths.toolsDir> when it is missing or when its
   *      stored porterclaude.context-hash no longer matches the current context (exactly
   *      what RecipeStatus.outdated reports for recipes); `force` rebuilds unconditionally,
   *      pulling the base image and ignoring the layer cache. This is what makes an upgrade
   *      take effect: re-populating the volume from a stale image would keep the old
   *      entrypoint.sh and the old claude binaries forever.
   *   2. createVolume(general.toolsVolume) if missing
   *   3. run a one-shot container from that image with the volume mounted rw at /out
   *   4. waitContainer -> non-zero exit fails the job; then removeContainer
   *
   * v0.2 — the sync is what INSTALLS THE AGENTS of this host:
   *   * `PORTERCLAUDE_AGENTS=<json>` (agents/model.ts TOOLS_AGENTS_ENV,
   *     `agents.installSpecsForHost(host)`) goes into the populate container; it installs
   *     every enabled agent into the volume and writes `<toolsMount>/AGENTS.json`;
   *   * a single agent that fails to install is a WARNING in the job log, not a failed job
   *     (the manifest records `installed:false` + the error, and the panel shows it);
   *   * `force` is ALSO the agent upgrade switch: it passes `PORTERCLAUDE_TOOLS_FORCE=1`, so
   *     the installer stops carrying installed agents over unchanged and reinstalls every one
   *     of them (plus the bundled runtimes) from source. A plain sync only installs what is
   *     new, because an agent's spec does not change when upstream releases a version;
   *   * afterwards, ONE-TIME LEGACY IMPORT for the claude agent (only while the v0.1 shared
   *     volume exists on this host and the target auth volume has no marker yet): a one-shot
   *     root container mounts the old `sharedClaudeVolume` at /legacy, `sharedClaudeHomeVolume`
   *     at /legacy-home and `<volumePrefix>auth-claude` at /auth, copies them into
   *     `/auth/claude/` + `/auth/claude.json`, chowns to the volume owner and touches
   *     `/auth/.pc-import-v1`. The old volumes are NEVER deleted — the import must stay
   *     repeatable (delete the marker) and a rollback to v0.1 must keep working.
   */
  async syncTools(hostId: string, opts?: { force?: boolean }): Promise<JobSummary> {
    const host = this.deps.hosts.require(hostId);
    const general = this.deps.hosts.settingsForHost(host);
    const backend = this.deps.hosts.backendFor(hostId);
    const running = this.runningJobFor(hostId, 'tools-sync', general.toolsVolume);
    if (running) throw AppError.conflict('a tools sync is already running on this host', { jobId: running.id });

    const imageRef = toolsImageRef(general.imageNamespace);

    return this.startJob(hostId, 'tools-sync', general.toolsVolume, async (job) => {
      const context = this.toolsContext();
      await this.requireDir(context.dir, `tools context '${context.dir}'`);

      const contextHash = await hashContext(context);
      const existing = await backend.inspectImage(imageRef);
      const previousId = existing?.id ?? null;
      const storedHash = existing?.labels[IMAGE_LABELS.contextHash] ?? null;
      if (opts?.force || !existing || storedHash !== contextHash) {
        const why = !existing
          ? 'not built yet'
          : opts?.force
            ? 'forced'
            : `context hash ${storedHash ? storedHash.slice(0, 12) : 'missing'} -> ${contextHash.slice(0, 12)}`;
        this.append(job, `building ${imageRef} (${why})`);
        const stream = this.contextStream(job, context);
        let logged: string | null = null;
        await backend.buildImage({
          tag: imageRef,
          context: stream,
          dockerfile: 'Dockerfile',
          // see buildRecipe: no built-at label, the engine's Created is the build finish
          labels: {
            [IMAGE_LABELS.contextHash]: contextHash,
          },
          pull: Boolean(opts?.force),
          noCache: Boolean(opts?.force),
          onLog: (line) => {
            logged = logged ?? versionFromBuildLine(line);
            this.appendBuildLine(job, line);
          },
          signal: job.abort.signal,
        });
        stream.destroy();
        const built = await backend.inspectImage(imageRef).catch(() => null);
        await this.recordClaudeVersion(backend, job, built?.id ?? null, logged);
        await this.removeReplacedImage(backend, job, previousId, imageRef);
      } else {
        this.append(job, `reusing existing image ${imageRef} (context hash ${contextHash.slice(0, 12)})`);
      }

      this.append(job, `ensuring volume ${general.toolsVolume}`);
      await backend.createVolume({
        name: general.toolsVolume,
        labels: { [TOOLS_SYNC_LABEL]: 'true' },
      });

      // what the populate container installs into the volume (agents/model.ts contract)
      const specs = this.deps.agents.installSpecsForHost(host);
      this.append(
        job,
        specs.length
          ? `installing ${specs.length} agent(s): ${specs.map((a) => a.id).join(', ')}`
          : 'no agents enabled on this host: the volume gets the runtimes only',
      );
      // force = "upgrade": no carry-over, every agent and runtime is fetched again
      const forceAgents = Boolean(opts?.force);
      if (forceAgents && specs.length) {
        this.append(job, 'forced: every agent is reinstalled from source (no carry-over)');
      }

      const containerName = `porterclaude-tools-sync-${shortId(4)}`;
      this.append(job, `running ${containerName}`);
      const created = await backend.createContainer({
        name: containerName,
        image: imageRef,
        labels: { [TOOLS_SYNC_LABEL]: 'true' },
        env: {
          [TOOLS_AGENTS_ENV]: JSON.stringify(specs),
          ...(forceAgents ? { [TOOLS_FORCE_ENV]: '1' } : {}),
        },
        mounts: [{ type: 'volume', source: general.toolsVolume, target: '/out', readOnly: false }],
        tty: false,
        openStdin: false,
        restartPolicy: 'no',
      });

      let exitCode = -1;
      try {
        await backend.startContainer(created.id);
        const result = await backend.waitContainer(created.id);
        exitCode = result.statusCode;
        const logs = await backend.containerLogs(created.id, { tail: 500 }).catch(() => '');
        for (const line of logs.split('\n')) if (line.trim()) this.append(job, line.trimEnd());
      } finally {
        try {
          await backend.removeContainer(created.id, { force: true, removeVolumes: false });
        } catch (err) {
          this.deps.log.warn({ err, containerId: created.id }, 'removing tools-sync container failed');
        }
      }

      if (exitCode !== 0) {
        throw AppError.internal(`tools sync container exited with code ${exitCode}`);
      }
      this.lastToolsSync.set(hostId, new Date().toISOString());
      this.manifests.delete(manifestKey(hostId, general.toolsVolume));
      this.append(job, `tools volume ${general.toolsVolume} populated`);

      // a single failed agent is a warning, never a failed sync
      const { manifest, bootstrap } = await this.readToolsVolume(backend, general);
      this.manifests.set(manifestKey(hostId, general.toolsVolume), {
        at: Date.now(),
        manifest,
        bootstrap,
      });
      for (const agent of manifest?.agents ?? []) {
        this.append(
          job,
          agent.installed
            ? `agent ${agent.id}: installed${agent.version ? ` (${agent.version})` : ''}`
            : `WARNING: agent ${agent.id} was not installed${agent.error ? `: ${agent.error}` : ''}`,
        );
      }
      const missing = specs.filter((spec) => !(manifest?.agents ?? []).some((a) => a.id === spec.id));
      for (const spec of missing) {
        this.append(job, `WARNING: the tools volume reports nothing about agent ${spec.id}`);
      }

      await this.importLegacyClaudeLogin(hostId, backend, general, imageRef, job);
    });
  }

  /**
   * The one-time v0.1 -> v0.2 DATA migration of the claude login (backend.md v0.2 §12.4).
   *
   * v0.1 kept the login in two global volumes (`sharedClaudeVolume` + `sharedClaudeHomeVolume`
   * mounted at `~/.claude` / `~/.claude-home`); v0.2 keeps it in the per-host auth volume
   * `<prefix>auth-claude`. Without this copy every upgraded instance would silently ask for
   * `/login` again. It runs inside a one-shot ROOT container on the host (the only place that
   * can read a volume), is guarded by the marker `.pc-import-v1` inside the target volume, and
   * NEVER deletes the source volumes: a rollback to v0.1 keeps working and deleting the marker
   * re-runs the import.
   */
  private async importLegacyClaudeLogin(
    hostId: string,
    backend: DockerBackend,
    general: { volumePrefix: string; sharedClaudeVolume: string; sharedClaudeHomeVolume: string },
    imageRef: string,
    job: JobRecord,
  ): Promise<void> {
    if (this.legacyImported.has(hostId)) return;
    const target = agentAuthVolumeFor(general.volumePrefix, 'claude');
    if (target === general.sharedClaudeVolume) return; // nothing to import into

    let volumes: string[] = [];
    try {
      volumes = (await backend.listVolumes()).map((v) => v.name);
    } catch (err) {
      this.deps.log.debug({ err, hostId }, 'listing volumes for the legacy claude import failed');
      return;
    }
    if (!volumes.includes(general.sharedClaudeVolume)) {
      // a fresh install has no v0.1 volumes: nothing to do, and nothing to report
      this.legacyImported.add(hostId);
      return;
    }
    if (!volumes.includes(target)) {
      await backend.createVolume({
        name: target,
        labels: { 'porterclaude.managed': 'true', 'porterclaude.agent': 'claude' },
      });
    }

    const hasHome = volumes.includes(general.sharedClaudeHomeVolume);
    const script = [
      'set -u',
      // The marker alone is not proof of a complete import: an earlier (all-or-nothing) run
      // could stamp it while .credentials.json never made it across. Skip only when the
      // marker is present AND the login is actually there (or the legacy volume has none).
      `if [ -f /auth/${LEGACY_IMPORT_MARKER} ] && { [ -f /auth/claude/.credentials.json ] || [ ! -f /legacy/.credentials.json ]; }; then echo ${IMPORT_SKIPPED}; exit 0; fi`,
      `[ -f /auth/${LEGACY_IMPORT_MARKER} ] && echo "marker present but the v0.1 login is missing - importing again"`,
      'mkdir -p /auth/claude',
      // Copy ENTRY BY ENTRY and never clobber, instead of "only into an empty directory":
      // the target volume is regularly non-empty by the time the first tools sync runs
      // (v0.2 creates <prefix>auth-claude on the first session create, and an agent terminal
      // opened before the sync already writes cache/ and projects/ into it). An
      // all-or-nothing guard skips the WHOLE import then — .credentials.json included — and
      // the marker below makes that permanent, so the operator silently loses the v0.1 login.
      'for p in /legacy/.[!.]* /legacy/..?* /legacy/*; do',
      '  [ -e "$p" ] || continue',
      '  b=${p##*/}',
      '  [ -e "/auth/claude/$b" ] && continue',
      '  cp -a "$p" "/auth/claude/$b" || { echo "copying the v0.1 login failed" >&2; exit 1; }',
      'done',
      hasHome
        ? 'if [ -f /legacy-home/.claude.json ] && [ ! -e /auth/claude.json ]; then cp -a /legacy-home/.claude.json /auth/claude.json; fi'
        : ':',
      "own=$(stat -c '%u:%g' /legacy 2>/dev/null || true)",
      `case "\${own:-}" in ''|0:*) own='1000:1000';; esac`,
      'chown -R "$own" /auth 2>/dev/null || true',
      '[ -f /auth/claude/.credentials.json ] && chmod 0600 /auth/claude/.credentials.json 2>/dev/null',
      `touch /auth/${LEGACY_IMPORT_MARKER} && chown "$own" /auth/${LEGACY_IMPORT_MARKER} 2>/dev/null || true`,
      `echo ${IMPORT_DONE}`,
      'exit 0',
    ].join('\n');

    const name = `porterclaude-claude-import-${shortId(4)}`;
    let containerId: string | null = null;
    try {
      this.append(job, `importing the v0.1 claude login from ${general.sharedClaudeVolume} into ${target}`);
      const created = await backend.createContainer({
        name,
        image: imageRef,
        user: '0:0',
        entrypoint: ['/bin/sh', '-c'],
        cmd: [script],
        labels: { [TOOLS_SYNC_LABEL]: 'true' },
        mounts: [
          { type: 'volume', source: general.sharedClaudeVolume, target: '/legacy', readOnly: true },
          ...(hasHome
            ? [
                {
                  type: 'volume' as const,
                  source: general.sharedClaudeHomeVolume,
                  target: '/legacy-home',
                  readOnly: true,
                },
              ]
            : []),
          { type: 'volume', source: target, target: '/auth', readOnly: false },
        ],
        tty: false,
        openStdin: false,
        restartPolicy: 'no',
      });
      containerId = created.id;
      await backend.startContainer(containerId);
      const { statusCode } = await backend.waitContainer(containerId);
      const logs = await backend.containerLogs(containerId, { tail: 50 }).catch(() => '');
      for (const line of logs.split('\n')) if (line.trim()) this.append(job, line.trimEnd());
      if (statusCode === 0) {
        this.legacyImported.add(hostId);
        this.append(
          job,
          logs.includes(IMPORT_SKIPPED)
            ? 'the v0.1 claude login was already imported (marker present); the old volumes are kept'
            : 'imported the v0.1 claude login; the old volumes are kept',
        );
      } else {
        this.append(job, `WARNING: importing the v0.1 claude login failed (exit ${statusCode})`);
      }
    } catch (err) {
      this.append(job, `WARNING: importing the v0.1 claude login failed: ${errMessage(err)}`);
    } finally {
      if (containerId) {
        try {
          await backend.removeContainer(containerId, { force: true, removeVolumes: false });
        } catch (err) {
          this.deps.log.debug({ err, containerId }, 'removing the legacy import container failed');
        }
      }
    }
  }

  /**
   * Collect the image a `:latest` tag pointed at before this build.
   *
   * Every recipe rebuild and every tools sync re-tags `<ns>/<name>:latest`, which leaves the
   * previous image behind UNTAGGED — 1-2 GB per recipe, ~1.2 GB per tools sync. Nothing else
   * ever removes those, so a handful of rebuild cycles fills a small VPS (OPS-8).
   *
   * Deliberately conservative: only an image that (a) is no longer what the tag resolves to,
   * (b) still exists, and (c) carries no repo tag at all is removed, and never with `force`.
   * A container still using it answers 409 — that is an expected outcome, not a build
   * failure, so every error is reported into the job log and swallowed.
   */
  private async removeReplacedImage(
    backend: DockerBackend,
    job: JobRecord,
    previousId: string | null,
    tag: string,
  ): Promise<void> {
    if (!previousId) return;
    try {
      const current = await backend.inspectImage(tag);
      if (!current || current.id === previousId) return;      // the tag did not move
      const stale = await backend.inspectImage(previousId);
      if (!stale) return;                                      // already gone
      if (stale.tags.length > 0) return;                       // another tag still holds it
      await backend.removeImage(previousId, { force: false });
      this.append(job, `removed the image replaced by this build (${shortImageId(previousId)})`);
    } catch (err) {
      this.deps.log.debug({ err, previousId, tag }, 'removing the replaced image failed');
      this.append(
        job,
        `note: the previous image ${shortImageId(previousId)} is still in use and was kept ` +
          `(${errMessage(err)})`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // the Claude Code version an image actually ships
  // -------------------------------------------------------------------------

  /**
   * Cached real version of an image id.
   *
   * Reading it costs a one-shot container, so it is never done inline: a miss answers
   * `null` and starts the read in the background, and the next poll of
   * GET /api/images/recipes (or /tools) has the answer. A failed read is remembered for
   * VERSION_RETRY_MS so a broken/rootless image cannot turn a poll into a container storm.
   */
  private claudeVersionOf(backend: DockerBackend | null, imageId: string | null): string | null {
    if (!imageId) return null;
    const entry = this.claudeVersions.get(imageId);
    if (entry && (entry.version !== null || Date.now() - entry.at < VERSION_RETRY_MS)) {
      return entry.version;
    }
    if (backend) void this.probeClaudeVersion(backend, imageId);
    return entry?.version ?? null;
  }

  /**
   * Record the version of a freshly built image. `logged` is what the build printed
   * (docker/recipes/common.sh emits PORTERCLAUDE_CLAUDE_VERSION=<v>), which is free but
   * absent from a cached build; otherwise the image is read.
   */
  private async recordClaudeVersion(
    backend: DockerBackend,
    job: JobRecord,
    imageId: string | null,
    logged: string | null,
  ): Promise<void> {
    if (!imageId) return;
    if (logged) {
      this.claudeVersions.set(imageId, { version: logged, at: Date.now() });
      this.append(job, `claude version: ${logged}`);
      return;
    }
    const version = await this.probeClaudeVersion(backend, imageId);
    this.append(job, version ? `claude version: ${version}` : 'could not read the claude version of the image');
  }

  /** dedup wrapper around readClaudeVersion; never rejects. */
  private async probeClaudeVersion(backend: DockerBackend, imageId: string): Promise<string | null> {
    const inflight = this.versionProbes.get(imageId);
    if (inflight) return inflight;
    const probe = this.readClaudeVersion(backend, imageId)
      .catch((err: unknown) => {
        this.deps.log.debug({ err, imageId }, 'reading the claude version of an image failed');
        return null;
      })
      .then((version) => {
        this.claudeVersions.set(imageId, { version, at: Date.now() });
        this.versionProbes.delete(imageId);
        return version;
      });
    this.versionProbes.set(imageId, probe);
    return probe;
  }

  /**
   * `cat /etc/porterclaude/claude-version` in a one-shot container built from the image -
   * the only way to see a file inside an image. Deliberately its own entrypoint/cmd so it
   * also works for the tools image (whose CMD would populate a volume).
   */
  private async readClaudeVersion(backend: DockerBackend, imageId: string): Promise<string | null> {
    const name = `porterclaude-version-${shortId(4)}`;
    let containerId: string | null = null;
    try {
      const created = await backend.createContainer({
        name,
        image: imageId,
        entrypoint: ['/bin/sh', '-c'],
        cmd: [VERSION_PROBE_CMD],
        labels: { 'porterclaude.probe': 'true' },
        restartPolicy: 'no',
      });
      containerId = created.id;
      await backend.startContainer(containerId);
      await backend.waitContainer(containerId);
      return parseClaudeVersion(await backend.containerLogs(containerId, { tail: 20 }));
    } finally {
      if (containerId) {
        try {
          await backend.removeContainer(containerId, { force: true, removeVolumes: false });
        } catch (err) {
          this.deps.log.debug({ err, containerId }, 'removing the version probe container failed');
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // custom images
  // -------------------------------------------------------------------------

  /** inspectImage, pull when missing, then report arch/user/warnings. */
  async validateCustomImage(hostId: string, image: string): Promise<CustomImageCheck> {
    const backend = this.deps.hosts.backendFor(hostId);
    const result: CustomImageCheck = {
      image,
      ok: false,
      existsLocally: false,
      pulled: false,
      architecture: null,
      user: null,
      warnings: [],
      error: null,
    };

    try {
      let inspect = await backend.inspectImage(image);
      result.existsLocally = Boolean(inspect);
      if (!inspect) {
        await backend.pullImage(image);
        result.pulled = true;
        inspect = await backend.inspectImage(image);
      }
      if (!inspect) {
        result.error = `image '${image}' could not be found or pulled`;
        return result;
      }

      result.ok = true;
      result.architecture = inspect.architecture ?? null;
      result.user = inspect.user && inspect.user.length ? inspect.user : 'root';

      // The per-agent auth volumes are seeded by the first session that mounts them and are
      // owned by ONE uid (the recipes' 1000); the session's HOME is pinned to
      // general.containerHome so the agents write into them (backend.md v0.2 section 12.3).
      const uid = result.user.split(':')[0] ?? '';
      if (uid === 'root' || uid === '0') {
        result.warnings.push(
          'this image runs as root: the agents write into the shared auth volumes as root, ' +
            'so recipe sessions (uid 1000) may not be able to read those files',
        );
      } else if (uid !== '1000' && uid !== 'dev') {
        result.warnings.push(
          `this image runs as '${result.user}': the agent auth volumes are owned by uid 1000, ` +
            'so the shared login may not be writable',
        );
      }

      const probe = await this.probeImage(backend, image);
      if (probe === null) {
        result.warnings.push(
          'could not run a shell in this image: terminals may not work (distroless images are not supported)',
        );
      } else {
        if (!probe.tmux) {
          result.warnings.push('no tmux in this image: terminals will not survive a reload');
        }
        if (!probe.packageManager) {
          result.warnings.push('no package manager detected: git/tmux cannot be installed automatically');
        }
        if (!probe.git) {
          result.warnings.push('no git in this image: cloning workspaces will not work');
        }
      }
      return result;
    } catch (err) {
      result.ok = false;
      result.error = errMessage(err);
      return result;
    }
  }

  private async probeImage(
    backend: DockerBackend,
    image: string,
  ): Promise<{ tmux: boolean; git: boolean; packageManager: boolean } | null> {
    const script =
      'command -v tmux >/dev/null 2>&1 && echo PC_TMUX; ' +
      'command -v git >/dev/null 2>&1 && echo PC_GIT; ' +
      'for p in apt-get apk dnf microdnf yum zypper pacman; do ' +
      'command -v "$p" >/dev/null 2>&1 && { echo PC_PKG; break; }; done; ' +
      'echo PC_DONE';
    const name = `porterclaude-probe-${shortId(4)}`;
    let containerId: string | null = null;
    try {
      const created = await backend.createContainer({
        name,
        image,
        entrypoint: ['/bin/sh', '-c'],
        cmd: [script],
        labels: { 'porterclaude.probe': 'true' },
        restartPolicy: 'no',
      });
      containerId = created.id;
      await backend.startContainer(containerId);
      await backend.waitContainer(containerId);
      const logs = await backend.containerLogs(containerId, { tail: 50 });
      if (!logs.includes('PC_DONE')) return null;
      return {
        tmux: logs.includes('PC_TMUX'),
        git: logs.includes('PC_GIT'),
        packageManager: logs.includes('PC_PKG'),
      };
    } catch (err) {
      this.deps.log.debug({ err, image }, 'custom image probe failed');
      return null;
    } finally {
      if (containerId) {
        try {
          await backend.removeContainer(containerId, { force: true, removeVolumes: false });
        } catch (err) {
          this.deps.log.debug({ err, containerId }, 'removing probe container failed');
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // job registry (in-memory, capped at 2000 lines / job, 50 jobs)
  // -------------------------------------------------------------------------

  /** Newest first. `hostId` filters — the Images panel of one host must not show another's. */
  listJobs(hostId?: string): JobSummary[] {
    return [...this.jobs.values()]
      .reverse()
      .filter((j) => !hostId || j.hostId === hostId)
      .map((j) => this.summary(j));
  }

  /**
   * What the tools volume of `hostId` carries per agent — the second half of every
   * `HostAgentView` (the first half is the definition + the host's enabled list, merged by
   * B1's /api/hosts/:hostId/agents route).
   *
   * `<toolsMount>/AGENTS.json` is read out of the volume with a one-shot container (the same
   * trick readClaudeVersion() uses to read a file out of an image), cached per host and
   * invalidated after every sync. An unreachable host, a missing volume or a manifest an
   * older tools image never wrote answers `installed:false` for every agent the host enables
   * instead of throwing — the Images/agents panel must render for a dead host too.
   */
  async agentStatuses(hostId: string): Promise<AgentToolStatus[]> {
    return (await this.agentStatusesWithError(hostId)).statuses;
  }

  /**
   * `agentStatuses` plus WHY the manifest is missing: an unreachable host answers
   * `installed:false` for every agent, and without this error string the panel cannot tell
   * that apart from "enabled but never synced" (api.md: an unreachable host answers
   * installed:false plus an error instead of a 502).
   */
  async agentStatusesWithError(
    hostId: string,
  ): Promise<{ statuses: AgentToolStatus[]; error: string | null }> {
    const host = this.deps.hosts.get(hostId);
    if (!host) return { statuses: [], error: null };
    const enabled = this.enabledAgents(host);
    const general = this.deps.hosts.settingsForHost(host);

    const { manifest, error } = await this.agentManifest(hostId, general);
    const known = new Map((manifest?.agents ?? []).map((a) => [a.id, a]));
    const ids = [...new Set([...enabled.map((a) => a.id), ...known.keys()])];
    const statuses = ids.map((id): AgentToolStatus => {
      const entry = known.get(id);
      return {
        id,
        installed: Boolean(entry?.installed),
        version: entry?.version ?? null,
        installedAt: entry ? manifest?.syncedAt ?? null : null,
        error: entry?.error ?? error,
      };
    });
    return { statuses, error };
  }

  /**
   * What the tools volume of `hostId` says about ONE agent:
   *   'installed' - the manifest lists it as installed
   *   'missing'   - the manifest was read and does NOT list it (or lists it as failed)
   *   'unknown'   - the manifest could not be read at all (unreachable host, tools image
   *                 never built, or a pre-v0.2 volume that carries no AGENTS.json)
   * Callers must treat 'unknown' as "do not block": a v0.1 tools volume works fine and has
   * no manifest to prove it.
   */
  async agentInstallState(
    hostId: string,
    agentId: string,
  ): Promise<'installed' | 'missing' | 'unknown'> {
    const host = this.deps.hosts.get(hostId);
    if (!host) return 'unknown';
    const { manifest } = await this.agentManifest(hostId, this.deps.hosts.settingsForHost(host));
    if (!manifest) return 'unknown';
    const entry = manifest.agents.find((a) => a.id === agentId);
    return entry?.installed ? 'installed' : 'missing';
  }

  /**
   * Is the tools volume of `hostId` usable by a SESSION (INT2-2)?
   *
   *   'ready'    - the volume carries `<toolsMount>/entrypoint.sh`, so a container created
   *                against it can actually start;
   *   'unsynced' - the volume does not exist, or exists without the bootstrap: EVERY session
   *                on this host would crash-loop with
   *                `exec <toolsMount>/entrypoint.sh failed: No such file or directory`
   *                (docker creates the empty volume on the way, so the second attempt is no
   *                better than the first). The fix is always a tools sync;
   *   'unknown'  - nothing could be established (no transport, listing failed, or no image on
   *                the engine to read the volume with). Like every other probe in this
   *                codebase, 'unknown' must never block something that would work.
   *
   * `opts.probeImage` is an image known to exist ON THAT ENGINE (the session's own image): it
   * lets the volume be read even when the tools image was never built or has been pruned,
   * which is exactly the "never synced" case this gate is for.
   */
  async toolsReadiness(
    hostId: string,
    opts?: { probeImage?: string },
  ): Promise<'ready' | 'unsynced' | 'unknown'> {
    const host = this.deps.hosts.get(hostId);
    if (!host) return 'unknown';
    const general = this.deps.hosts.settingsForHost(host);
    const { backend } = this.backendOrError(hostId);
    if (!backend) return 'unknown';

    try {
      const volumes = await backend.listVolumes();
      // the volume does not exist yet: nothing was ever synced here, and docker would create
      // it empty on the way into the session
      if (!volumes.some((v) => v.name === general.toolsVolume)) return 'unsynced';
    } catch (err) {
      this.deps.log.debug({ err, hostId }, 'listing volumes for the tools readiness failed');
      return 'unknown';
    }

    const { bootstrap, error } = await this.toolsVolumeRead(hostId, general, opts?.probeImage);
    if (error || bootstrap === null) return 'unknown';
    return bootstrap ? 'ready' : 'unsynced';
  }

  /**
   * cached look into the tools volume of a host (`AGENTS.json` + the bootstrap). `error` is
   * set when the read FAILED (as opposed to "there is nothing there"); such a result is
   * deliberately not cached, so a host that comes back reports the truth on the next poll
   * instead of MANIFEST_TTL_MS later.
   */
  private async toolsVolumeRead(
    hostId: string,
    general: GeneralConfig,
    probeImage?: string,
  ): Promise<ToolsProbeRead> {
    const key = manifestKey(hostId, general.toolsVolume);
    const cached = this.manifests.get(key);
    // an entry that could not look INTO the volume is no answer for a caller that brings an
    // image to read it with
    const usable = cached && (cached.bootstrap !== null || !probeImage);
    if (cached && usable && Date.now() - cached.at < MANIFEST_TTL_MS) {
      return { manifest: cached.manifest, bootstrap: cached.bootstrap, error: null };
    }
    const { backend, error } = this.backendOrError(hostId);
    const result = backend
      ? await this.readToolsVolume(backend, general, probeImage)
      : { manifest: null, bootstrap: null, error };
    if (!result.error) {
      this.manifests.set(key, {
        at: Date.now(),
        manifest: result.manifest,
        bootstrap: result.bootstrap,
      });
    }
    return result;
  }

  /** cached `<toolsMount>/AGENTS.json` of a host (see `toolsVolumeRead`). */
  private async agentManifest(hostId: string, general: GeneralConfig): Promise<ToolsProbeRead> {
    return this.toolsVolumeRead(hostId, general);
  }

  /**
   * `cat <volume>/AGENTS.json` plus `test -x <volume>/entrypoint.sh` in a one-shot container.
   * It runs from the tools image; when that image is not on the engine (nothing was ever
   * synced, or it was pruned) `probeImage` is used instead - any image with a `/bin/sh` can
   * read a mounted volume, and without that fallback the answer would stay 'unknown' in
   * precisely the case a caller needs it most.
   */
  private async readToolsVolume(
    backend: DockerBackend,
    general: GeneralConfig,
    probeImage?: string,
  ): Promise<ToolsProbeRead> {
    const name = `porterclaude-agents-${shortId(4)}`;
    let containerId: string | null = null;
    try {
      const imageRef = await this.probeImageRef(backend, general, probeImage);
      // nothing on this engine can read the volume: a real "unknown", not a failure
      if (!imageRef) return { manifest: null, bootstrap: null, error: null };
      const created = await backend.createContainer({
        name,
        image: imageRef,
        entrypoint: ['/bin/sh', '-c'],
        cmd: [TOOLS_PROBE_CMD],
        labels: { 'porterclaude.probe': 'true' },
        mounts: [{ type: 'volume', source: general.toolsVolume, target: '/out', readOnly: true }],
        restartPolicy: 'no',
      });
      containerId = created.id;
      await backend.startContainer(containerId);
      await backend.waitContainer(containerId);
      const raw = await backend.containerLogs(containerId, { tail: 200 });
      return {
        manifest: parseAgentManifest(raw),
        bootstrap: raw.includes(TOOLS_BOOTSTRAP_MARKER),
        error: null,
      };
    } catch (err) {
      this.deps.log.debug({ err }, 'reading the tools volume failed');
      return { manifest: null, bootstrap: null, error: errMessage(err) };
    } finally {
      if (containerId) {
        try {
          await backend.removeContainer(containerId, { force: true, removeVolumes: false });
        } catch (err) {
          this.deps.log.debug({ err, containerId }, 'removing the manifest probe container failed');
        }
      }
    }
  }

  /** the tools image when it is on the engine, else the caller's fallback, else null. */
  private async probeImageRef(
    backend: DockerBackend,
    general: GeneralConfig,
    probeImage?: string,
  ): Promise<string | null> {
    const imageRef = toolsImageRef(general.imageNamespace);
    if (await backend.inspectImage(imageRef)) return imageRef;
    if (!probeImage) return null;
    return (await backend.inspectImage(probeImage)) ? probeImage : null;
  }

  /** definitions of the agents a host enables (unknown ids are dropped by the registry). */
  private enabledAgents(host: HostConfig): AgentDefinition[] {
    try {
      return this.deps.agents.enabledForHost(host);
    } catch (err) {
      this.deps.log.debug({ err, host: host.id }, 'resolving the enabled agents of a host failed');
      return [];
    }
  }

  /** `hosts.tryBackendFor` that also survives a manager that throws instead of answering null. */
  private tryBackend(hostId: string): DockerBackend | null {
    return this.backendOrError(hostId).backend;
  }

  /** `tryBackend` that keeps WHY there is no transport (missing credential, tcp/ssh, ...). */
  private backendOrError(hostId: string): { backend: DockerBackend | null; error: string | null } {
    try {
      return { backend: this.deps.hosts.backendFor(hostId), error: null };
    } catch (err) {
      this.deps.log.debug({ err, hostId }, 'the host has no usable transport');
      return { backend: null, error: errMessage(err) };
    }
  }

  /** `hostId` scopes the lookup: a job of another host does not exist for this one (404). */
  getJob(id: string, hostId?: string): JobSummary | null {
    const job = this.jobs.get(id);
    if (!job || (hostId && job.hostId !== hostId)) return null;
    return this.summary(job);
  }

  getJobLines(id: string, since = 0, hostId?: string): { lines: string[]; nextIndex: number } {
    const job = this.jobs.get(id);
    if (!job || (hostId && job.hostId !== hostId)) throw AppError.notFound(`job '${id}' does not exist`);
    const from = Math.max(0, Math.min(job.lines.length, since - job.dropped));
    return { lines: job.lines.slice(from), nextIndex: job.dropped + job.lines.length };
  }

  cancelJob(id: string, hostId?: string): JobSummary {
    const job = this.jobs.get(id);
    if (!job || (hostId && job.hostId !== hostId)) throw AppError.notFound(`job '${id}' does not exist`);
    if (job.status === 'running' || job.status === 'queued') {
      job.abort.abort();
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      this.append(job, 'cancelled by the user');
    }
    return this.summary(job);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** build context of the tools image: docker/tools, no extra files. */
  private toolsContext(): TarContextOptions {
    return { dir: this.deps.paths.toolsDir };
  }

  private recipeContext(recipe: string): TarContextOptions {
    const recipesDir = this.deps.paths.recipesDir;
    return {
      dir: path.join(recipesDir, recipe),
      extraFiles: [{ source: path.join(recipesDir, 'common.sh'), name: 'common.sh' }],
    };
  }

  /** build context stream whose read errors land in the job log instead of crashing node. */
  private contextStream(job: JobRecord, context: TarContextOptions): Readable {
    const stream = createTarContext(context);
    stream.on('error', (err: Error) => {
      this.append(job, `ERROR: build context: ${err.message}`);
      this.deps.log.warn({ err, jobId: job.id }, 'build context stream failed');
    });
    return stream;
  }

  private async requireDir(dir: string, label: string): Promise<void> {
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
      throw AppError.notFound(`${label} does not exist on this server`);
    }
  }

  /** Per HOST: building `node` on host A must not block the same recipe on host B. */
  private runningJobFor(hostId: string, kind: JobKind, target: string): JobRecord | null {
    for (const job of this.jobs.values()) {
      if (
        job.hostId === hostId &&
        job.kind === kind &&
        job.target === target &&
        (job.status === 'running' || job.status === 'queued')
      ) {
        return job;
      }
    }
    return null;
  }

  private startJob(
    hostId: string,
    kind: JobKind,
    target: string,
    run: (job: JobRecord) => Promise<void>,
  ): JobSummary {
    const job: JobRecord = {
      id: shortId(8),
      hostId,
      kind,
      target,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      lines: [],
      dropped: 0,
      abort: new AbortController(),
    };
    this.jobs.set(job.id, job);
    this.evict();

    void (async () => {
      try {
        await run(job);
        if (job.status === 'running') {
          job.status = 'success';
          job.finishedAt = new Date().toISOString();
        }
      } catch (err) {
        const message = errMessage(err);
        if (job.status === 'cancelled' || job.abort.signal.aborted) {
          job.status = 'cancelled';
          job.finishedAt = job.finishedAt ?? new Date().toISOString();
        } else {
          job.status = 'error';
          job.error = message;
          job.finishedAt = new Date().toISOString();
          this.append(job, `ERROR: ${message}`);
        }
        this.deps.log.warn({ err, jobId: job.id, hostId, kind, target }, 'image job failed');
      }
    })();

    return this.summary(job);
  }

  private evict(): void {
    while (this.jobs.size > MAX_JOBS) {
      const victim =
        [...this.jobs.values()].find((j) => j.status !== 'running' && j.status !== 'queued') ??
        this.jobs.values().next().value;
      if (!victim) return;
      this.jobs.delete(victim.id);
    }
  }

  private append(job: JobRecord, line: string): void {
    for (const part of line.split('\n')) {
      const text = part.replace(/\r$/, '');
      if (!text.trim() && !job.lines.length) continue;
      job.lines.push(text);
    }
    while (job.lines.length > MAX_JOB_LINES) {
      job.lines.shift();
      job.dropped += 1;
    }
  }

  private appendBuildLine(job: JobRecord, line: BuildLogLine): void {
    if (line.stream) {
      const text = line.stream.replace(/\r?\n$/, '');
      if (text.length) this.append(job, text);
    }
    if (line.status) {
      const id = line.id ? `${line.id}: ` : '';
      const progress = line.progress ? ` ${line.progress}` : '';
      this.append(job, `${id}${line.status}${progress}`);
    }
    if (line.error) this.append(job, `ERROR: ${line.error}`);
  }

  private summary(job: JobRecord): JobSummary {
    return {
      id: job.id,
      hostId: job.hostId,
      kind: job.kind,
      target: job.target,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      lineCount: job.dropped + job.lines.length,
    };
  }
}
