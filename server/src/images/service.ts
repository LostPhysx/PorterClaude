// OWNER: B2. Recipe builds, the shared tools volume, custom-image validation, job registry.
import type { ServiceDeps } from '../context.js';
import type { ImageSummary } from '../backends/types.js';
import type { RecipeDef } from './recipes.js';

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

export class ImageService {
  constructor(private readonly deps: ServiceDeps) {}

  /** Plain docker image list for the picker. TODO(B2) */
  async listImages(): Promise<ImageSummary[]> { throw new Error('TODO(B2)'); }

  /** RECIPES joined with inspectImage() + the current context hash. TODO(B2) */
  async recipeStatuses(): Promise<RecipeStatus[]> { throw new Error('TODO(B2)'); }

  /**
   * Start a build job (returns immediately; poll the job for output):
   *   context = createTarContext({ dir: <paths.recipesDir>/<name>,
   *                                extraFiles: [common.sh from recipesDir] })
   *   labels  = { porterclaude.recipe, porterclaude.context-hash, porterclaude.built-at }
   *   tag     = <imageNamespace>/<name>:latest
   * 409 (AppError.conflict) when a build for that recipe is already running. TODO(B2)
   */
  async buildRecipe(name: string, opts?: { noCache?: boolean; pull?: boolean }): Promise<JobSummary> {
    throw new Error('TODO(B2)');
  }

  async pull(image: string): Promise<JobSummary> { throw new Error('TODO(B2)'); }

  async toolsStatus(): Promise<ToolsStatus> { throw new Error('TODO(B2)'); }

  /**
   * Populate the shared read-only tools volume:
   *   1. build <ns>/tools:latest from <paths.toolsDir>
   *   2. createVolume(general.toolsVolume) if missing
   *   3. run a one-shot container from that image with the volume mounted rw at /out
   *      (its CMD copies the claude binaries + entrypoint.sh into /out)
   *   4. waitContainer -> non-zero exit fails the job; then removeContainer
   * TODO(B2)
   */
  async syncTools(opts?: { force?: boolean }): Promise<JobSummary> {
    throw new Error('TODO(B2)');
  }

  /** inspectImage, pull when missing, then report arch/user/warnings. TODO(B2) */
  async validateCustomImage(image: string): Promise<CustomImageCheck> {
    throw new Error('TODO(B2)');
  }

  // --- job registry (in-memory, capped at 2000 lines / job, 50 jobs) --------

  listJobs(): JobSummary[] { throw new Error('TODO(B2)'); }
  getJob(id: string): JobSummary | null { throw new Error('TODO(B2)'); }
  getJobLines(id: string, since?: number): { lines: string[]; nextIndex: number } { throw new Error('TODO(B2)'); }
  cancelJob(id: string): JobSummary { throw new Error('TODO(B2)'); }
}
