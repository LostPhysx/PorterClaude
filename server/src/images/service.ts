// OWNER: B2. Recipe builds, the shared tools volume, custom-image validation, job registry.
//
// v0.2 SKELETON STATE (planner). Every public method now takes the HOST it works on as its
// first argument; the bodies still use the deprecated default-host shims so the repo
// compiles. B2 owns:
//   1. replacing `this.deps.config.general()` with `this.deps.hosts.settingsFor(hostId)` and
//      `this.deps.backends.get()/tryGet()` with `this.deps.hosts.backendFor(hostId)` /
//      `tryBackendFor(hostId)` — including in the private helpers (they need a hostId param);
//   2. keying the job registry per host: `JobSummary.hostId`, the "already running" checks
//      (`runningJobFor`) and `listJobs(hostId)` must all be host-scoped, so a build on host A
//      never blocks the same recipe on host B;
//   3. the AGENT half of the tools sync (see syncTools / agentStatuses below).
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { ServiceDeps } from '../context.js';
import type { BuildLogLine, DockerBackend, ImageSummary } from '../backends/types.js';
import { AppError } from '../http/errors.js';
import { IMAGE_LABELS } from '../sessions/model.js';
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

interface JobRecord {
  id: string;
  /** TODO(B2): set by startJob() from the hostId the operation runs against */
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
function shortImageId(id: string): string {
  const hex = id.startsWith('sha256:') ? id.slice(7) : id;
  return `sha256:${hex.slice(0, 12)}`;
}

export class ImageService {
  private readonly jobs = new Map<string, JobRecord>();
  private lastToolsSyncAt: string | null = null;
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
    void hostId; // TODO(B2): this.deps.hosts.backendFor(hostId)
    const backend = this.deps.backends.get();
    return backend.listImages();
  }

