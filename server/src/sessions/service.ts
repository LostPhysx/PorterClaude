// OWNER: B2. Session lifecycle. Public API FROZEN — terminals/ws.ts and routes depend on it.
import type { ServiceDeps } from '../context.js';
import type { GeneralConfig } from '../config/schema.js';
import type {
  ContainerInspect,
  ContainerState,
  ContainerSummary,
  DockerBackend,
  ImageInspect,
  MountInfo,
  PortBinding,
} from '../backends/types.js';
import { AppError, DockerApiError } from '../http/errors.js';
import { getRecipe, recipeImageRef } from '../images/recipes.js';
import { shortId } from '../util/ids.js';
import { shQuote } from '../util/slug.js';
import type { SessionConfig, SessionInput, SessionView } from './model.js';
import {
  CONTAINER_LABELS,
  SessionNameSchema,
  containerNameFor,
  historyVolumeFor,
  workspaceVolumeFor,
} from './model.js';
import {
  buildContainerSpec,
  containerHomeFor,
  historyMountTargetFor,
  imagePathFromEnv,
  sharedClaudeTargetFor,
  toolsMountFor,
  toolsPathPrefix,
  workspaceMountFor,
} from './container.js';

/** label of the short-lived helper containers; deliberately NOT porterclaude.managed. */
const VOLUME_INIT_LABEL = 'porterclaude.volume-init';

/** scratch mount of porterclaude-hist-<slug> inside the volume-init container. */
const HISTORY_INIT_MOUNT = '/pc-hist';

/** uid:gid the recipe images give their session user - the canonical owner of the shared
 *  login volumes while they are still root-owned (docker/recipes/common.sh). */
const SHARED_VOLUME_OWNER = '1000:1000';

/** marker every file generated inside a container carries (docker/tools/entrypoint.sh). */
const GENERATED_MARKER = '# porterclaude (generated) - do not duplicate';

export interface RemoveOptions {
  /** also delete porterclaude-ws-<slug> / porterclaude-hist-<slug> */
  removeVolumes?: boolean;
  /** delete the stored config too (default true; false = keep definition, drop container) */
  forget?: boolean;
}

export interface ReconcileReport {
  known: number;
  running: number;
  /** containers labelled porterclaude.managed with no stored config */
  orphans: string[];
  /** stored sessions whose container is gone */
  missing: string[];
}

