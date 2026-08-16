// OWNER: B2. Recipe builds, the shared tools volume, custom-image validation, job registry.
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
  builtAt: string | null;
  sizeBytes: number | null;
  claudeVersion: string | null;
  /** stored porterclaude.context-hash differs from the current docker/recipes/<name> hash */
  outdated: boolean;
  /** a build job for this recipe is running */
  building: boolean;
  jobId: string | null;
}

export interface ToolsStatus {
  volume: string;
  imageRef: string;
  /** the tools volume exists on the engine */
  present: boolean;
  lastSyncedAt: string | null;
  claudeVersion: string | null;
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

interface JobRecord {
  id: string;
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

export class ImageService {
  private readonly jobs = new Map<string, JobRecord>();
  private lastToolsSyncAt: string | null = null;

  constructor(private readonly deps: ServiceDeps) {}

  // -------------------------------------------------------------------------
  // images / recipes
  // -------------------------------------------------------------------------

  /** Plain docker image list for the picker. */
  async listImages(): Promise<ImageSummary[]> {
    const backend = this.deps.backends.get();
    return backend.listImages();
  }

  /** RECIPES joined with inspectImage() + the current context hash. */
  async recipeStatuses(): Promise<RecipeStatus[]> {
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
          builtAt: labels[IMAGE_LABELS.builtAt] ?? inspect?.createdAt ?? null,
          sizeBytes: inspect?.sizeBytes ?? null,
          claudeVersion: labels[IMAGE_LABELS.claudeVersion] ?? null,
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
   */
  async buildRecipe(name: string, opts?: { noCache?: boolean; pull?: boolean }): Promise<JobSummary> {
    const recipe = getRecipe(name);
    if (!recipe) throw AppError.notFound(`unknown recipe '${name}'`);
    const running = this.runningJobFor('build', name);
    if (running) throw AppError.conflict(`a build for recipe '${name}' is already running`, { jobId: running.id });

    const general = this.deps.config.general();
    const backend = this.deps.backends.get();
    const tag = recipeImageRef(general.imageNamespace, recipe.name);

    return this.startJob('build', recipe.name, async (job) => {
      const context = this.recipeContext(recipe.name);
      await this.requireDir(context.dir, `recipe context '${context.dir}'`);

      const contextHash = await hashContext(context);
      this.append(job, `building ${tag} (context hash ${contextHash.slice(0, 12)})`);

      const stream = this.contextStream(job, context);
      await backend.buildImage({
        tag,
        context: stream,
        dockerfile: 'Dockerfile',
        labels: {
          [IMAGE_LABELS.recipe]: recipe.name,
          [IMAGE_LABELS.contextHash]: contextHash,
          [IMAGE_LABELS.builtAt]: new Date().toISOString(),
        },
        pull: opts?.pull ?? false,
        noCache: opts?.noCache ?? false,
        onLog: (line) => this.appendBuildLine(job, line),
        signal: job.abort.signal,
      });
      stream.destroy();
      this.append(job, `built ${tag}`);
    });
  }

  async pull(image: string): Promise<JobSummary> {
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

  async toolsStatus(): Promise<ToolsStatus> {
    const general = this.deps.config.general();
    const imageRef = toolsImageRef(general.imageNamespace);
    const job = this.runningJobFor('tools-sync', general.toolsVolume);
    const backend = this.deps.backends.tryGet();

    let present = false;
    let claudeVersion: string | null = null;
    let lastSyncedAt = this.lastToolsSyncAt;

    if (backend) {
      try {
        const volumes = await backend.listVolumes();
        present = volumes.some((v) => v.name === general.toolsVolume);
      } catch (err) {
        this.deps.log.debug({ err }, 'listing volumes for tools status failed');
      }
      try {
        const inspect = await backend.inspectImage(imageRef);
        claudeVersion = inspect?.labels[IMAGE_LABELS.claudeVersion] ?? null;
        lastSyncedAt = lastSyncedAt ?? inspect?.labels[IMAGE_LABELS.builtAt] ?? null;
      } catch (err) {
        this.deps.log.debug({ err, imageRef }, 'inspecting tools image failed');
      }
    }

    return {
      volume: general.toolsVolume,
      imageRef,
      present,
      lastSyncedAt,
      claudeVersion,
      syncing: Boolean(job),
      jobId: job?.id ?? null,
    };
  }

  /**
   * Populate the shared read-only tools volume:
   *   1. build <ns>/tools:latest from <paths.toolsDir>
   *   2. createVolume(general.toolsVolume) if missing
   *   3. run a one-shot container from that image with the volume mounted rw at /out
   *   4. waitContainer -> non-zero exit fails the job; then removeContainer
   */
  async syncTools(opts?: { force?: boolean }): Promise<JobSummary> {
    const general = this.deps.config.general();
    const backend = this.deps.backends.get();
    const running = this.runningJobFor('tools-sync', general.toolsVolume);
    if (running) throw AppError.conflict('a tools sync is already running', { jobId: running.id });

    const imageRef = toolsImageRef(general.imageNamespace);

    return this.startJob('tools-sync', general.toolsVolume, async (job) => {
      const context: TarContextOptions = { dir: this.deps.paths.toolsDir };
      await this.requireDir(context.dir, `tools context '${context.dir}'`);

      const existing = await backend.inspectImage(imageRef);
      if (opts?.force || !existing) {
        const contextHash = await hashContext(context);
        this.append(job, `building ${imageRef}`);
        const stream = this.contextStream(job, context);
        await backend.buildImage({
          tag: imageRef,
          context: stream,
          dockerfile: 'Dockerfile',
          labels: {
            [IMAGE_LABELS.contextHash]: contextHash,
            [IMAGE_LABELS.builtAt]: new Date().toISOString(),
          },
          pull: Boolean(opts?.force),
          noCache: false,
          onLog: (line) => this.appendBuildLine(job, line),
          signal: job.abort.signal,
        });
        stream.destroy();
      } else {
        this.append(job, `reusing existing image ${imageRef}`);
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

  // -------------------------------------------------------------------------
  // custom images
  // -------------------------------------------------------------------------

  /** inspectImage, pull when missing, then report arch/user/warnings. */
  async validateCustomImage(image: string): Promise<CustomImageCheck> {
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

  listJobs(): JobSummary[] {
    return [...this.jobs.values()].reverse().map((j) => this.summary(j));
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

  private runningJobFor(kind: JobKind, target: string): JobRecord | null {
    for (const job of this.jobs.values()) {
      if (job.kind === kind && job.target === target && (job.status === 'running' || job.status === 'queued')) {
        return job;
      }
    }
    return null;
  }

  private startJob(kind: JobKind, target: string, run: (job: JobRecord) => Promise<void>): JobSummary {
    const job: JobRecord = {
      id: shortId(8),
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