  /** RECIPES joined with inspectImage() + the current context hash. */
  async recipeStatuses(hostId: string): Promise<RecipeStatus[]> {
    void hostId; // TODO(B2): hosts.settingsFor(hostId) / hosts.tryBackendFor(hostId)
    const general = this.deps.config.general();
    const backend = this.deps.backends.tryGet();

    return Promise.all(
      RECIPES.map(async (recipe): Promise<RecipeStatus> => {
        const imageRef = recipeImageRef(general.imageNamespace, recipe.name);
        const job = this.runningJobFor('build', recipe.name);

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
          claudeVersion: this.claudeVersionOf(inspect?.id ?? null),
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
    void hostId; // TODO(B2): host-scoped settings, backend AND job key
    const recipe = getRecipe(name);
    if (!recipe) throw AppError.notFound(`unknown recipe '${name}'`);
    const running = this.runningJobFor('build', name);
    if (running) throw AppError.conflict(`a build for recipe '${name}' is already running`, { jobId: running.id });

    const general = this.deps.config.general();
    const backend = this.deps.backends.get();
    const tag = recipeImageRef(general.imageNamespace, recipe.name);
    const forced = Boolean(opts?.force || opts?.noCache || opts?.pull);

    return this.startJob('build', recipe.name, async (job) => {
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
        await this.recordClaudeVersion(job, existing.id, null);
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
      await this.recordClaudeVersion(job, built?.id ?? null, logged);
      await this.removeReplacedImage(job, previousId, tag);
    });
  }

  async pull(hostId: string, image: string): Promise<JobSummary> {
    void hostId; // TODO(B2)
    const backend = this.deps.backends.get();
    const running = this.runningJobFor('pull', image);
    if (running) throw AppError.conflict(`a pull for '${image}' is already running`, { jobId: running.id });

    return this.startJob('pull', image, async (job) => {
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
    void hostId; // TODO(B2)
    const general = this.deps.config.general();
    const imageRef = toolsImageRef(general.imageNamespace);
    const job = this.runningJobFor('tools-sync', general.toolsVolume);
    const backend = this.deps.backends.tryGet();

    let present = false;
    let claudeVersion: string | null = null;
    let claudeChannel: string | null = null;
    let lastSyncedAt = this.lastToolsSyncAt;
    let imageHash: string | null = null;
    let built = false;

    let contextHash: string | null = null;
    try {
      contextHash = await hashContext(this.toolsContext());
    } catch (err) {
      this.deps.log.debug({ err }, 'hashing the tools context failed');
    }

    if (backend) {
      try {
        const volumes = await backend.listVolumes();
        present = volumes.some((v) => v.name === general.toolsVolume);
      } catch (err) {
        this.deps.log.debug({ err }, 'listing volumes for tools status failed');
      }
      try {
        const inspect = await backend.inspectImage(imageRef);
        built = Boolean(inspect);
        claudeVersion = this.claudeVersionOf(inspect?.id ?? null);
        claudeChannel = inspect?.labels[IMAGE_LABELS.claudeVersion] ?? null;
        imageHash = inspect?.labels[IMAGE_LABELS.contextHash] ?? null;
        lastSyncedAt = lastSyncedAt ?? inspect?.createdAt ?? inspect?.labels[IMAGE_LABELS.builtAt] ?? null;
      } catch (err) {
        this.deps.log.debug({ err, imageRef }, 'inspecting tools image failed');
      }
    }

    // A missing image counts as outdated only once the volume claims to be populated:
    // on a fresh install "nothing built yet" is already reported by present:false.
    const outdated = Boolean(contextHash) && (built ? imageHash !== contextHash : present);

    return {
      // TODO(B2): hostId + agents (agentStatuses(hostId))
      hostId: '',
      agents: [],
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
   * v0.2 TODO(B2) — the sync is what INSTALLS THE AGENTS of this host:
   *   * pass `PORTERCLAUDE_AGENTS=<json>` (agents/model.ts TOOLS_AGENTS_ENV,
   *     `agents.installSpecsForHost(host)`) into the populate container; it installs every
   *     enabled agent into the volume and writes `<toolsMount>/AGENTS.json`;
   *   * a single agent that fails to install is a WARNING in the job log, not a failed job
   *     (the manifest records `installed:false` + the error, and the panel shows it);
   *   * afterwards, ONE-TIME LEGACY IMPORT for the claude agent (only when the host has a
   *     `general.sharedClaudeVolume` and the target auth volume has no marker yet):
   *     run a one-shot root container mounting the old `sharedClaudeVolume` at /legacy,
   *     `sharedClaudeHomeVolume` at /legacy-home and `<volumePrefix>auth-claude` at /auth,
   *     then `cp -a /legacy/. /auth/claude/` and `cp -a /legacy-home/.claude.json
   *     /auth/claude.json`, chown to the volume owner and touch `/auth/.pc-import-v1`.
   *     Never delete the old volumes — the import must be repeatable and reversible.
   */
  async syncTools(hostId: string, opts?: { force?: boolean }): Promise<JobSummary> {
    void hostId; // TODO(B2)
    const general = this.deps.config.general();
    const backend = this.deps.backends.get();
    const running = this.runningJobFor('tools-sync', general.toolsVolume);
    if (running) throw AppError.conflict('a tools sync is already running', { jobId: running.id });

    const imageRef = toolsImageRef(general.imageNamespace);

    return this.startJob('tools-sync', general.toolsVolume, async (job) => {
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
        await this.recordClaudeVersion(job, built?.id ?? null, logged);
        await this.removeReplacedImage(job, previousId, imageRef);
      } else {
        this.append(job, `reusing existing image ${imageRef} (context hash ${contextHash.slice(0, 12)})`);
      }

      this.append(job, `ensuring volume ${general.toolsVolume}`);
      await backend.createVolume({
        name: general.toolsVolume,
        labels: { [TOOLS_SYNC_LABEL]: 'true' },
      });

      const containerName = `porterclaude-tools-sync-${shortId(4)}`;
      this.append(job, `running ${containerName}`);
      const created = await backend.createContainer({
        name: containerName,
        image: imageRef,
        labels: { [TOOLS_SYNC_LABEL]: 'true' },
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
      this.lastToolsSyncAt = new Date().toISOString();
      this.append(job, `tools volume ${general.toolsVolume} populated`);
    });
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
  private async removeReplacedImage(job: JobRecord, previousId: string | null, tag: string): Promise<void> {
    if (!previousId) return;
    const backend = this.deps.backends.get();
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
  private claudeVersionOf(imageId: string | null): string | null {
    if (!imageId) return null;
    const entry = this.claudeVersions.get(imageId);
    if (entry && (entry.version !== null || Date.now() - entry.at < VERSION_RETRY_MS)) {
      return entry.version;
    }
    void this.probeClaudeVersion(imageId);
    return entry?.version ?? null;
  }

  /**
   * Record the version of a freshly built image. `logged` is what the build printed
   * (docker/recipes/common.sh emits PORTERCLAUDE_CLAUDE_VERSION=<v>), which is free but
   * absent from a cached build; otherwise the image is read.
   */
  private async recordClaudeVersion(job: JobRecord, imageId: string | null, logged: string | null): Promise<void> {
    if (!imageId) return;
    if (logged) {
      this.claudeVersions.set(imageId, { version: logged, at: Date.now() });
      this.append(job, `claude version: ${logged}`);
      return;
    }
    const version = await this.probeClaudeVersion(imageId);
    this.append(job, version ? `claude version: ${version}` : 'could not read the claude version of the image');
  }

  /** dedup wrapper around readClaudeVersion; never rejects. */
  private async probeClaudeVersion(imageId: string): Promise<string | null> {
    const inflight = this.versionProbes.get(imageId);
    if (inflight) return inflight;
    const probe = this.readClaudeVersion(imageId)
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
  private async readClaudeVersion(imageId: string): Promise<string | null> {
    const backend = this.deps.backends.tryGet();
    if (!backend) return null;
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
    void hostId; // TODO(B2)
    const backend = this.deps.backends.get();
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

      // The shared claude volumes are seeded by the recipes and owned by uid 1000; the
      // session's HOME is pinned to general.containerHome for custom images so claude
      // still writes into them (backend.md section 7).
      const uid = result.user.split(':')[0] ?? '';
      if (uid === 'root' || uid === '0') {
        result.warnings.push(
          'this image runs as root: claude writes into the shared volumes as root, ' +
            'so recipe sessions (uid 1000) may not be able to read those files',
        );
      } else if (uid !== '1000' && uid !== 'dev') {
        result.warnings.push(
          `this image runs as '${result.user}': the shared claude volumes are owned by uid 1000, ` +
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
    void hostId; // TODO(B2): filter on job.hostId
    return [...this.jobs.values()].reverse().map((j) => this.summary(j));
  }

  /**
   * What the tools volume of `hostId` carries per agent — the second half of every
   * `HostAgentView` (the first half is the definition + the host's enabled list, merged by
   * B1's /api/hosts/:hostId/agents route).
   *
   * TODO(B2): read `<toolsMount>/AGENTS.json` (agents/model.ts TOOLS_AGENT_MANIFEST) out of
   * the volume with a one-shot container (`cat`), exactly like readClaudeVersion() reads a
   * file out of an image; cache it per host like the version probes and invalidate it after
   * a tools sync. An unreachable host / missing volume answers `installed:false` for every
   * enabled agent instead of throwing — the panel must render for a dead host too.
   */
  async agentStatuses(hostId: string): Promise<AgentToolStatus[]> {
    void hostId;
    return [];
  }

  getJob(id: string): JobSummary | null {
    const job = this.jobs.get(id);
    return job ? this.summary(job) : null;
  }

  getJobLines(id: string, since = 0): { lines: string[]; nextIndex: number } {
    const job = this.jobs.get(id);
    if (!job) throw AppError.notFound(`job '${id}' does not exist`);
    const from = Math.max(0, Math.min(job.lines.length, since - job.dropped));
    return { lines: job.lines.slice(from), nextIndex: job.dropped + job.lines.length };
  }

  cancelJob(id: string): JobSummary {
    const job = this.jobs.get(id);
    if (!job) throw AppError.notFound(`job '${id}' does not exist`);
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

  /** TODO(B2): add a hostId parameter and compare it too - a build on host A must not
   *  block the same recipe on host B. */
  private runningJobFor(kind: JobKind, target: string): JobRecord | null {
    for (const job of this.jobs.values()) {
      if (job.kind === kind && job.target === target && (job.status === 'running' || job.status === 'queued')) {
        return job;
      }
    }
    return null;
  }

  /** TODO(B2): take the hostId as the first argument and store it on the record. */
  private startJob(kind: JobKind, target: string, run: (job: JobRecord) => Promise<void>): JobSummary {
    const job: JobRecord = {
      id: shortId(8),
      hostId: '',
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
        this.deps.log.warn({ err, jobId: job.id, kind, target }, 'image job failed');
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
      hostId: job.hostId ?? '',
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