/** docker 404 (missing container/volume/image) rather than a broken engine. */
function isMissing(err: unknown): boolean {
  return err instanceof DockerApiError && (err.dockerStatus === 404 || err.status === 404);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** value of KEY in a docker "KEY=value" env array. */
function envValue(env: string[] | undefined, key: string): string | null {
  const hit = (env ?? []).find((e) => e.startsWith(`${key}=`));
  return hit === undefined ? null : hit.slice(key.length + 1);
}

/** narrow an unknown (docker inspect JSON) to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** true for a container user that is root (or unset, which means root). */
function isRootUser(user: string): boolean {
  const u = user.trim();
  return u === '' || u === 'root' || u === '0' || u.startsWith('0:') || u.startsWith('root:');
}

export class SessionService {
  /** transient, per-session warnings (git seeding, start problems, ...) */
  private readonly warnings = new Map<string, string[]>();

  /** sessions whose definition was reconstructed from a container in THIS process; their
   *  config describes the running container even when the spec hash cannot match. */
  private readonly adopted = new Set<string>();

  constructor(private readonly deps: ServiceDeps) {}

  // -------------------------------------------------------------------------
  // queries
  // -------------------------------------------------------------------------

  /** Stored configs merged with live container state. Never throws when the backend is
   *  down: returns configs with status 'absent' and a warning instead. */
  async list(): Promise<SessionView[]> {
    const general = this.deps.config.general();
    const configs = this.deps.config.listSessions();

    let containers: ContainerSummary[] = [];
    let backendWarning: string | null = null;
    try {
      const backend = this.deps.backends.get();
      containers = await this.listManagedContainers(backend);
    } catch (err) {
      backendWarning = `docker backend unavailable: ${errMessage(err)}`;
    }

    const inspects = await this.inspectAll(containers);
    const used = new Set<string>();
    const views: SessionView[] = [];

    for (const cfg of configs) {
      const container = this.matchContainer(containers, cfg.name, general);
      if (container) used.add(container.id);
      const extra = backendWarning ? [backendWarning] : [];
      views.push(this.toView(cfg, container, container ? inspects.get(container.id) ?? null : null, general, false, extra));
    }

    const orphanContainers = containers.filter((c) => !used.has(c.id));
    const images = await this.inspectImagesOf(orphanContainers);
    for (const container of orphanContainers) {
      const inspect = inspects.get(container.id) ?? null;
      const cfg = this.synthesizeConfig(container, inspect, general, images.get(container.image) ?? null);
      views.push(this.toView(cfg, container, inspect, general, true, []));
    }

    views.sort((a, b) => a.name.localeCompare(b.name));
    return views;
  }

  /** AppError.notFound when unknown. */
  async get(name: string): Promise<SessionView> {
    const views = await this.list();
    const view = views.find((v) => v.name === name);
    if (!view) throw AppError.notFound(`session '${name}' does not exist`);
    return view;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create: validate the name is free (config + container), ensure the volumes exist,
   * resolve the image, create the container, start it when autoStart, and persist the
   * config only after a successful create (rolling the container back when persisting
   * fails).
   */
  async create(input: SessionInput): Promise<SessionView> {
    const general = this.deps.config.general();
    const backend = this.deps.backends.get();

    if (this.deps.config.getSession(input.name)) {
      throw AppError.conflict(`session '${input.name}' already exists`);
    }
    const existing = this.matchContainer(await this.listManagedContainers(backend), input.name, general);
    if (existing) {
      throw AppError.conflict(
        `a container named '${containerNameFor(general.containerPrefix, input.name)}' already exists`,
      );
    }

    const now = new Date().toISOString();
    const cfg: SessionConfig = { ...input, createdAt: now, updatedAt: now };

    const created = await this.createContainerFor(backend, cfg, general);
    cfg.specHash = created.specHash;

    if (cfg.autoStart) {
      try {
        await backend.startContainer(created.id);
      } catch (err) {
        await this.safeRemoveContainer(backend, created.id);
        throw err;
      }
      await this.afterStart(backend, cfg, general, created.id);
    }

    try {
      await this.deps.config.putSession(cfg);
    } catch (err) {
      await this.safeRemoveContainer(backend, created.id);
      throw err;
    }

    if (created.warnings.length) this.addWarnings(cfg.name, created.warnings);
    return this.get(cfg.name);
  }

  /** Edit = recreate: stop -> remove container (keep volumes) -> create -> start if it was
   *  running or autoStart. Named volumes and the workspace survive. */
  async update(name: string, input: SessionInput): Promise<SessionView> {
    // adopts a label-matched container when /data was lost (see loadConfig)
    const stored = await this.loadConfig(name);
    if (input.name !== name) {
      throw AppError.validation('session name is immutable; create a new session instead', [
        { path: ['name'], message: `expected '${name}'` },
      ]);
    }
    const cfg: SessionConfig = {
      ...input,
      createdAt: stored.createdAt,
      updatedAt: new Date().toISOString(),
    };
    return this.replaceContainer(cfg);
  }

  /** Recreate from the stored config without changing it (e.g. after an image rebuild). */
  async recreate(name: string): Promise<SessionView> {
    const stored = await this.loadConfig(name);
    return this.replaceContainer({ ...stored, updatedAt: new Date().toISOString() });
  }

  async start(name: string): Promise<SessionView> {
    const general = this.deps.config.general();
    const backend = this.deps.backends.get();
    const containers = await this.listManagedContainers(backend);
    const container = this.matchContainer(containers, name, general);
    // An orphan (container labelled porterclaude.session=<name> with no stored config,
    // e.g. after losing /data) is adopted here instead of 404ing.
    const cfg = await this.loadConfig(name, container);

    if (!container) {
      const created = await this.createContainerFor(backend, cfg, general);
      cfg.specHash = created.specHash;
      await this.deps.config.putSession(cfg);
      await backend.startContainer(created.id);
      await this.afterStart(backend, cfg, general, created.id);
      return this.get(name);
    }

    if (container.state !== 'running') {
      await backend.startContainer(container.id);
      await this.afterStart(backend, cfg, general, container.id);
    }
    return this.get(name);
  }

  async stop(name: string): Promise<SessionView> {
    const general = this.deps.config.general();
    const backend = this.deps.backends.get();
    const container = this.matchContainer(await this.listManagedContainers(backend), name, general);
    this.assertKnown(name, container);
    if (container && container.state !== 'exited' && container.state !== 'created') {
      await backend.stopContainer(container.id, { timeoutSec: 10 });
    }
    return this.get(name);
  }

  async restart(name: string): Promise<SessionView> {
    const general = this.deps.config.general();
    const backend = this.deps.backends.get();
    const container = this.matchContainer(await this.listManagedContainers(backend), name, general);
    this.assertKnown(name, container);
    if (!container) throw AppError.conflict(`session '${name}' has no container; recreate it first`);
    await backend.restartContainer(container.id, { timeoutSec: 10 });
    // Same post-start repairs as start(): the container layer survives a restart, but the
    // tools volume (and with it the bootstrap the server installs from the outside) may
    // have been updated in the meantime - a restart is how a user applies that. Orphans
    // are skipped on purpose: a restart must not adopt them (see reconcile).
    const stored = this.deps.config.getSession(name);
    if (stored) await this.afterStart(backend, stored, general, container.id);
    return this.get(name);
  }

  async remove(name: string, opts?: RemoveOptions): Promise<void> {
    const general = this.deps.config.general();
    const backend = this.deps.backends.get();
    const stored = this.deps.config.getSession(name);
    const container = this.matchContainer(await this.listManagedContainers(backend), name, general);
    if (!stored && !container) throw AppError.notFound(`session '${name}' does not exist`);

    if (container) {
      if (container.state === 'running' || container.state === 'restarting' || container.state === 'paused') {
        try {
          await backend.stopContainer(container.id, { timeoutSec: 5 });
        } catch (err) {
          if (!isMissing(err)) this.deps.log.warn({ err, session: name }, 'stop before remove failed');
        }
      }
      try {
        await backend.removeContainer(container.id, { force: true, removeVolumes: false });
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    }

    if (opts?.removeVolumes) {
      // ONLY the per-session volumes; the shared claude/tools volumes are never touched.
      for (const volume of [workspaceVolumeFor(name), historyVolumeFor(name)]) {
        try {
          await backend.removeVolume(volume, { force: true });
        } catch (err) {
          if (!isMissing(err)) this.deps.log.warn({ err, volume }, 'removing session volume failed');
        }
      }
    }

    if (opts?.forget !== false) await this.deps.config.deleteSession(name);
    this.warnings.delete(name);
  }

  async logs(name: string, opts?: { tail?: number; timestamps?: boolean }): Promise<string> {
    const general = this.deps.config.general();
    const backend = this.deps.backends.get();
    const container = this.matchContainer(await this.listManagedContainers(backend), name, general);
    this.assertKnown(name, container);
    if (!container) throw AppError.conflict(`session '${name}' has no container`);
    return backend.containerLogs(container.id, {
      tail: opts?.tail ?? 200,
      timestamps: opts?.timestamps ?? false,
    });
  }

  /**
   * Rebuild the view from container labels: report containers labelled
   * porterclaude.managed=true that have no stored config, and flag stored sessions whose
   * container disappeared.
   *
   * `adopt` (the explicit POST /api/sessions/reconcile, never the startup call) persists a
   * definition reconstructed from those containers so they become editable again. The
   * startup reconcile deliberately does NOT: an orphan must stay visible as `orphan:true`
   * instead of being silently rewritten into a reconstructed definition behind the user's
   * back. start/recreate/update adopt on demand as well (loadConfig).
   */
  async reconcile(opts?: { adopt?: boolean }): Promise<ReconcileReport> {
    const general = this.deps.config.general();
    const backend = this.deps.backends.get();
    const containers = await this.listManagedContainers(backend);
    const configs = this.deps.config.listSessions();

    const orphans: string[] = [];
    const missing: string[] = [];
    const matched = new Set<string>();

    for (const cfg of configs) {
      const container = this.matchContainer(containers, cfg.name, general);
      if (container) matched.add(container.id);
      else missing.push(cfg.name);
    }
    const orphanContainers = containers.filter((c) => !matched.has(c.id));
    const inspects = opts?.adopt ? await this.inspectAll(orphanContainers) : new Map();
    for (const container of orphanContainers) {
      const label = container.labels[CONTAINER_LABELS.session] ?? container.name;
      orphans.push(label);
      if (!opts?.adopt) continue;
      // Explicit user action: adopt the orphan so it becomes startable/editable again.
      try {
        await this.adopt(container, inspects.get(container.id) ?? null, general);
      } catch (err) {
        this.deps.log.warn({ err, session: label }, 'adopting an orphan container failed');
      }
    }

    const report: ReconcileReport = {
      known: configs.length,
      running: containers.filter((c) => c.state === 'running').length,
      orphans,
      missing,
    };
    this.deps.log.info({ report }, 'session reconcile');
    return report;
  }

  /**
   * FROZEN SIGNATURE — used by TerminalService. Resolves a session name to a RUNNING
   * container id. Throws AppError.notFound / AppError.conflict('session not running').
   */
  async requireRunningContainer(name: string): Promise<{ containerId: string; config: SessionConfig }> {
    const general = this.deps.config.general();
    const backend = this.deps.backends.get();
    const containers = await this.listManagedContainers(backend);
    const container = this.matchContainer(containers, name, general);
    const stored = this.deps.config.getSession(name);
    if (!container) {
      if (!stored) throw AppError.notFound(`session '${name}' does not exist`);
      throw AppError.conflict(`session '${name}' is not running`);
    }
    if (container.state !== 'running') throw AppError.conflict(`session '${name}' is not running`);
    const config = stored ?? this.synthesizeConfig(container, null, general);
    return { containerId: container.id, config };
  }

  /** Ensure the shared claude volumes exist on the current backend (idempotent). */
  async ensureSharedVolumes(): Promise<void> {
    const general = this.deps.config.general();
    const backend = this.deps.backends.get();
    for (const name of [general.sharedClaudeVolume, general.sharedClaudeHomeVolume]) {
      await backend.createVolume({ name, labels: { [CONTAINER_LABELS.managed]: 'true' } });
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * The stored definition of a session, or - when `/data` was lost and only the container
   * survived - a definition synthesized from its labels/inspect which is then PERSISTED
   * (adopted). This is what makes start/recreate/update work on `orphan:true` sessions
   * instead of 404ing (backend.md section 7, "losing /data does not lose your sessions").
   */
  private async loadConfig(name: string, known?: ContainerSummary | null): Promise<SessionConfig> {
    const stored = this.deps.config.getSession(name);
    if (stored) return { ...stored };

    const general = this.deps.config.general();
    const backend = this.deps.backends.get();
    const container =
      known ?? this.matchContainer(await this.listManagedContainers(backend), name, general);
    if (!container) throw AppError.notFound(`session '${name}' does not exist`);

    let inspect: ContainerInspect | null = null;
    try {
      inspect = await backend.inspectContainer(container.id);
    } catch (err) {
      this.deps.log.debug({ err, containerId: container.id }, 'inspect during adoption failed');
    }
    return this.adopt(container, inspect, general);
  }

  /** Persist a synthesized config for a managed container that has none. */
  private async adopt(
    container: ContainerSummary,
    inspect: ContainerInspect | null,
    general: GeneralConfig,
  ): Promise<SessionConfig> {
    const images = await this.inspectImagesOf([container]);
    const cfg = this.synthesizeConfig(container, inspect, general, images.get(container.image) ?? null);
    if (!SessionNameSchema.safeParse(cfg.name).success) {
      throw AppError.conflict(
        `container '${container.name}' cannot be adopted: '${cfg.name}' is not a valid session name`,
      );
    }
    if (this.deps.config.getSession(cfg.name)) return { ...cfg };
    await this.deps.config.putSession(cfg);
    this.adopted.add(cfg.name);
    this.deps.log.info({ session: cfg.name, containerId: container.id }, 'adopted orphan container');
    return cfg;
  }

  /** A session exists when it is stored OR when a managed container carries its name. */
  private assertKnown(name: string, container: ContainerSummary | null): void {
    if (!container && !this.deps.config.getSession(name)) {
      throw AppError.notFound(`session '${name}' does not exist`);
    }
  }

  private async listManagedContainers(backend: DockerBackend): Promise<ContainerSummary[]> {
    return backend.listContainers({ all: true, labelFilters: { [CONTAINER_LABELS.managed]: 'true' } });
  }

  private matchContainer(
    containers: ContainerSummary[],
    name: string,
    general: GeneralConfig,
  ): ContainerSummary | null {
    const containerName = containerNameFor(general.containerPrefix, name);
    return (
      containers.find((c) => c.labels[CONTAINER_LABELS.session] === name) ??
      containers.find((c) => c.name === containerName || c.names.includes(containerName)) ??
      null
    );
  }

  private async inspectAll(containers: ContainerSummary[]): Promise<Map<string, ContainerInspect>> {
    const out = new Map<string, ContainerInspect>();
    if (!containers.length) return out;
    let backend: DockerBackend;
    try {
      backend = this.deps.backends.get();
    } catch {
      return out;
    }
    const results = await Promise.allSettled(containers.map((c) => backend.inspectContainer(c.id)));
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') out.set(containers[i]!.id, res.value);
    });
    return out;
  }

  /** image inspects (by ref) for a set of containers; missing/unreachable images map to
   *  nothing. Used to subtract the image's own env when reconstructing a config. */
  private async inspectImagesOf(containers: ContainerSummary[]): Promise<Map<string, ImageInspect>> {
    const out = new Map<string, ImageInspect>();
    const refs = [...new Set(containers.map((c) => c.image).filter((r) => r.length > 0))];
    if (!refs.length) return out;
    let backend: DockerBackend;
    try {
      backend = this.deps.backends.get();
    } catch {
      return out;
    }
    const results = await Promise.allSettled(refs.map((ref) => backend.inspectImage(ref)));
    results.forEach((res, i) => {
      if (res.status === 'fulfilled' && res.value) out.set(refs[i]!, res.value);
    });
    return out;
  }

  /** ensure volumes + resolve the image + createContainer (no start, no persist). */
  private async createContainerFor(
    backend: DockerBackend,
    cfg: SessionConfig,
    general: GeneralConfig,
  ): Promise<{ id: string; specHash: string; warnings: string[] }> {
    await this.ensureSharedVolumes();

    const workspace = workspaceMountFor(cfg, general);
    if (workspace.type === 'volume') {
      await backend.createVolume({
        name: workspace.source,
        labels: { [CONTAINER_LABELS.managed]: 'true', [CONTAINER_LABELS.session]: cfg.name },
      });
    }
    if (!cfg.shareHistory) {
      await backend.createVolume({
        name: historyVolumeFor(cfg.name),
        labels: { [CONTAINER_LABELS.managed]: 'true', [CONTAINER_LABELS.session]: cfg.name },
      });
    }

    const { ref: resolvedImage, imageEnvPath } = await this.resolveImage(backend, cfg, general);
    const warnings: string[] = [];
    if (!cfg.shareHistory) {
      warnings.push(...(await this.prepareHistoryVolume(backend, cfg, general, resolvedImage)));
    }
    const spec = buildContainerSpec({
      session: cfg,
      general,
      resolvedImage,
      imageType: cfg.image.type,
      imageEnvPath,
    });
    const created = await backend.createContainer(spec);
    return {
      id: created.id,
      specHash: spec.labels?.[CONTAINER_LABELS.specHash] ?? '',
      warnings: [...warnings, ...(created.warnings ?? [])],
    };
  }

  /**
   * shareHistory=false overlays porterclaude-hist-<slug> on <home>/.claude/projects, which
   * lives INSIDE the shared claude volume. If that directory does not exist yet, docker
   * creates it as root:root while setting the mount up - and the fresh history volume is
   * root-owned too. The unprivileged session user could then write neither its own private
   * history nor (once the root-owned directory is in the shared volume) the SHARED history
   * of any other session.
   *
   * So before the session container is ever created we run a one-shot root container that
   * mounts the shared volume at its real path (keeping docker's empty-volume seeding
   * semantics intact) plus the history volume on a scratch path, creates `projects` and
   * gives both the ownership of the shared volume root. Best effort: failures become
   * session warnings, never a failed create.
   */
  private async prepareHistoryVolume(
    backend: DockerBackend,
    cfg: SessionConfig,
    general: GeneralConfig,
    resolvedImage: string,
  ): Promise<string[]> {
    const sharedTarget = sharedClaudeTargetFor(general);
    const projects = historyMountTargetFor(general);
    const script = [
      'set -u',
      `own=$(stat -c '%u:%g' ${shQuote(sharedTarget)} 2>/dev/null || true)`,
      `mkdir -p ${shQuote(projects)} || { echo "cannot create ${projects}" >&2; exit 1; }`,
      'if [ -n "${own:-}" ]; then',
      `  chown "$own" ${shQuote(projects)} ${HISTORY_INIT_MOUNT} 2>/dev/null || echo "chown $own failed" >&2;`,
      `  chmod 0700 ${shQuote(projects)} ${HISTORY_INIT_MOUNT} 2>/dev/null || true;`,
      'else',
      '  echo "no stat(1): leaving ownership untouched" >&2;',
      'fi',
      'exit 0',
    ].join('\n');

    const name = `porterclaude-histinit-${shortId(4)}`;
    let created: { id: string } | null = null;
    try {
      created = await backend.createContainer({
        name,
        image: resolvedImage,
        user: '0:0',
        entrypoint: ['/bin/sh', '-c'],
        cmd: [script],
        labels: { [VOLUME_INIT_LABEL]: cfg.name },
        mounts: [
          { type: 'volume', source: general.sharedClaudeVolume, target: sharedTarget, readOnly: false },
          { type: 'volume', source: historyVolumeFor(cfg.name), target: HISTORY_INIT_MOUNT, readOnly: false },
        ],
        tty: false,
        openStdin: false,
        init: true,
        restartPolicy: 'no',
      });
      await backend.startContainer(created.id);
      const { statusCode } = await backend.waitContainer(created.id);
      if (statusCode !== 0) {
        const logs = await backend.containerLogs(created.id, { tail: 20 }).catch(() => '');
        return [
          `preparing the private history volume failed (exit ${statusCode}): ` +
            `${logs.trim().slice(0, 300) || 'no output'}`,
        ];
      }
      return [];
    } catch (err) {
      return [`preparing the private history volume failed: ${errMessage(err)}`];
    } finally {
      if (created) {
        try {
          await backend.removeContainer(created.id, { force: true, removeVolumes: false });
        } catch (err) {
          this.deps.log.warn({ err, containerId: created.id }, 'removing the volume-init container failed');
        }
      }
    }
  }

  /** Everything that has to happen inside a freshly started session container. */
  private async afterStart(
    backend: DockerBackend,
    cfg: SessionConfig,
    general: GeneralConfig,
    containerId: string,
  ): Promise<void> {
    await this.ensureHomeWritable(backend, cfg, general, containerId);
    await this.ensureSharedOwnership(backend, general, containerId);
    await this.ensureProjectsDir(backend, general, containerId);
    await this.seedGitWorkspace(backend, cfg, general, containerId);
  }

  /**
   * Custom images that run as a NON-ROOT user (session `user` or an image `USER`) cannot
   * bootstrap themselves: docker creates the mountpoint parent <containerHome> in the
   * container layer as root:root 0755, so the tools entrypoint - which runs as that
   * unprivileged uid - can write neither <home>/.profile / .bashrc (no PATH persistence,
   * "cannot persist PATH in /home/dev/.profile") nor the <home>/.claude.json symlink into
   * the shared login volume ("cannot link /home/dev/.claude.json"). The result is a session
   * without a usable `claude`.
   *
   * Nothing inside the container runs as root before the entrypoint, so the fix has to come
   * from outside: right after the start we exec `chown` as uid 0 (docker allows exec --user
   * even for containers running unprivileged) and then re-run the entrypoint's bootstrap
   * (`entrypoint.sh --porterclaude-bootstrap`, idempotent) as the session user, which now
   * succeeds. A root-owned shared claude volume (fresh volume seeded by an image without
   * <home>/.claude) is handed to the session user as well - never touched when it already
   * belongs to somebody else (the recipes' uid 1000).
   *
   * Best effort throughout: a failure is logged, never fatal - PATH also comes from the
   * container env (buildContainerSpec) and from the terminal exec env.
   */
  private async ensureHomeWritable(
    backend: DockerBackend,
    cfg: SessionConfig,
    general: GeneralConfig,
    containerId: string,
  ): Promise<void> {
    if (cfg.image.type !== 'custom') return; // recipe images own <home> already

    let user = (cfg.user ?? '').trim();
    if (!user) {
      try {
        user = ((await backend.inspectContainer(containerId)).user ?? '').trim();
      } catch (err) {
        this.deps.log.debug({ err, containerId }, 'inspect for the home-ownership fix failed');
      }
    }
    if (isRootUser(user)) return; // root writes everywhere anyway

    const home = containerHomeFor(general);
    const script = [
      'set -u',
      `h=${shQuote(home)}`,
      '[ -d "$h" ] || mkdir -p "$h" 2>/dev/null || exit 0',
      `chown ${shQuote(user)} "$h" 2>/dev/null || echo "chown $h failed" >&2`,
      'chmod u+rwx "$h" 2>/dev/null || true',
      // The shared volumes can only ever belong to ONE uid. This session may claim them
      // while they are still root-owned (docker just created them) or still EMPTY - the
      // latter matters since ensureSharedOwnership hands a fresh root-owned volume to the
      // recipes' uid 1000, which would otherwise lock a uid-1500 image out of a volume
      // that holds nothing yet. A volume with content keeps its owner.
      'for d in "$h/.claude" "$h/.claude-home"; do',
      '  [ -d "$d" ] || continue',
      `  own=$(stat -c '%u' "$d" 2>/dev/null || echo 1);`,
      '  [ "$own" = "0" ] || [ -z "$(ls -A "$d" 2>/dev/null)" ] || continue;',
      `  chown -R ${shQuote(user)} "$d" 2>/dev/null || echo "chown $d failed" >&2;`,
      'done',
      // The two root-only bits of the entrypoint (install_claude_wrapper, the
      // /etc/profile.d snippet): the re-bootstrap below runs as the SESSION user and can
      // still not write either of them. They are what makes `claude` resolvable in a login
      // shell whose /etc/profile hard-sets PATH (alpine, debian) and in a `docker exec`
      // that starts from the standard PATH. Both are marker-guarded, so we never clobber a
      // binary or a profile snippet the image itself shipped.
      ...this.rootOnlyToolingScript(general),
      'exit 0',
    ].join('\n');

    try {
      await backend.runExec(containerId, ['sh', '-c', script], { user: '0', timeoutMs: 20_000 });
    } catch (err) {
      this.deps.log.debug({ err, containerId }, 'chowning the container home failed (ignored)');
      return;
    }

    const entrypoint = `${toolsMountFor(general)}/entrypoint.sh`;
    try {
      const res = await backend.runExec(
        containerId,
        ['sh', '-c', `[ -x ${shQuote(entrypoint)} ] && ${shQuote(entrypoint)} --porterclaude-bootstrap`],
        { timeoutMs: 60_000 },
      );
      this.deps.log.debug(
        { containerId, exitCode: res.exitCode },
        're-ran the tools bootstrap after chowning the container home',
      );
    } catch (err) {
      this.deps.log.debug({ err, containerId }, 're-running the tools bootstrap failed (ignored)');
    }
  }

  /**
   * The two pieces of the tools bootstrap that only uid 0 can install, which the
   * (unprivileged) entrypoint of a non-root custom image therefore always skips:
   *
   *   * `/etc/profile.d/porterclaude.sh` — sourced by every login shell AFTER
   *     `/etc/profile` has hard-set PATH (alpine and debian both do), so a `bash -l`
   *     terminal and the shells inside tmux panes find `<toolsMount>/bin` even when the
   *     rc files in `$HOME` are missing or unwritable;
   *   * `/usr/local/bin/claude` — a wrapper on the standard PATH, so `claude` resolves in
   *     any exec, whatever PATH it starts from.
   *
   * Both are skipped when the path exists without our marker: an image that ships its own
   * `claude` or profile snippet keeps it. Pure string building, no I/O — the caller runs
   * this as part of its root exec.
   */
  private rootOnlyToolingScript(general: GeneralConfig): string[] {
    const prefix = toolsPathPrefix(general);
    const profileBody = [
      GENERATED_MARKER,
      // The container env already carries the prefix and the entrypoint prepends it in
      // $HOME/.profile too: only add it when it is really missing, so a login shell does
      // not end up with three copies of it.
      `case ":$PATH:" in`,
      `  *":${prefix[0]}:"*) ;;`,
      `  *) export PATH="${prefix.join(':')}:$PATH" ;;`,
      'esac',
      'export TERM="${TERM:-xterm-256color}"',
      'export COLORTERM=truecolor',
    ].join('\n');
    const wrapperBody = [
      '#!/bin/sh',
      GENERATED_MARKER,
      `exec "${toolsMountFor(general)}/bin/claude" "$@"`,
    ].join('\n');
    const mine = '"porterclaude (generated)"';
    return [
      'pcprof=/etc/profile.d/porterclaude.sh; pcwrap=/usr/local/bin/claude',
      `pcprofbody=${shQuote(profileBody)}; pcwrapbody=${shQuote(wrapperBody)}`,
      `if mkdir -p /etc/profile.d 2>/dev/null && { [ ! -e "$pcprof" ] || grep -q ${mine} "$pcprof" 2>/dev/null; }; then`,
      '  printf \'%s\\n\' "$pcprofbody" > "$pcprof" 2>/dev/null && chmod 0644 "$pcprof" 2>/dev/null || echo "cannot write $pcprof" >&2',
      'fi',
      `if mkdir -p /usr/local/bin 2>/dev/null && { [ ! -e "$pcwrap" ] || grep -q ${mine} "$pcwrap" 2>/dev/null; }; then`,
      '  printf \'%s\\n\' "$pcwrapbody" > "$pcwrap" 2>/dev/null && chmod 0755 "$pcwrap" 2>/dev/null || echo "cannot write $pcwrap" >&2',
      'fi',
    ];
  }

  /**
   * The two shared login volumes (<home>/.claude, <home>/.claude-home) are used by EVERY
   * session but only ONE uid can own them, and the recipes' session user is hard-wired to
   * uid 1000 - a recipe session cannot chown anything. Two ways this used to break:
   *
   *   * a session on a ROOT custom image writes .credentials.json / settings.json /
   *     sessions/ as root:root, so a later recipe session can neither read the login nor
   *     update the settings ("/theme" fails with EACCES);
   *   * on a fresh install whose FIRST session is a root custom image, docker cannot
   *     copy-up a <home>/.claude the image does not have, so the volume ROOT itself stays
   *     root:root 0755 and uid 1000 can never write into it at all.
   *
   * So on every start we exec as uid 0 (docker allows that even for containers running
   * unprivileged) and hand the whole tree to the owner of the volume root, falling back to
   * the recipes' 1000:1000 while that owner is still root. The tools entrypoint does the
   * same from the inside (`entrypoint.sh --porterclaude-share`, also called by the claude
   * dispatcher after every run) - this half is what repairs recipe-only installations and
   * sessions whose tools volume predates that change. Best effort, never fails a start.
   */
  private async ensureSharedOwnership(
    backend: DockerBackend,
    general: GeneralConfig,
    containerId: string,
  ): Promise<void> {
    const claude = shQuote(sharedClaudeTargetFor(general));
    const claudeHome = shQuote(`${containerHomeFor(general)}/.claude-home`);
    const script = [
      'set -u',
      `c=${claude}; h=${claudeHome}`,
      `own=$(stat -c '%u:%g' "$c" 2>/dev/null || echo)`,
      `case "\${own:-}" in ''|0:*) own=$(stat -c '%u:%g' "$h" 2>/dev/null || echo);; esac`,
      `case "\${own:-}" in ''|0:*) own=${shQuote(SHARED_VOLUME_OWNER)};; esac`,
      'for d in "$c" "$h"; do',
      '  [ -d "$d" ] || continue',
      '  chown -R "$own" "$d" 2>/dev/null || echo "chown $d failed" >&2',
      'done',
      '[ -f "$c/.credentials.json" ] && chmod 0600 "$c/.credentials.json" 2>/dev/null',
      'exit 0',
    ].join('\n');
    try {
      await backend.runExec(containerId, ['sh', '-c', script], { user: '0', timeoutMs: 30_000 });
    } catch (err) {
      this.deps.log.debug({ err, containerId }, 'repairing the shared volume ownership failed (ignored)');
    }
  }

  /**
   * Self-healing counterpart of prepareHistoryVolume: make sure <home>/.claude/projects
   * exists and is owned like <home>/.claude. For a shared session that repairs the shared
   * volume (e.g. damaged by an older build), for a private one it fixes the history volume
   * root. Runs as root, best effort, never fails a start.
   */
  private async ensureProjectsDir(
    backend: DockerBackend,
    general: GeneralConfig,
    containerId: string,
  ): Promise<void> {
    const shared = shQuote(sharedClaudeTargetFor(general));
    const projects = shQuote(historyMountTargetFor(general));
    const script =
      `own=$(stat -c '%u:%g' ${shared} 2>/dev/null || true); mkdir -p ${projects} 2>/dev/null || exit 0; ` +
      `[ -n "\${own:-}" ] && chown "$own" ${projects} 2>/dev/null; exit 0`;
    try {
      await backend.runExec(containerId, ['sh', '-c', script], { user: '0', timeoutMs: 15_000 });
    } catch (err) {
      this.deps.log.debug({ err, containerId }, 'ensuring ~/.claude/projects failed (ignored)');
    }
  }

  /** stop -> remove -> create -> start (used by update/recreate). */
  private async replaceContainer(cfg: SessionConfig): Promise<SessionView> {
    const general = this.deps.config.general();
    const backend = this.deps.backends.get();
    const previous = this.matchContainer(await this.listManagedContainers(backend), cfg.name, general);
    const wasRunning = previous?.state === 'running';

    if (previous) {
      if (wasRunning) {
        try {
          await backend.stopContainer(previous.id, { timeoutSec: 10 });
        } catch (err) {
          if (!isMissing(err)) throw err;
        }
      }
      try {
        await backend.removeContainer(previous.id, { force: true, removeVolumes: false });
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    }

    const created = await this.createContainerFor(backend, cfg, general);
    cfg.specHash = created.specHash;
    await this.deps.config.putSession(cfg);

    if (wasRunning || cfg.autoStart) {
      await backend.startContainer(created.id);
      await this.afterStart(backend, cfg, general, created.id);
    }
    if (created.warnings.length) this.addWarnings(cfg.name, created.warnings);
    return this.get(cfg.name);
  }

  /** Resolve the image ref and read the PATH it declares (needed for the container PATH
   *  of custom images, see container.ts composeToolsPath). */
  private async resolveImage(
    backend: DockerBackend,
    cfg: SessionConfig,
    general: GeneralConfig,
  ): Promise<{ ref: string; imageEnvPath: string | null }> {
    if (cfg.image.type === 'recipe') {
      const recipe = getRecipe(cfg.image.recipe);
      if (!recipe) throw AppError.notFound(`unknown recipe '${cfg.image.recipe}'`);
      const ref = recipeImageRef(general.imageNamespace, recipe.name);
      const inspect = await backend.inspectImage(ref);
      if (!inspect) {
        throw AppError.conflict(
          `recipe image '${ref}' is not built yet — build it in Settings → Images first`,
        );
      }
      return { ref, imageEnvPath: envValue(inspect.env, 'PATH') };
    }

    const ref = cfg.image.ref;
    let inspect = await backend.inspectImage(ref);
    if (!inspect) {
      await backend.pullImage(ref);
      try {
        inspect = await backend.inspectImage(ref);
      } catch (err) {
        this.deps.log.debug({ err, ref }, 'inspecting the pulled image failed (ignored)');
      }
    }
    return { ref, imageEnvPath: envValue(inspect?.env, 'PATH') };
  }

  private async safeRemoveContainer(backend: DockerBackend, id: string): Promise<void> {
    try {
      await backend.removeContainer(id, { force: true, removeVolumes: false });
    } catch (err) {
      this.deps.log.warn({ err, containerId: id }, 'rolling back container failed');
    }
  }

  /** git workspaces are seeded on first start; failures are warnings, never errors. */
  private async seedGitWorkspace(
    backend: DockerBackend,
    cfg: SessionConfig,
    general: GeneralConfig,
    containerId: string,
  ): Promise<void> {
    if (cfg.workspace.type !== 'git') return;
    const target = general.workspaceMount;
    const branch = cfg.workspace.branch ? ` --branch ${shQuote(cfg.workspace.branch)}` : '';
    const script =
      `set -e; if [ -z "$(ls -A ${shQuote(target)} 2>/dev/null)" ]; then ` +
      `git clone${branch} ${shQuote(cfg.workspace.url)} ${shQuote(target)}; fi`;
    try {
      const res = await backend.runExec(containerId, ['sh', '-lc', script], { timeoutMs: 300_000 });
      if (res.exitCode !== 0) {
        this.addWarnings(cfg.name, [
          `git clone failed (exit ${res.exitCode}): ${(res.stderr || res.stdout).trim().slice(0, 400)}`,
        ]);
      }
    } catch (err) {
      this.addWarnings(cfg.name, [`git clone failed: ${errMessage(err)}`]);
    }
  }

  private addWarnings(name: string, warnings: string[]): void {
    if (!warnings.length) return;
    const current = this.warnings.get(name) ?? [];
    this.warnings.set(name, [...current, ...warnings].slice(-10));
  }

  private toView(
    cfg: SessionConfig,
    container: ContainerSummary | null,
    inspect: ContainerInspect | null,
    general: GeneralConfig,
    orphan: boolean,
    extraWarnings: string[],
  ): SessionView {
    const warnings = [...(this.warnings.get(cfg.name) ?? []), ...extraWarnings];
    const status: ContainerState | 'absent' = container ? container.state : 'absent';
    const startedAt = inspect?.startedAt ?? null;
    const running = container?.state === 'running';
    const uptimeSec =
      running && startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000)) : null;

    const resolvedImage =
      cfg.image.type === 'recipe'
        ? recipeImageRef(general.imageNamespace, cfg.image.recipe)
        : cfg.image.ref;

    const runtimePorts: PortBinding[] = inspect?.ports ?? container?.ports ?? [];

    let needsRecreate = false;
    if (container && !orphan) {
      const spec = buildContainerSpec({
        session: cfg,
        general,
        resolvedImage,
        imageType: cfg.image.type,
        // recover the image PATH the container was created with, otherwise the recomputed
        // hash of a custom-image session would never match (container.ts composeToolsPath)
        imageEnvPath: imagePathFromEnv(inspect?.env, general),
      });
      const wanted = spec.labels?.[CONTAINER_LABELS.specHash];
      const actual = container.labels[CONTAINER_LABELS.specHash];
      needsRecreate = Boolean(wanted && actual && wanted !== actual);
      if (!actual) needsRecreate = true;
      // A definition reconstructed from a container (adopted orphan) describes THAT
      // container by construction: never nag the user to recreate it just because the
      // reconstruction is not bit-identical. The flag comes back as soon as they edit it.
      if (needsRecreate && this.adopted.has(cfg.name) && cfg.specHash === actual) {
        needsRecreate = false;
      }
    }

    return {
      ...cfg,
      status,
      containerId: container?.id ?? null,
      containerName: container?.name ?? containerNameFor(general.containerPrefix, cfg.name),
      resolvedImage: container?.image ?? resolvedImage,
      startedAt,
      uptimeSec,
      runtimePorts,
      needsRecreate,
      orphan,
      warnings,
    };
  }

  /**
   * Best-effort SessionConfig for a managed container with no stored definition (adoption
   * after /data loss). Everything that survives in the container is reconstructed -
   * env, published ports, extra mounts, cpu/memory limits, network, restart policy and
   * user - because the adopted definition is what a later Recreate/Edit rebuilds from:
   * dropping a port mapping or an env var here would silently break the session.
   *
   * `image` is the ImageInspect of the container image when available; its env/user are
   * subtracted so that only what PorterClaude (or the user) added ends up in the config.
   */
  private synthesizeConfig(
    container: ContainerSummary,
    inspect: ContainerInspect | null,
    general: GeneralConfig,
    image?: ImageInspect | null,
  ): SessionConfig {
    const prefix = general.containerPrefix;
    const name =
      container.labels[CONTAINER_LABELS.session] ??
      (container.name.startsWith(prefix) ? container.name.slice(prefix.length) : container.name);
    const recipe = container.labels[CONTAINER_LABELS.recipe];
    const createdAt =
      container.labels[CONTAINER_LABELS.createdAt] ??
      new Date(container.createdAt * 1000).toISOString();

    const home = containerHomeFor(general);
    const raw = asRecord(inspect?.raw);
    const hostConfig = asRecord(raw?.HostConfig);

    const mounts = inspect?.mounts ?? [];
    const workspaceMount = mounts.find((m) => m.destination === general.workspaceMount);
    const workspace: SessionConfig['workspace'] = workspaceMount
      ? workspaceMount.type === 'bind'
        ? { type: 'bind', hostPath: workspaceMount.source ?? general.workspaceMount }
        : { type: 'volume', volume: workspaceMount.name ?? workspaceVolumeFor(name) }
      : { type: 'volume' };

    const historyTarget = historyMountTargetFor(general);
    const shareHistory = !mounts.some((m) => m.destination === historyTarget);

    // every mount buildContainerSpec creates on its own; the rest belongs to the user
    const managedTargets = new Set([
      general.workspaceMount,
      sharedClaudeTargetFor(general),
      `${home}/.claude-home`,
      historyTarget,
      toolsMountFor(general),
      general.toolsMount,
    ]);
    const extraMounts = mounts
      .filter((mount) => !managedTargets.has(mount.destination))
      .map((mount) => toMountConfig(mount))
      .filter((mount): mount is SessionConfig['extraMounts'][number] => mount !== null);

    return {
      name,
      image: recipe ? { type: 'recipe', recipe } : { type: 'custom', ref: container.image },
      workspace,
      env: synthesizeEnv(inspect, general, image),
      ports: synthesizePorts(hostConfig, inspect),
      extraMounts,
      limits: synthesizeLimits(hostConfig),
      shareHistory,
      autoStart: synthesizeAutoStart(hostConfig),
      network: synthesizeNetwork(hostConfig),
      user: synthesizeUser(inspect, image),
      createdAt,
      updatedAt: createdAt,
      specHash: container.labels[CONTAINER_LABELS.specHash],
    };
  }
}

/** Config.Env minus the image own env and minus everything buildContainerSpec sets. */
function synthesizeEnv(
  inspect: ContainerInspect | null,
  general: GeneralConfig,
  image?: ImageInspect | null,
): Record<string, string> {
  const home = containerHomeFor(general);
  const fromImage = new Set(image?.env ?? []);
  const managed = new Set(['PORTERCLAUDE_SESSION', 'PORTERCLAUDE_TOOLS', 'PORTERCLAUDE_HOME']);
  const env: Record<string, string> = {};
  for (const entry of inspect?.env ?? []) {
    if (fromImage.has(entry)) continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (managed.has(key)) continue;
    if (key === 'TERM' && value === 'xterm-256color') continue;
    if (key === 'HOME' && value === home) continue;
    if (key === 'PATH' && value.startsWith(`${toolsMountFor(general)}/bin:`)) continue;
    env[key] = value;
  }
  return env;
}

/** HostConfig.PortBindings (what was REQUESTED) with the runtime bindings as fallback. */
function synthesizePorts(
  hostConfig: Record<string, unknown> | null,
  inspect: ContainerInspect | null,
): SessionConfig['ports'] {
  const bindings = asRecord(hostConfig?.PortBindings);
  if (!bindings) {
    return (inspect?.ports ?? []).map((p) => ({
      containerPort: p.containerPort,
      protocol: p.protocol,
      ...(p.hostPort === undefined ? {} : { hostPort: p.hostPort }),
      ...(p.hostIp === undefined || p.hostIp === '' ? {} : { hostIp: p.hostIp }),
    }));
  }
  const ports: SessionConfig['ports'] = [];
  for (const [key, value] of Object.entries(bindings)) {
    const [portStr, protoStr] = key.split('/');
    const containerPort = Number(portStr);
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) continue;
    const protocol = protoStr === 'udp' ? 'udp' : 'tcp';
    const list = Array.isArray(value) ? value : [];
    if (!list.length) {
      ports.push({ containerPort, protocol });
      continue;
    }
    for (const item of list) {
      const b = asRecord(item);
      const hostPort = Number(b?.HostPort ?? '');
      const hostIp = typeof b?.HostIp === 'string' ? b.HostIp : '';
      ports.push({
        containerPort,
        protocol,
        ...(Number.isInteger(hostPort) && hostPort > 0 && hostPort <= 65535 ? { hostPort } : {}),
        ...(hostIp ? { hostIp } : {}),
      });
    }
  }
  return ports;
}

/** HostConfig.NanoCpus / Memory -> SessionConfig.limits. */
function synthesizeLimits(hostConfig: Record<string, unknown> | null): SessionConfig['limits'] {
  const limits: SessionConfig['limits'] = {};
  const nanoCpus = asNumber(hostConfig?.NanoCpus);
  if (nanoCpus && nanoCpus > 0) limits.cpus = Math.round((nanoCpus / 1e9) * 1000) / 1000;
  const memory = asNumber(hostConfig?.Memory);
  if (memory && memory > 0) limits.memoryMb = Math.round(memory / (1024 * 1024));
  return limits;
}

/** restart policy unless-stopped/always == autoStart. */
function synthesizeAutoStart(hostConfig: Record<string, unknown> | null): boolean {
  const policy = asRecord(hostConfig?.RestartPolicy);
  const restart = typeof policy?.Name === 'string' ? policy.Name : '';
  return restart === 'unless-stopped' || restart === 'always';
}

/** HostConfig.NetworkMode, ignoring docker implicit defaults. */
function synthesizeNetwork(hostConfig: Record<string, unknown> | null): string | null {
  const mode = typeof hostConfig?.NetworkMode === 'string' ? hostConfig.NetworkMode : '';
  if (!mode || mode === 'default' || mode === 'bridge' || mode.startsWith('container:')) return null;
  return mode;
}

/** Config.User, unless it is what the image declares anyway. */
function synthesizeUser(inspect: ContainerInspect | null, image?: ImageInspect | null): string | null {
  const user = (inspect?.user ?? '').trim();
  if (!user) return null;
  if (image?.user && image.user.trim() === user) return null;
  return user;
}

/** MountInfo -> the session config mount shape (tmpfs has no source: skipped). */
function toMountConfig(m: MountInfo): SessionConfig['extraMounts'][number] | null {
  const target = m.destination;
  if (!target.startsWith('/')) return null;
  if (m.type === 'bind') {
    const source = m.source ?? '';
    return source ? { type: 'bind', source, target, readOnly: m.readOnly } : null;
  }
  if (m.type === 'volume') {
    const source = m.name ?? m.source ?? '';
    return source ? { type: 'volume', source, target, readOnly: m.readOnly } : null;
  }
  return null;
}
