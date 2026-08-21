// OWNER: B2. Container lifecycle, host- and agent-aware (v0.2).
//
// Every docker call goes through the CONTAINER'S host — the global settings and the
// deprecated default-host transport shim of v0.1 are gone:
//   const general = this.deps.hosts.settingsFor(hostId);
//   const backend = this.deps.hosts.backendFor(hostId);
// A `HostScope` bundles both with the HostConfig so nothing below has to look them up twice.
//
//   1. `create()` resolves `input.hostId ?? defaultHostId` ONCE and stores it; `update()`
//      rejects a different hostId with 422 (immutable — moving hosts = recreate elsewhere).
//   2. Container NAMES are unique across hosts (api.md v0.2): the create conflict check looks
//      at every stored container and at the containers of the TARGET host. That invariant is
//      what lets the session websocket route container -> host with nothing but the name.
//   3. `list()` merges the containers of EVERY host (one listManagedContainers per host, in
//      parallel); a failing host only degrades ITS containers to status 'absent' + a warning,
//      and a container whose host was deleted comes back with hostMissing:true.
//   4. Agents: `resolveAgents(cfg)` feeds buildContainerSpec, `ensureAgentVolumes` creates
//      one auth volume per agent, and the root repairs in `afterStart` chown the agent dirs
//      (<containerHome>/.porterclaude/agents/<id>) and re-create the agent symlinks.
//   5. `reconcile()` reads porterclaude.host / porterclaude.agents back from the labels when
//      it adopts an orphan, and skips hosts it cannot reach.
//   5a. INSTANCE SCOPING: every container/volume created here carries
//      `porterclaude.instance=<config.instanceId>`, and `listManagedContainers` hides the
//      containers of ANOTHER PorterClaude install on the same engine (`ownedByThisInstance`)
//      — see that method for the whole rule.
//   6. The TOOLS VOLUME of the host is a hard precondition (INT2-2): every v0.2 container
//      runs `<toolsMount>/entrypoint.sh` as its entrypoint, so a host whose tools volume was
//      never synced can only produce crash-looping containers. `ToolsReadinessProbe` (the
//      narrow half of ImageService) is asked before a container is created — an answer it is
//      sure about refuses the create with 409, everything else never blocks.
import type { ServiceDeps } from '../context.js';
import type { GeneralConfig } from '../config/schema.js';
import { GeneralConfigSchema } from '../config/schema.js';
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
import type { HostConfig } from '../hosts/model.js';
import type { AgentDefinition } from '../agents/model.js';
import {
  DEFAULT_LOGIN_SET,
  agentDataDir,
  agentDataRoot,
  agentHistoryTarget,
  agentLinks,
  agentLoginVolumeFor,
  loginSetFor,
} from '../agents/model.js';
import { PROFILE_ID_RE } from '../profiles/model.js';
import type { ProfileConfig } from '../profiles/model.js';
import { applyManagedSettings } from '../profiles/apply.js';
import { syncProfilePlugins } from '../profiles/plugins.js';
import type { ContainerConfig, ContainerInput, ContainerPreparation, ContainerView } from './model.js';
import {
  CONTAINER_LABELS,
  ContainerNameSchema,
  containerAgentIds,
  containerLabelOf,
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
import type { ProfileSpecInput } from './container.js';

/** label of the short-lived helper containers; deliberately NOT porterclaude.managed. */
const VOLUME_INIT_LABEL = 'porterclaude.volume-init';

/** label every auth volume carries so the UI/QA can tell whose login lives in it. */
const VOLUME_AGENT_LABEL = 'porterclaude.agent';

/** v0.4: label on a NON-default login-set volume, naming the set (docs/design/users.md §0). */
const VOLUME_LOGIN_SET_LABEL = 'porterclaude.login-set';

/** scratch mount prefix of a private history volume inside the volume-init container. */
const HISTORY_INIT_MOUNT = '/pc-hist';

/** uid:gid the recipe images give their container user - the canonical owner of the shared
 *  agent volumes while they are still root-owned (docker/recipes/common.sh). */
const SHARED_VOLUME_OWNER = '1000:1000';

/** the only agent whose profile slice becomes a managed-settings file today (v0.4) */
const MANAGED_SETTINGS_AGENT_ID = 'claude';

/** marker every file generated inside a container carries (docker/tools/entrypoint.sh). */
const GENERATED_MARKER = '# porterclaude (generated) - do not duplicate';

export interface RemoveOptions {
  /** also delete <prefix>ws-<slug> / the per-agent <prefix>hist-<slug>[-<agent>] volumes */
  removeVolumes?: boolean;
  /** delete the stored config too (default true; false = keep definition, drop container) */
  forget?: boolean;
}

export interface ReconcileReport {
  known: number;
  running: number;
  /** containers labelled porterclaude.managed that STILL have no stored config after this
   *  run (everything, when the caller did not ask to adopt) */
  orphans: string[];
  /** orphans this run turned back into stored containers (POST /api/containers/reconcile only) */
  adopted: string[];
  /** stored containers whose container is gone */
  missing: string[];
}

/** What `resolveAgents` needs of a container (a stored config always satisfies it). */
type ContainerAgentRef = Pick<ContainerConfig, 'name' | 'hostId' | 'agents'>;

/**
 * The half of ImageService this service needs: can the tools volume of a host carry a
 * container at all. Kept as a narrow interface so containers do not depend on the whole image
 * service (and so a test can hand in a stub), exactly like SessionService's
 * `AgentInstallProbe`. See ImageService.toolsReadiness.
 */
export interface ToolsReadinessProbe {
  toolsReadiness(
    hostId: string,
    opts?: { probeImage?: string },
  ): Promise<'ready' | 'unsynced' | 'unknown'>;
  /**
   * v0.2.2 — the "just do it" half (ImageService implements all three). Optional so a test
   * stub can still be a bare readiness probe; without them a host that is not ready is
   * refused exactly like in v0.2.1 instead of being prepared.
   */
  ensureRecipeImage?(hostId: string, recipe: string): Promise<PreparationJob | null>;
  ensureToolsSynced?(hostId: string, probeImage?: string): Promise<PreparationJob | null>;
  awaitJob?(id: string): Promise<PreparationJob | null>;
}

/** The bit of ImageService's JobSummary a preparation cares about. */
export interface PreparationJob {
  id: string;
  kind: string;
  target: string;
  status: string;
  error: string | null;
}

/** A host plus everything a container operation on it needs. */
interface HostScope {
  host: HostConfig;
  general: GeneralConfig;
  backend: DockerBackend;
}

/** One host's live state, gathered once per list()/reconcile() call. */
interface HostScan {
  host: HostConfig;
  general: GeneralConfig;
  backend: DockerBackend | null;
  containers: ContainerSummary[];
  inspects: Map<string, ContainerInspect>;
  /** why this host contributed nothing (dead engine, missing credential, tcp/ssh, ...) */
  warning: string | null;
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

/** The concrete image ref a container runs: recipes resolve to <ns>/<recipe>:latest. */
function resolvedImageRefFor(cfg: ContainerConfig, general: GeneralConfig): string {
  return cfg.image.type === 'recipe'
    ? recipeImageRef(general.imageNamespace, cfg.image.recipe)
    : cfg.image.ref;
}

/** One piece of host work a container needs before it can run (v0.2.2, see prepare()). */
type PreparationStep =
  | { kind: 'build-image'; recipe: string; ref: string }
  | { kind: 'sync-tools' };

function describeStep(step: PreparationStep | undefined): string {
  if (!step) return 'preparing the host';
  return step.kind === 'build-image'
    ? `building the '${step.recipe}' image`
    : 'syncing the tools volume';
}

/** true for a container user that is root (or unset, which means root). */
function isRootUser(user: string): boolean {
  const u = user.trim();
  return u === '' || u === 'root' || u === '0' || u.startsWith('0:') || u.startsWith('root:');
}

export class ContainerService {
  /** transient, per-container warnings (git seeding, start problems, ...) */
  private readonly warnings = new Map<string, string[]>();

  /** containers whose definition was reconstructed from a container in THIS process; their
   *  config describes the running container even when the spec hash cannot match. */
  private readonly adopted = new Set<string>();

  /** name -> the preparation running for it right now (v0.2.2, see prepare()) */
  private readonly preparations = new Map<string, ContainerPreparation>();

  constructor(
    private readonly deps: ServiceDeps,
    /** optional: without it the tools volume is simply never checked (see requireSyncedTools) */
    private readonly tools?: ToolsReadinessProbe,
  ) {}

  // -------------------------------------------------------------------------
  // hosts
  // -------------------------------------------------------------------------

  /** host + effective settings + live transport. Throws like `hosts.backendFor`. */
  private scope(hostId: string): HostScope {
    return this.scopeForHost(this.deps.hosts.require(hostId));
  }

  private scopeForHost(host: HostConfig): HostScope {
    return {
      host,
      general: this.deps.hosts.settingsForHost(host),
      backend: this.deps.hosts.backendFor(host.id),
    };
  }

  /**
   * Settings used to render a container whose host is GONE (deleted with force=1): the
   * default host's, or the plain defaults when there is no host at all. Only ever used for
   * cosmetics (container name, image ref) — such a container is read-only until its host
   * exists again.
   */
  private settingsWithoutHost(): GeneralConfig {
    const fallback = this.deps.hosts.defaultHostId();
    if (fallback) {
      try {
        return this.deps.hosts.settingsFor(fallback);
      } catch (err) {
        this.deps.log.debug({ err, hostId: fallback }, 'settings of the default host unavailable');
      }
    }
    return GeneralConfigSchema.parse({});
  }

  /** Gather one host's managed containers; never throws (a dead host is a warning). */
  private async scanHost(host: HostConfig): Promise<HostScan> {
    const general = this.deps.hosts.settingsForHost(host);
    let backend: DockerBackend | null = null;
    let containers: ContainerSummary[] = [];
    let warning: string | null = null;
    try {
      backend = this.deps.hosts.backendFor(host.id);
      containers = this.ownContainers(host, await this.listManagedContainers(backend));
    } catch (err) {
      warning = `docker backend unavailable: ${errMessage(err)}`;
      containers = [];
    }
    const inspects = backend && containers.length ? await this.inspectAll(backend, containers) : new Map();
    return { host, general, backend, containers, inspects, warning };
  }

  /**
   * QA B-3: two hosts may point at the SAME engine (backend.md §12.1 — a socket host plus the
   * imported Portainer endpoint of the same machine is the normal v0.1 -> v0.2 case). Both
   * scans then see every `porterclaude.managed=true` container of that engine, so a container
   * that explicitly belongs to ANOTHER configured host is dropped here: it is that host's scan
   * to report. Without this every container showed up twice in GET /api/containers (once matched,
   * once as the other host's orphan), `?hostId=` leaked foreign rows and reconcile(adopt)
   * stored other hosts' containers. Label-less (v0.1) containers and containers whose label
   * names a host this install does not know stay with the scanning host.
   */
  private ownContainers(host: HostConfig, containers: ContainerSummary[]): ContainerSummary[] {
    return containers.filter((container) => {
      const label = container.labels[CONTAINER_LABELS.host];
      if (!label || label === host.id) return true;
      return !this.deps.hosts.get(label);
    });
  }

  /**
   * Second half of the same-engine rule (QA B-3): a container that carries NO usable
   * `porterclaude.host` label (a v0.1 container, or one labelled for a host this install does
   * not know) is visible in the scan of every host that points at that engine. Assign each of
   * them to exactly one host — the one whose stored container or whose `containerPrefix` claims
   * the name, else the default host, else the first scan — so nothing is listed (or adopted)
   * twice. Container ids are engine-unique, so seeing one id in two scans means one engine.
   */
  private dedupeScans(scans: HostScan[]): HostScan[] {
    if (scans.length < 2) return scans;
    const seenIn = new Map<string, HostScan[]>();
    for (const scan of scans) {
      for (const container of scan.containers) {
        const list = seenIn.get(container.id);
        if (list) list.push(scan);
        else seenIn.set(container.id, [scan]);
      }
    }

    const configs = this.deps.config.listContainers();
    const defaultHostId = this.deps.hosts.defaultHostId();
    const owner = new Map<string, string>();
    for (const [id, candidates] of seenIn) {
      const first = candidates[0] as HostScan;
      if (candidates.length === 1) {
        owner.set(id, first.host.id);
        continue;
      }
      const container = first.containers.find((c) => c.id === id) as ContainerSummary;
      const claimed = candidates.find((scan) =>
        configs.some(
          (cfg) => cfg.hostId === scan.host.id && this.matchContainer([container], cfg.name, scan.general),
        ));
      const prefixed = candidates
        .filter((scan) => container.name.startsWith(scan.general.containerPrefix))
        .sort((a, b) => b.general.containerPrefix.length - a.general.containerPrefix.length)[0];
      const fallback = candidates.find((scan) => scan.host.id === defaultHostId) ?? first;
      owner.set(id, (claimed ?? prefixed ?? fallback).host.id);
    }

    return scans.map((scan) => ({
      ...scan,
      containers: scan.containers.filter((c) => owner.get(c.id) === scan.host.id),
    }));
  }

  /**
   * Scan of EVERY host, deduped, plus the subset a `?hostId=` filter asks about (QA B-5).
   *
   * The filter must not narrow the SCAN: `dedupeScans` needs at least two scans of the same
   * engine to decide who owns a container that carries no usable `porterclaude.host` label,
   * so scanning only the filtered host made every such orphan belong to whoever was filtered
   * - it showed up under both host filters with a different hostId each time, and a filtered
   * reconcile adopted it instead of leaving it to the prefix/default owner. The filter is
   * applied to the RESULT of the deduped scan instead.
   */
  private async scanAll(wanted?: string): Promise<{ scans: HostScan[]; active: HostScan[] }> {
    const scans = this.dedupeScans(
      await Promise.all(this.deps.hosts.list().map((host) => this.scanHost(host))),
    );
    return { scans, active: wanted ? scans.filter((s) => s.host.id === wanted) : scans };
  }

  /**
   * The host a scanned container belongs to: the `porterclaude.host` label when this install
   * knows that host, else the host whose backend listed it (backend.md §13). A label naming an
   * unknown host must never win — that produced dangling `hostMissing:true` containers on adopt.
   */
  private hostIdForContainer(container: ContainerSummary, scanningHostId: string): string {
    const label = container.labels[CONTAINER_LABELS.host];
    return label && this.deps.hosts.get(label) ? label : scanningHostId;
  }

  // -------------------------------------------------------------------------
  // queries
  // -------------------------------------------------------------------------

  /**
   * Stored configs merged with live container state, across EVERY host. Never throws when a
   * backend is down: those containers come back with status 'absent' and a warning, the other
   * hosts are unaffected. `opts.hostId` filters (api.md v0.2 `GET /api/containers?hostId=`).
   */
  async list(opts?: { hostId?: string }): Promise<ContainerView[]> {
    const wanted = opts?.hostId;
    const configs = this.deps.config.listContainers().filter((c) => !wanted || c.hostId === wanted);

    // `?hostId=` filters the RESULT, not the scan (see scanAll): two hosts on one engine can
    // only be told apart when both were scanned.
    const { scans, active } = await this.scanAll(wanted);
    const byHost = new Map(scans.map((scan) => [scan.host.id, scan]));

    const views: ContainerView[] = [];
    for (const scan of active) {
      views.push(...(await this.viewsForHost(scan, configs.filter((c) => c.hostId === scan.host.id))));
    }
    // containers whose host was deleted (force): still listed, read-only, flagged
    const dangling = configs.filter((c) => !byHost.has(c.hostId));
    if (dangling.length) {
      const general = this.settingsWithoutHost();
      for (const cfg of dangling) {
        views.push(
          this.toView(cfg, null, null, general, {
            hostName: cfg.hostId,
            hostMissing: true,
            warnings: [`host '${cfg.hostId}' no longer exists; this container is read-only`],
          }),
        );
      }
    }

    views.sort((a, b) => a.name.localeCompare(b.name));
    // `?hostId=` filters on the RESULT: a reconstructed config may resolve to another host
    // than the one that scanned it (porterclaude.host label), and that row belongs to the
    // labelled host, not to this filter.
    return wanted ? views.filter((v) => v.hostId === wanted) : views;
  }

  /** The views of one host: stored containers first, then the orphan containers. */
  private async viewsForHost(scan: HostScan, configs: ContainerConfig[]): Promise<ContainerView[]> {
    const { general, containers, inspects, backend } = scan;
    const hostWarnings = scan.warning ? [scan.warning] : [];

    const matched = configs.map((cfg) => ({
      cfg,
      container: this.matchContainer(containers, cfg.name, general),
    }));
    const used = new Set(matched.map((m) => m.container?.id).filter((id): id is string => Boolean(id)));
    const orphanContainers = containers.filter((c) => !used.has(c.id));

    // One image inspect per distinct ref: the stored containers' image refs (so a view can
    // tell whether the container still runs what <ns>/<recipe>:latest points at, see
    // ContainerView.imageOutdated) plus the images of the orphan containers (whose config is
    // reconstructed from them).
    const images = await this.inspectRefs(backend, [
      ...matched.map((m) => resolvedImageRefFor(m.cfg, general)),
      ...orphanContainers.map((c) => c.image),
    ]);

    const views: ContainerView[] = [];
    for (const { cfg, container } of matched) {
      views.push(
        this.toView(cfg, container, container ? inspects.get(container.id) ?? null : null, general, {
          hostName: scan.host.name,
          images,
          warnings: hostWarnings,
        }),
      );
    }

    const orphans = orphanContainers.map((container) => {
      const inspect = inspects.get(container.id) ?? null;
      return {
        container,
        inspect,
        cfg: this.synthesizeConfig(container, inspect, general, scan.host.id, images.get(container.image) ?? null),
      };
    });

    // An orphan's reconstructed definition names a ref (porterclaude/node:latest) that the
    // container itself no longer reports — that is precisely the case imageOutdated is for,
    // so those refs need an inspect too. Second round trip, and only when it adds something.
    const extraRefs = orphans
      .map((o) => resolvedImageRefFor(o.cfg, general))
      .filter((ref) => !images.has(ref));
    if (extraRefs.length) {
      for (const [ref, image] of await this.inspectRefs(backend, extraRefs)) images.set(ref, image);
    }

    for (const { container, inspect, cfg } of orphans) {
      views.push(
        this.toView(cfg, container, inspect, general, {
          hostName: scan.host.name,
          orphan: true,
          images,
        }),
      );
    }
    return views;
  }

  /** AppError.notFound when unknown. */
  async get(name: string): Promise<ContainerView> {
    const stored = this.deps.config.getContainer(name);
    const views = await this.list(stored ? { hostId: stored.hostId } : undefined);
    const view = views.find((v) => v.name === name);
    if (!view) throw AppError.notFound(`container '${name}' does not exist`);
    return view;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create on `input.hostId ?? defaultHostId`: validate the name is free (every stored
   * container plus the containers of the TARGET host), ensure the volumes exist, resolve the
   * image, create the container, start it when autoStart, and persist the config only after
   * a successful create (rolling the container back when persisting fails).
   *
   * v0.2.2: when the host is not ready for this container — the recipe image was never built,
   * or the tools volume was never synced — the create does NOT fail any more. The definition
   * is persisted immediately (so nothing the user typed is lost), the missing work is started
   * on the host, and the returned view carries `preparing`; the container is created and
   * started by that background run. Everything else is unchanged and still synchronous.
   */
  async create(input: ContainerInput): Promise<ContainerView> {
    const hostId = this.deps.hosts.requireHostId(input.hostId);
    this.assertKnownAgents(input.agents);
    this.assertKnownProfile(input.profileId);
    const scope = this.scope(hostId);

    // names are unique ACROSS hosts (api.md v0.2)
    if (this.deps.config.getContainer(input.name)) {
      throw AppError.conflict(`container '${input.name}' already exists`);
    }
    const existing = this.matchContainer(
      // a container of ANOTHER install occupies the name just as much as one of ours
      await this.listManagedContainers(scope.backend, { anyInstance: true }),
      input.name,
      scope.general,
    );
    if (existing) {
      throw AppError.conflict(
        `a container named '${containerNameFor(scope.general.containerPrefix, input.name)}' ` +
          `already exists on host '${hostId}'`,
      );
    }

    const now = new Date().toISOString();
    const cfg: ContainerConfig = {
      ...input,
      hostId,
      createdAt: now,
      updatedAt: now,
    };

    // Not ready? Keep the definition and do the work instead of refusing it.
    const steps = await this.preparationSteps(scope, cfg);
    if (steps.length) {
      await this.deps.config.putContainer(cfg);
      this.prepare(scope, cfg, steps, 'create');
      return this.get(cfg.name);
    }

    await this.materialize(scope, cfg, { start: cfg.autoStart });
    return this.get(cfg.name);
  }

  /**
   * createContainerFor + start + persist, with the rollback that belongs to it: whatever
   * this call created on the engine is removed again when a later step fails, so a failed
   * create never leaves a half-container or an empty workspace volume behind.
   *
   * `putContainer` is an upsert: in the prepared path (see prepare()) the definition is
   * already stored and this only writes the spec hash back.
   */
  private async materialize(
    scope: HostScope,
    cfg: ContainerConfig,
    opts: { start: boolean },
  ): Promise<void> {
    const created = await this.createContainerFor(scope, cfg);
    cfg.specHash = created.specHash;

    if (opts.start) {
      try {
        await scope.backend.startContainer(created.id);
      } catch (err) {
        await this.safeRemoveContainer(scope.backend, created.id);
        await this.removeFreshVolumes(scope.backend, created.freshVolumes);
        throw err;
      }
      await this.afterStart(scope, cfg, created.id);
    }

    try {
      await this.deps.config.putContainer(cfg);
    } catch (err) {
      await this.safeRemoveContainer(scope.backend, created.id);
      await this.removeFreshVolumes(scope.backend, created.freshVolumes);
      throw err;
    }

    if (created.warnings.length) this.addWarnings(cfg.name, created.warnings);
  }

  /** Edit = recreate: stop -> remove container (keep volumes) -> create -> start if it was
   *  running or autoStart. Named volumes and the workspace survive. */
  async update(name: string, input: ContainerInput): Promise<ContainerView> {
    // adopts a label-matched container when /data was lost (see loadConfig)
    const stored = await this.loadConfig(name);
    if (input.name !== name) {
      throw AppError.validation('container name is immutable; create a new container instead', [
        { path: ['name'], message: `expected '${name}'` },
      ]);
    }
    if (input.hostId && input.hostId !== stored.hostId) {
      throw AppError.validation(
        'the host of a container is immutable; create the container on the other host instead',
        [{ path: ['hostId'], message: `expected '${stored.hostId}'` }],
      );
    }
    this.assertKnownAgents(input.agents);
    this.assertKnownProfile(input.profileId);
    const cfg: ContainerConfig = {
      ...input,
      hostId: stored.hostId,
      createdAt: stored.createdAt,
      updatedAt: new Date().toISOString(),
    };
    return this.replaceContainer(cfg);
  }

  /** Recreate from the stored config without changing it (e.g. after an image rebuild). */
  async recreate(name: string): Promise<ContainerView> {
    const stored = await this.loadConfig(name);
    return this.replaceContainer({ ...stored, updatedAt: new Date().toISOString() });
  }

  /** `opts.prepared` is internal: the preparation that just finished calls back in here and
   *  must not re-enter it (see runPreparation). */
  async start(name: string, opts?: { prepared?: boolean }): Promise<ContainerView> {
    const { scope, container } = await this.locate(name);
    // An orphan (container labelled porterclaude.container=<name> with no stored config,
    // e.g. after losing /data) is adopted here instead of 404ing.
    const cfg = await this.loadConfig(name, scope, container);

    // Same rule as create(): a host that is not ready is made ready rather than refused —
    // this is also the retry path after a preparation failed, and the button the UI offers
    // for a container whose image was pruned or whose host was re-synced.
    if (!opts?.prepared) {
      const steps = await this.preparationSteps(scope, cfg, container !== null);
      if (steps.length) {
        this.prepare(scope, cfg, steps, container ? 'start' : 'create');
        return this.get(name);
      }
    }

    if (!container) {
      await this.materialize(scope, cfg, { start: true });
      return this.get(name);
    }

    if (container.state !== 'running') {
      await scope.backend.startContainer(container.id);
      await this.afterStart(scope, cfg, container.id);
    }
    return this.get(name);
  }

  async stop(name: string): Promise<ContainerView> {
    const { scope, container } = await this.locate(name);
    if (container && container.state !== 'exited' && container.state !== 'created') {
      await scope.backend.stopContainer(container.id, { timeoutSec: 10 });
    }
    return this.get(name);
  }

  async restart(name: string): Promise<ContainerView> {
    const { scope, container } = await this.locate(name);
    if (!container) throw AppError.conflict(`container '${name}' has no container; recreate it first`);
    await scope.backend.restartContainer(container.id, { timeoutSec: 10 });
    // Same post-start repairs as start(): the container layer survives a restart, but the
    // tools volume (and with it the bootstrap the server installs from the outside) may
    // have been updated in the meantime - a restart is how a user applies that. Orphans
    // are skipped on purpose: a restart must not adopt them (see reconcile).
    const stored = this.deps.config.getContainer(name);
    if (stored) await this.afterStart(scope, stored, container.id);
    return this.get(name);
  }

  async remove(name: string, opts?: RemoveOptions): Promise<void> {
    // A container whose host was deleted (force=1) has no engine to talk to any more, but it
    // must still be deletable - otherwise it would be stuck in the list forever.
    const dangling = this.deps.config.getContainer(name);
    if (dangling && !this.deps.hosts.get(dangling.hostId)) {
      this.deps.log.warn(
        { container: name, host: dangling.hostId },
        'removing a container whose host is gone: dropping the definition only',
      );
      if (opts?.forget !== false) await this.deps.config.deleteContainer(name);
      this.warnings.delete(name);
      return;
    }

    const { scope, container, stored } = await this.locate(name);
    const { backend, general } = scope;

    if (container) {
      if (container.state === 'running' || container.state === 'restarting' || container.state === 'paused') {
        try {
          await backend.stopContainer(container.id, { timeoutSec: 5 });
        } catch (err) {
          if (!isMissing(err)) this.deps.log.warn({ err, container: name }, 'stop before remove failed');
        }
      }
      try {
        await backend.removeContainer(container.id, { force: true, removeVolumes: false });
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    }

    if (opts?.removeVolumes) {
      // ONLY the per-container volumes; the shared agent auth volumes and the tools volume are
      // never touched (deleting an auth volume would drop the login of every container).
      for (const volume of [
        workspaceVolumeFor(general.volumePrefix, name),
        ...this.historyVolumesFor(name, stored ?? { hostId: scope.host.id, agents: null }, general),
      ]) {
        try {
          await backend.removeVolume(volume, { force: true });
        } catch (err) {
          if (!isMissing(err)) this.deps.log.warn({ err, volume }, 'removing container volume failed');
        }
      }
    }

    if (opts?.forget !== false) await this.deps.config.deleteContainer(name);
    this.warnings.delete(name);
  }

  async logs(name: string, opts?: { tail?: number; timestamps?: boolean }): Promise<string> {
    const { scope, container } = await this.locate(name);
    if (!container) throw AppError.conflict(`container '${name}' has no container`);
    return scope.backend.containerLogs(container.id, {
      tail: opts?.tail ?? 200,
      timestamps: opts?.timestamps ?? false,
    });
  }

  /**
   * Rebuild the view from container labels, across every reachable host: report containers
   * labelled porterclaude.managed=true that have no stored config, and flag stored containers
   * whose container disappeared. `opts.hostId` limits it to one host.
   *
   * `adopt` (the explicit POST /api/containers/reconcile, never the startup call) persists a
   * definition reconstructed from those containers so they become editable again; those
   * names come back as `adopted` and are no longer counted as `orphans` (only the ones that
   * could NOT be adopted are). The startup reconcile deliberately does not adopt: an orphan
   * must stay visible as `orphan:true` instead of being silently rewritten into a
   * reconstructed definition behind the user's back. start/recreate/update adopt on demand
   * as well (loadConfig).
   */
  async reconcile(opts?: { adopt?: boolean; hostId?: string }): Promise<ReconcileReport> {
    const wanted = opts?.hostId;
    // every host is scanned even for a filtered reconcile: only then does dedupeScans know
    // which host owns a label-less container of a shared engine (QA B-5)
    const { active } = await this.scanAll(wanted);

    const orphans: string[] = [];
    const adopted: string[] = [];
    const missing: string[] = [];
    let running = 0;

    for (const scan of active) {
      const backend = scan.backend;
      if (scan.warning || !backend) {
        this.deps.log.warn(
          { host: scan.host.id, reason: scan.warning ?? 'no transport' },
          'reconcile skipped a host',
        );
        continue;
      }
      const configs = this.deps.config.listContainers().filter((c) => c.hostId === scan.host.id);
      const matched = new Set<string>();
      for (const cfg of configs) {
        const container = this.matchContainer(scan.containers, cfg.name, scan.general);
        if (container) matched.add(container.id);
        else missing.push(cfg.name);
      }
      running += scan.containers.filter((c) => c.state === 'running').length;

      for (const container of scan.containers.filter((c) => !matched.has(c.id))) {
        const label = containerLabelOf(container.labels) ?? container.name;
        if (!opts?.adopt) {
          orphans.push(label);
          continue;
        }
        // Explicit user action: adopt the orphan so it becomes startable/editable again. It
        // is reported as `adopted`, NOT as an orphan: by the time this response is written
        // the container is stored and a following GET already says orphan:false.
        try {
          const cfg = await this.adopt(
            { host: scan.host, general: scan.general, backend },
            container,
            scan.inspects.get(container.id) ?? null,
          );
          adopted.push(cfg.name);
        } catch (err) {
          this.deps.log.warn({ err, container: label }, 'adopting an orphan container failed');
          orphans.push(label);
        }
      }
    }

    const known = this.deps.config
      .listContainers()
      .filter((c) => !wanted || c.hostId === wanted).length;
    const report: ReconcileReport = { known, running, orphans, adopted, missing };
    this.deps.log.info({ report }, 'container reconcile');
    return report;
  }

  /**
   * FROZEN SIGNATURE (additive only) — used by SessionService. Resolves a container name to a
   * RUNNING container id on ITS host. Throws AppError.notFound / AppError.conflict('container
   * not running'); a container whose host is gone throws so the websocket can answer 4411
   * (sessions/service.ts maps it).
   *
   * `containerAgents` is what the CONTAINER really mounts (porterclaude.agents label, or the
   * PORTERCLAUDE_AGENT_IDS env of a container whose label was lost), `null` for a v0.1
   * container that carries neither. SessionService gates `shell=agent:<id>` on it instead of
   * on `agents ?? host.agents.enabled`: enabling an agent on the host does not retro-mount an
   * auth volume into a container created before that, and running it anyway would start a
   * fresh, unauthenticated instance.
   */
  async requireRunningContainer(name: string): Promise<{
    containerId: string;
    config: ContainerConfig;
    hostId: string;
    containerAgents: string[] | null;
  }> {
    const { scope, container, stored } = await this.locate(name, { requireContainer: false });
    if (!container) {
      if (!stored) throw AppError.notFound(`container '${name}' does not exist`);
      throw AppError.conflict(`container '${name}' is not running`);
    }
    if (container.state !== 'running') throw AppError.conflict(`container '${name}' is not running`);
    const config = stored ?? this.synthesizeConfig(container, null, scope.general, scope.host.id);
    return {
      containerId: container.id,
      config,
      hostId: config.hostId,
      containerAgents: await this.containerAgents(scope, container),
    };
  }

  /**
   * `containerAgentIds` of a live container: the label first, and only when it is missing
   * (v0.1 container, or one whose labels were stripped) one inspect for the env. The inspect
   * is best effort — an engine hiccup here must not turn a session open into a 500, it just
   * means "unknown" and the caller falls back to the configured agents.
   */
  private async containerAgents(
    scope: HostScope,
    container: ContainerSummary,
  ): Promise<string[] | null> {
    const fromLabel = containerAgentIds(container.labels);
    if (fromLabel) return fromLabel;
    try {
      const inspect = await scope.backend.inspectContainer(container.id);
      return containerAgentIds(container.labels, inspect.env);
    } catch (err) {
      this.deps.log.debug({ err, containerId: container.id }, 'reading the container agents failed');
      return null;
    }
  }

  /**
   * Ensure the per-agent auth volumes of a container exist on ITS host (idempotent). v0.4:
   * the volume of the LOGIN SET the container's profile picks (`default` = the v0.2 name).
   * The v0.1 shared claude volumes are NOT created any more — they only survive as the
   * source of the one-time legacy import done by the tools sync (images/service.ts).
   */
  async ensureAgentVolumes(
    scope: HostScope,
    agents: AgentDefinition[],
    profileId: string | null = null,
  ): Promise<void> {
    const profile = this.resolveProfileForSpec(profileId);
    for (const agent of agents) {
      const loginSet = loginSetFor(profileId, profile, agent.id);
      await scope.backend.createVolume({
        name: agentLoginVolumeFor(scope.general.volumePrefix, agent.id, loginSet),
        labels: {
          [CONTAINER_LABELS.managed]: 'true',
          [CONTAINER_LABELS.instance]: this.deps.config.instanceId(),
          [VOLUME_AGENT_LABEL]: agent.id,
          ...(loginSet === DEFAULT_LOGIN_SET ? {} : { [VOLUME_LOGIN_SET_LABEL]: loginSet }),
        },
      });
    }
  }

  /**
   * An explicit `agents` list may only name agents the registry knows: `resolveAgents` drops
   * unknown ids silently, so without this a typo would be stored, never mounted, and reported
   * back in `agents` forever. Same rule (and same 422) as PUT /api/hosts/:hostId/agents.
   */
  private assertKnownAgents(agents: string[] | null | undefined): void {
    if (!agents) return;
    const unknown = [...new Set(agents)].filter((id) => !this.deps.agents.get(id));
    if (unknown.length > 0) {
      throw AppError.validation(
        `unknown agent id(s): ${unknown.join(', ')}`,
        unknown.map((id) => ({ path: ['agents'], message: `unknown agent '${id}'` })),
      );
    }
  }

  /**
   * v0.4: `profileId` may only name a stored profile. Passing a typo would otherwise store
   * an id whose implicit login-set volume differs from every existing volume — a container
   * that looks configured but starts with an empty login.
   */
  private assertKnownProfile(profileId: string | null | undefined): void {
    if (!profileId) return;
    if (!this.deps.config.getProfile(profileId)) {
      throw AppError.validation(`unknown profile '${profileId}'`, [
        { path: ['profileId'], message: `unknown profile '${profileId}'` },
      ]);
    }
  }

  /** v0.4: the stored profile, or null for none. No throw — used on rendering paths. */
  private resolveProfileForSpec(profileId: string | null): ProfileConfig | null {
    if (!profileId) return null;
    return this.deps.config.getProfile(profileId);
  }

  /**
   * v0.4: the profile slice `buildContainerSpec` needs, or null.
   *
   * A DANGLING profileId (profile deleted behind the container's back) deliberately yields
   * null, not `{ id, agents: {} }`: `loginSetFor` then keeps the container on its implicit
   * private volume instead of reading "no entry for this agent" and re-sharing the host-wide
   * login. `{ id, agents: {} }` is a REAL profile that simply does not touch this agent.
   */
  private profileSpecInput(cfg: Pick<ContainerConfig, 'profileId'>): ProfileSpecInput | null {
    if (!cfg.profileId) return null;
    const profile = this.resolveProfileForSpec(cfg.profileId);
    return profile ? { id: profile.id, agents: profile.agents } : null;
  }

  /**
   * The agents mounted into a container: `container.agents ?? host.agents.enabled`, resolved
   * against the registry and sorted by id (the order goes into the spec hash and into the
   * porterclaude.agents label).
   */
  resolveAgents(cfg: ContainerAgentRef): AgentDefinition[] {
    const host = this.deps.hosts.hostForContainer(cfg);
    return [...this.deps.agents.resolveForContainer(host, cfg)].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** resolveAgents for a rendering path: a dangling host must not break the container list. */
  private tryResolveAgents(cfg: ContainerAgentRef): AgentDefinition[] {
    try {
      return this.resolveAgents(cfg);
    } catch (err) {
      this.deps.log.debug({ err, container: cfg.name }, 'resolving the agents of a container failed');
      return [];
    }
  }

  /**
   * Private-history volume names of a container: one per resolved agent that declares a
   * `historyPath`. `historyVolumeFor` keeps the v0.1 name for the claude agent, which is
   * what makes an upgraded container keep its history.
   */
  private historyVolumesFor(
    name: string,
    cfg: Pick<ContainerConfig, 'hostId' | 'agents'>,
    general: GeneralConfig,
  ): string[] {
    return this.tryResolveAgents({ name, hostId: cfg.hostId, agents: cfg.agents })
      .filter((agent) => Boolean(agent.historyPath))
      .map((agent) => historyVolumeFor(general.volumePrefix, name, agent.id));
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * Find a container's host, and its container on that host. A stored container always resolves
   * through its `hostId`; a container that only exists as a container (orphan after a /data
   * loss) is searched for on every reachable host.
   */
  private async locate(
    name: string,
    opts?: { requireContainer?: boolean },
  ): Promise<{ scope: HostScope; container: ContainerSummary | null; stored: ContainerConfig | null }> {
    const stored = this.deps.config.getContainer(name) ?? null;
    if (stored) {
      const scope = this.scope(stored.hostId);
      const container = this.matchContainer(
        await this.listManagedContainers(scope.backend),
        name,
        scope.general,
      );
      return { scope, container, stored };
    }

    let fallback: HostScope | null = null;
    for (const host of this.deps.hosts.list()) {
      let scope: HostScope;
      try {
        scope = this.scopeForHost(host);
      } catch (err) {
        this.deps.log.debug({ err, host: host.id }, 'host unusable while locating a container');
        continue;
      }
      fallback = fallback ?? scope;
      let containers: ContainerSummary[];
      try {
        containers = await this.listManagedContainers(scope.backend);
      } catch (err) {
        this.deps.log.debug({ err, host: host.id }, 'listing containers while locating a container failed');
        continue;
      }
      const container = this.matchContainer(containers, name, scope.general);
      if (container) return { scope, container, stored: null };
    }
    if (opts?.requireContainer === false && fallback) return { scope: fallback, container: null, stored: null };
    throw AppError.notFound(`container '${name}' does not exist`);
  }

  /**
   * The stored definition of a container, or - when `/data` was lost and only the container
   * survived - a definition synthesized from its labels/inspect which is then PERSISTED
   * (adopted). This is what makes start/recreate/update work on `orphan:true` containers
   * instead of 404ing (backend.md section 7, "losing /data does not lose your containers").
   */
  private async loadConfig(
    name: string,
    knownScope?: HostScope,
    known?: ContainerSummary | null,
  ): Promise<ContainerConfig> {
    const stored = this.deps.config.getContainer(name);
    if (stored) return { ...stored };

    const located = known && knownScope ? { scope: knownScope, container: known } : await this.locate(name);
    const { scope, container } = located;
    if (!container) throw AppError.notFound(`container '${name}' does not exist`);

    let inspect: ContainerInspect | null = null;
    try {
      inspect = await scope.backend.inspectContainer(container.id);
    } catch (err) {
      this.deps.log.debug({ err, containerId: container.id }, 'inspect during adoption failed');
    }
    return this.adopt(scope, container, inspect);
  }

  /** Persist a synthesized config for a managed container that has none. */
  private async adopt(
    scope: HostScope,
    container: ContainerSummary,
    inspect: ContainerInspect | null,
  ): Promise<ContainerConfig> {
    const images = await this.inspectRefs(scope.backend, [container.image]);
    const cfg = this.synthesizeConfig(
      container,
      inspect,
      scope.general,
      scope.host.id,
      images.get(container.image) ?? null,
    );
    if (!ContainerNameSchema.safeParse(cfg.name).success) {
      throw AppError.conflict(
        `container '${container.name}' cannot be adopted: '${cfg.name}' is not a valid container name`,
      );
    }
    if (this.deps.config.getContainer(cfg.name)) return { ...cfg };
    await this.deps.config.putContainer(cfg);
    this.adopted.add(cfg.name);
    this.deps.log.info(
      { container: cfg.name, containerId: container.id, host: scope.host.id },
      'adopted orphan container',
    );
    return cfg;
  }

  /**
   * The `porterclaude.managed=true` containers of an engine THIS INSTALL may touch.
   *
   * `opts.anyInstance` is for the one caller that must see everything: the create-time name
   * check, where a foreign container occupying the name is still a conflict (docker would
   * refuse the create with a much worse message).
   */
  private async listManagedContainers(
    backend: DockerBackend,
    opts?: { anyInstance?: boolean },
  ): Promise<ContainerSummary[]> {
    const all = await backend.listContainers({
      all: true,
      labelFilters: { [CONTAINER_LABELS.managed]: 'true' },
    });
    return opts?.anyInstance ? all : this.ownedByThisInstance(all);
  }

  /**
   * QA R1-INT2-5 / R2-INT2-6: several PorterClaude INSTALLS may share one engine (that is
   * what the `containerPrefix`/`volumePrefix` overrides are for). Every container this
   * install creates carries `porterclaude.instance=<config.instanceId>`, so a container
   * labelled for ANOTHER install is dropped here: without it each install listed the other's
   * containers as adoptable orphans — with its own hostName, its own rewritten resolvedImage
   * and a session that opened into the foreign container — and could recreate or destroy
   * them from its UI.
   *
   * A container with NO instance label stays visible: that is a v0.1 / v0.2.0 container of
   * THIS install (nothing else ever wrote the label), and dropping it would strand every
   * container created before the upgrade.
   */
  private ownedByThisInstance(containers: ContainerSummary[]): ContainerSummary[] {
    const mine = this.deps.config.instanceId();
    return containers.filter((c) => {
      const label = c.labels[CONTAINER_LABELS.instance];
      return !label || label === mine;
    });
  }

  /**
   * The container of a stored definition: by label first, by derived name second.
   *
   * The label read goes through `containerLabelOf`, which also accepts the v0.2
   * `porterclaude.session` label — every container created before v0.3 carries only that one,
   * and the name fallback below would mask a missing compatibility read here (it matches, so
   * a container still looks found) while reconcile() and synthesizeConfig() already read the
   * wrong name.
   */
  private matchContainer(
    containers: ContainerSummary[],
    name: string,
    general: GeneralConfig,
  ): ContainerSummary | null {
    const containerName = containerNameFor(general.containerPrefix, name);
    return (
      containers.find((c) => containerLabelOf(c.labels) === name) ??
      containers.find((c) => c.name === containerName || c.names.includes(containerName)) ??
      null
    );
  }

  private async inspectAll(
    backend: DockerBackend | null,
    containers: ContainerSummary[],
  ): Promise<Map<string, ContainerInspect>> {
    const out = new Map<string, ContainerInspect>();
    if (!backend || !containers.length) return out;
    const results = await Promise.allSettled(containers.map((c) => backend.inspectContainer(c.id)));
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') out.set(containers[i]!.id, res.value);
    });
    return out;
  }

  /** image inspects keyed by ref; missing/unreachable images map to nothing. Used to
   *  subtract the image's own env when reconstructing a config and to compare the image a
   *  container runs with the one its ref resolves to today. */
  private async inspectRefs(
    backend: DockerBackend | null,
    wanted: string[],
  ): Promise<Map<string, ImageInspect>> {
    const out = new Map<string, ImageInspect>();
    const refs = [...new Set(wanted.filter((r) => r.length > 0))];
    if (!backend || !refs.length) return out;
    const results = await Promise.allSettled(refs.map((ref) => backend.inspectImage(ref)));
    results.forEach((res, i) => {
      if (res.status === 'fulfilled' && res.value) out.set(refs[i]!, res.value);
    });
    return out;
  }

  /**
   * resolve the image + ensure volumes + createContainer (no start, no persist).
   *
   * The image is resolved FIRST: it is the step most likely to fail (a recipe that is not
   * built -> 409, a custom ref that cannot be pulled -> 502) and creating
   * <prefix>ws-<slug> before it would leave an empty volume behind that no container
   * owns. Whatever this call does create is rolled back when a later step throws — but only
   * the volumes it created itself, never one that already held a workspace.
   */
  private async createContainerFor(
    scope: HostScope,
    cfg: ContainerConfig,
  ): Promise<{ id: string; specHash: string; warnings: string[]; freshVolumes: string[] }> {
    const { backend, general } = scope;
    const agents = this.resolveAgents(cfg);
    const { ref: resolvedImage, imageEnvPath, imageCmd } = await this.resolveImage(scope, cfg);

    // ... and only THEN is the host asked whether it can run a container at all: a tools volume
    // without the bootstrap produces nothing but a crash-looping container (INT2-2). The
    // container image is handed to the probe because it is an image that provably exists on
    // that engine, which is what lets the volume be read on a host that never synced.
    await this.requireSyncedTools(scope, resolvedImage);

    await this.ensureAgentVolumes(scope, agents, cfg.profileId);

    const wanted: string[] = [];
    const workspace = workspaceMountFor(cfg, general);
    if (workspace.type === 'volume') wanted.push(workspace.source);
    if (!cfg.shareHistory) wanted.push(...this.historyVolumesFor(cfg.name, cfg, general));

    // null = the engine could not be asked; then nothing is rolled back rather than
    // guessing that a volume is new and deleting somebody's workspace.
    const before = wanted.length ? await this.existingVolumeNames(backend) : new Set<string>();
    const fresh: string[] = [];
    try {
      for (const name of wanted) {
        await backend.createVolume({
          name,
          labels: {
            [CONTAINER_LABELS.managed]: 'true',
            [CONTAINER_LABELS.instance]: this.deps.config.instanceId(),
            [CONTAINER_LABELS.container]: cfg.name,
          },
        });
        if (before && !before.has(name)) fresh.push(name);
      }

      const warnings: string[] = [];
      if (!cfg.shareHistory) {
        warnings.push(...(await this.prepareHistoryVolumes(scope, cfg, agents, resolvedImage)));
      }
      const spec = buildContainerSpec({
        container: cfg,
        general,
        agents,
        profile: this.profileSpecInput(cfg),
        resolvedImage,
        imageType: cfg.image.type,
        instanceId: this.deps.config.instanceId(),
        imageEnvPath,
        imageCmd,
      });
      const created = await backend.createContainer(spec);
      return {
        id: created.id,
        specHash: spec.labels?.[CONTAINER_LABELS.specHash] ?? '',
        warnings: [...warnings, ...(created.warnings ?? [])],
        // the caller rolls these back too when the START or the config write fails
        freshVolumes: fresh,
      };
    } catch (err) {
      await this.removeFreshVolumes(backend, fresh);
      throw err;
    }
  }

  /** delete per-container volumes this process just created (rollback; never pre-existing ones). */
  private async removeFreshVolumes(backend: DockerBackend, names: string[]): Promise<void> {
    for (const name of names) {
      try {
        await backend.removeVolume(name, { force: true });
      } catch (err) {
        this.deps.log.warn({ err, volume: name }, 'rolling back a container volume failed');
      }
    }
  }

  /** names of the volumes that exist right now, or null when the engine cannot be asked. */
  private async existingVolumeNames(backend: DockerBackend): Promise<Set<string> | null> {
    try {
      return new Set((await backend.listVolumes()).map((v) => v.name));
    } catch (err) {
      this.deps.log.debug({ err }, 'listing volumes before a container create failed');
      return null;
    }
  }

  /**
   * shareHistory=false overlays <prefix>hist-<slug>[-<agent>] on the agent's history
   * directory, which lives INSIDE that agent's auth volume (agentHistoryTarget). If that
   * directory does not exist yet, docker creates it as root:root while setting the mount up
   * - and the fresh history volume is root-owned too. The unprivileged container user could
   * then write neither its own private history nor (once the root-owned directory is in the
   * auth volume) the SHARED history of any other container.
   *
   * So before the container is ever created we run ONE root container that mounts
   * every affected auth volume at its real path (keeping docker's empty-volume seeding
   * semantics intact) plus every history volume on a scratch path, creates the history
   * directories and hands both to the owner of the auth volume. Best effort: failures
   * become container warnings, never a failed create.
   */
  private async prepareHistoryVolumes(
    scope: HostScope,
    cfg: ContainerConfig,
    agents: AgentDefinition[],
    resolvedImage: string,
  ): Promise<string[]> {
    const { backend, general } = scope;
    const home = containerHomeFor(general);
    const withHistory = agents
      .map((agent) => ({ agent, target: agentHistoryTarget(agent, home) }))
      .filter((entry): entry is { agent: AgentDefinition; target: string } => Boolean(entry.target));
    if (!withHistory.length) return [];

    const mounts = withHistory.flatMap(({ agent }, i) => [
      {
        type: 'volume' as const,
        // v0.4: the nested history volume must sit inside the SAME login-set volume the
        // container mounts — nesting it into the shared one would put this container's
        // private history into the wrong volume.
        source: agentLoginVolumeFor(
          general.volumePrefix,
          agent.id,
          loginSetFor(cfg.profileId, this.resolveProfileForSpec(cfg.profileId), agent.id),
        ),
        target: agentDataDir(home, agent.id),
        readOnly: false,
      },
      {
        type: 'volume' as const,
        source: historyVolumeFor(general.volumePrefix, cfg.name, agent.id),
        target: `${HISTORY_INIT_MOUNT}-${i}`,
        readOnly: false,
      },
    ]);

    const script = [
      'set -u',
      ...withHistory.flatMap(({ agent, target }, i) => {
        const dir = shQuote(agentDataDir(home, agent.id));
        const scratch = `${HISTORY_INIT_MOUNT}-${i}`;
        return [
          `own=$(stat -c '%u:%g' ${dir} 2>/dev/null || true)`,
          `case "\${own:-}" in ''|0:*) own=${shQuote(SHARED_VOLUME_OWNER)};; esac`,
          `mkdir -p ${shQuote(target)} || { echo "cannot create ${target}" >&2; exit 1; }`,
          `chown "$own" ${shQuote(target)} ${scratch} 2>/dev/null || echo "chown $own failed" >&2`,
          `chmod 0700 ${shQuote(target)} ${scratch} 2>/dev/null || true`,
        ];
      }),
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
        mounts,
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

  // -------------------------------------------------------------------------
  // preparation (v0.2.2)
  //
  // v0.2.1 answered "the recipe image is not built" and "the tools volume was never synced"
  // with a 409 that told the user to go to another screen, click a button, come back and
  // retype the whole form. Both are things the server can simply DO, and both are already
  // implemented as image jobs — so it does them, in the background, and reports progress on
  // the container instead of refusing it.
  // -------------------------------------------------------------------------

  /**
   * What has to happen on the host before this definition can run. `[]` = nothing, which is
   * the normal case and keeps create/start/update fully synchronous.
   *
   * `hasContainer` skips the image check: a container that already exists starts from the
   * image it was created with, even if that image has since been pruned or retagged.
   */
  private async preparationSteps(
    scope: HostScope,
    cfg: ContainerConfig,
    hasContainer = false,
  ): Promise<PreparationStep[]> {
    // Without the "just do it" half of ImageService there is nothing to prepare WITH, and
    // requireSyncedTools/resolveImage refuse exactly like they did in v0.2.1.
    if (!this.tools?.ensureToolsSynced || !this.tools.awaitJob) return [];

    const steps: PreparationStep[] = [];
    if (!hasContainer && cfg.image.type === 'recipe' && this.tools.ensureRecipeImage) {
      const ref = recipeImageRef(scope.general.imageNamespace, cfg.image.recipe);
      const built = await scope.backend.inspectImage(ref).catch(() => null);
      if (!built) steps.push({ kind: 'build-image', recipe: cfg.image.recipe, ref });
    }
    // The tools probe needs an image that exists ON THAT ENGINE to read the volume with. If
    // the container image is about to be built, there may be none yet and the probe answers
    // 'unknown' — so the sync step is added unconditionally when a build runs, and
    // ensureToolsSynced re-probes (and does nothing) once the image is there.
    if (steps.length) {
      steps.push({ kind: 'sync-tools' });
    } else if ((await this.toolsState(scope, resolvedImageRefFor(cfg, scope.general))) === 'unsynced') {
      steps.push({ kind: 'sync-tools' });
    }
    return steps;
  }

  /**
   * Start the background preparation for `cfg` and return immediately. The caller has
   * already persisted the definition (create/replace) or is starting a stored one, so a
   * failure here is never data loss: the container stays in the list, the reason lands in its
   * warnings, and Start retries the whole thing.
   */
  private prepare(
    scope: HostScope,
    cfg: ContainerConfig,
    steps: PreparationStep[],
    mode: 'create' | 'replace' | 'start',
  ): void {
    // A second click while the first preparation runs must not start a second build.
    if (this.preparations.has(cfg.name)) return;
    const state: ContainerPreparation = {
      phase: steps[0]?.kind === 'build-image' ? 'building-image' : 'syncing-tools',
      detail: describeStep(steps[0]),
      jobs: [],
      startedAt: new Date().toISOString(),
    };
    this.preparations.set(cfg.name, state);
    void this.runPreparation(scope, cfg, steps, mode, state);
  }

  private async runPreparation(
    scope: HostScope,
    cfg: ContainerConfig,
    steps: PreparationStep[],
    mode: 'create' | 'replace' | 'start',
    state: ContainerPreparation,
  ): Promise<void> {
    const log = this.deps.log;
    try {
      for (const step of steps) {
        state.phase = step.kind === 'build-image' ? 'building-image' : 'syncing-tools';
        state.detail = describeStep(step);
        log.info({ container: cfg.name, host: scope.host.id, step: step.kind }, 'preparing the host for a container');
        const started =
          step.kind === 'build-image'
            ? await this.tools?.ensureRecipeImage?.(scope.host.id, step.recipe)
            : await this.tools?.ensureToolsSynced?.(
                scope.host.id,
                resolvedImageRefFor(cfg, scope.general),
              );
        // null = already done by the time we got here (another container prepared the same
        // host, or the probe that said 'unsynced' was stale). Nothing to wait for.
        if (!started) continue;
        state.jobs = [...state.jobs, { id: started.id, kind: started.kind, target: started.target }];
        const finished = (await this.tools?.awaitJob?.(started.id)) ?? started;
        if (finished.status !== 'success') {
          throw new Error(
            `${describeStep(step)} failed${finished.error ? `: ${finished.error}` : ` (${finished.status})`}`,
          );
        }
      }

      state.phase = mode === 'start' ? 'starting' : 'creating';
      state.detail = mode === 'start' ? 'starting the container' : 'creating the container';
      if (mode === 'replace') {
        await this.doReplace(scope, cfg);
      } else if (mode === 'start') {
        // re-locates the container: minutes have passed since the caller looked
        await this.start(cfg.name, { prepared: true });
      } else {
        await this.materialize(scope, cfg, { start: cfg.autoStart });
      }
      log.info({ container: cfg.name, host: scope.host.id }, 'container preparation finished');
    } catch (err) {
      const message = errMessage(err);
      // The definition survives — this is a warning on the container, not a lost create. The
      // UI shows it on the row and offers Start, which re-runs the whole preparation.
      this.addWarnings(cfg.name, [`preparing this container failed: ${message}`]);
      log.warn({ err, container: cfg.name, host: scope.host.id }, 'container preparation failed');
    } finally {
      this.preparations.delete(cfg.name);
    }
  }

  /**
   * The tools volume of a host is not optional: `buildContainerSpec` gives EVERY v0.2
   * container `<toolsMount>/entrypoint.sh` as its entrypoint, so a volume that was never
   * synced makes docker create an empty one and tini crash-loop on
   * `exec <toolsMount>/entrypoint.sh failed: No such file or directory` — a 201 whose container
   * never comes up, whose sessions close 4409 and whose cause is only visible in the raw
   * container logs (INT2-2).
   *
   * Refusing the create is the honest answer, and the fix is in the message. Only a probe
   * that is SURE refuses: an unreachable host, a volume nothing on the engine can read, or a
   * missing probe altogether answer 'unknown' and the create proceeds as before.
   */
  private async requireSyncedTools(scope: HostScope, probeImage?: string): Promise<void> {
    if ((await this.toolsState(scope, probeImage)) !== 'unsynced') return;
    throw AppError.conflict(this.toolsNotSyncedMessage(scope), {
      reason: 'tools_not_synced',
      hostId: scope.host.id,
      toolsVolume: scope.general.toolsVolume,
    });
  }

  /** `requireSyncedTools` for a container that already exists: a warning, never a refusal. */
  private async warnUnsyncedTools(scope: HostScope, cfg: ContainerConfig): Promise<void> {
    const probeImage = resolvedImageRefFor(cfg, scope.general);
    if ((await this.toolsState(scope, probeImage)) !== 'unsynced') return;
    this.addWarnings(cfg.name, [this.toolsNotSyncedMessage(scope)]);
  }

  /** 'unknown' whenever there is no probe, or the probe itself broke. */
  private async toolsState(
    scope: HostScope,
    probeImage?: string,
  ): Promise<'ready' | 'unsynced' | 'unknown'> {
    if (!this.tools) return 'unknown';
    try {
      return await this.tools.toolsReadiness(
        scope.host.id,
        probeImage ? { probeImage } : undefined,
      );
    } catch (err) {
      this.deps.log.debug({ err, host: scope.host.id }, 'the tools readiness probe failed');
      return 'unknown';
    }
  }

  private toolsNotSyncedMessage(scope: HostScope): string {
    return (
      `the tools volume '${scope.general.toolsVolume}' of host '${scope.host.id}' has not been ` +
      'synced yet, so a container on it cannot start (it would crash-loop on the ' +
      'missing bootstrap); run the tools sync for this host first ' +
      '(Settings -> Images -> Sync tools volume)'
    );
  }

  /** Everything that has to happen inside a freshly started container. */
  private async afterStart(scope: HostScope, cfg: ContainerConfig, containerId: string): Promise<void> {
    // A container that already existed is started without going through createContainerFor
    // (start/restart), so this is where an unsynced tools volume gets named — the execs below
    // cannot reach a crash-looping container and would otherwise fail silently.
    await this.warnUnsyncedTools(scope, cfg);
    const agents = this.tryResolveAgents(cfg);
    await this.ensureHomeWritable(scope, cfg, agents, containerId);
    await this.ensureAgentDirs(scope, cfg, agents, containerId);
    await this.applyProfileSettings(scope, cfg, containerId);
    await this.syncProfilePlugins(scope, cfg, containerId);
    await this.seedGitWorkspace(scope, cfg, containerId);
  }

  /**
   * v0.4 (#3): make the container's login-set volume carry the plugin FILES the profile's
   * refs name. Which of them are ON is already decided, exec-free, by the managed settings
   * `applyProfileSettings` just wrote — this is only the install side.
   *
   * Guarded hard: a container without a profileId, without a `claude` slice, or with an
   * empty `plugins` list sees ZERO execs. Best effort, like everything else in afterStart:
   * an offline host or a bad ref becomes a container warning and never fails a start.
   */
  private async syncProfilePlugins(
    scope: HostScope,
    cfg: ContainerConfig,
    containerId: string,
  ): Promise<void> {
    if (!cfg.profileId) return;
    const profile = this.resolveProfileForSpec(cfg.profileId);
    if (!profile) return; // applyProfileSettings already warned about the dangling id
    const agent = profile.agents[MANAGED_SETTINGS_AGENT_ID];
    if (!agent || agent.plugins.length === 0) return;
    const warnings = await syncProfilePlugins({
      backend: scope.backend,
      containerId,
      home: containerHomeFor(scope.general),
      user: cfg.user,
      agent,
      loginSet: loginSetFor(cfg.profileId, profile, MANAGED_SETTINGS_AGENT_ID),
      profileId: cfg.profileId,
      log: this.deps.log,
    });
    if (warnings.length) this.addWarnings(cfg.name, warnings);
  }

  /**
   * v0.4 (#2): write the container profile's managed settings into /etc/claude-code.
   *
   * Only containers that HAVE a profileId are touched at all — an unprofiled container
   * must be bit-for-bit the v0.3 container, so it gets zero execs here. A profiled
   * container always gets exactly one (root) exec: either the composed settings are
   * written, or a stale file is removed, which is what makes emptying/detaching a profile
   * actually take effect instead of leaving yesterday's API key behind.
   *
   * Best effort, like `seedGitWorkspace`: a failure becomes a container warning and never
   * fails a start.
   */
  private async applyProfileSettings(
    scope: HostScope,
    cfg: ContainerConfig,
    containerId: string,
  ): Promise<void> {
    const profile = this.resolveProfileForSpec(cfg.profileId);
    // A container that HAD a profile and lost it (detached by the user, or force-deleted with
    // the profile) must have the file REMOVED, not merely left alone: it holds the old API key
    // and base URL, and managed settings outrank everything the user can set, so skipping the
    // exec would keep routing that container's traffic through yesterday's provider forever.
    // `agent: null` makes applyManagedSettings take its removal branch.
    //
    // The only containers that see zero execs are those that never had a profile at all:
    // `porterclaude.profile` is absent from their labels AND from the stored config.
    // "Did this container ever have a profile?" is answered for free by its own
    // `porterclaude.profile` label — no probing exec, so a container that never had one
    // still costs zero execs here. (A RECREATE drops the file with the container layer
    // anyway; this covers the detached-but-not-yet-recreated container, which keeps running
    // with the old file until the user acts on its needsRecreate flag.)
    // Only the detach case needs the lookup: a container that still HAS a profile is going
    // to be written to anyway, so it never pays for the inspect.
    if (!cfg.profileId && !(await this.inspectedProfileLabel(scope, containerId))) return;
    if (cfg.profileId && !profile) {
      this.addWarnings(cfg.name, [`profile '${cfg.profileId}' no longer exists; its settings were cleared`]);
    }
    const warning = await applyManagedSettings({
      backend: scope.backend,
      containerId,
      home: containerHomeFor(scope.general),
      user: cfg.user,
      agent: profile?.agents[MANAGED_SETTINGS_AGENT_ID] ?? null,
      secrets: this.deps.secrets,
      log: this.deps.log,
    });
    if (warning) this.addWarnings(cfg.name, [warning]);
  }

  /**
   * The `porterclaude.profile` label of the RUNNING container, or null. Read from the
   * inspect the backend already serves — never an exec — so asking the question costs
   * nothing for the overwhelming majority of containers, which have no profile at all.
   */
  private async inspectedProfileLabel(scope: HostScope, containerId: string): Promise<string | null> {
    try {
      const inspect = await scope.backend.inspectContainer(containerId);
      const label = inspect?.labels?.[CONTAINER_LABELS.profile];
      return typeof label === 'string' && label.length > 0 ? label : null;
    } catch (err) {
      this.deps.log.debug({ err: (err as Error).message }, 'could not read the profile label of a container');
      return null;
    }
  }

  /**
   * Custom images that run as a NON-ROOT user (container `user` or an image `USER`) cannot
   * bootstrap themselves: docker creates the mountpoint parent <containerHome> in the
   * container layer as root:root 0755, so the tools entrypoint - which runs as that
   * unprivileged uid - can write neither <home>/.profile / .bashrc (no PATH persistence)
   * nor the agent symlinks into <home>/.porterclaude. The result is a container without a
   * usable agent.
   *
   * Nothing inside the container runs as root before the entrypoint, so the fix has to come
   * from outside: right after the start we exec `chown` as uid 0 (docker allows exec --user
   * even for containers running unprivileged) and then re-run the entrypoint's bootstrap
   * (`entrypoint.sh --porterclaude-bootstrap`, idempotent) as the container user, which now
   * succeeds. A root-owned agent directory (fresh volume seeded by an image that has none)
   * is handed to the container user as well - never touched when it already belongs to
   * somebody else (the recipes' uid 1000).
   *
   * Best effort throughout: a failure is logged, never fatal - PATH also comes from the
   * container env (buildContainerSpec) and from the session exec env.
   */
  private async ensureHomeWritable(
    scope: HostScope,
    cfg: ContainerConfig,
    agents: AgentDefinition[],
    containerId: string,
  ): Promise<void> {
    if (cfg.image.type !== 'custom') return; // recipe images own <home> already
    const { backend, general } = scope;

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
      // The agent volumes can only ever belong to ONE uid. This container may claim one while
      // it is still root-owned (docker just created it) or still EMPTY - the latter matters
      // since ensureAgentDirs hands a fresh root-owned volume to the recipes' uid 1000,
      // which would otherwise lock a uid-1500 image out of a volume that holds nothing yet.
      // A volume with content keeps its owner.
      `for d in ${[shQuote(agentDataRoot(home)), ...agents.map((a) => shQuote(agentDataDir(home, a.id)))].join(' ')}; do`,
      '  [ -d "$d" ] || continue',
      `  own=$(stat -c '%u' "$d" 2>/dev/null || echo 1);`,
      '  [ "$own" = "0" ] || [ -z "$(ls -A "$d" 2>/dev/null)" ] || continue;',
      `  chown -R ${shQuote(user)} "$d" 2>/dev/null || echo "chown $d failed" >&2;`,
      'done',
      // The root-only bits of the entrypoint (the agent wrappers, the /etc/profile.d
      // snippet): the re-bootstrap below runs as the SESSION user and can still not write
      // either of them. They are what makes the agents resolvable in a login shell whose
      // /etc/profile hard-sets PATH (alpine, debian) and in a `docker exec` that starts from
      // the standard PATH. Both are marker-guarded, so we never clobber a binary or a
      // profile snippet the image itself shipped.
      ...this.rootOnlyToolingScript(general, agents),
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
   * The pieces of the tools bootstrap that only uid 0 can install, which the (unprivileged)
   * entrypoint of a non-root custom image therefore always skips:
   *
   *   * `/etc/profile.d/porterclaude.sh` — sourced by every login shell AFTER
   *     `/etc/profile` has hard-set PATH (alpine and debian both do), so a `bash -l`
   *     session and the shells inside tmux panes find `<toolsMount>/bin` even when the
   *     rc files in `$HOME` are missing or unwritable;
   *   * `/usr/local/bin/<agent command>` — a wrapper on the standard PATH per mounted
   *     agent, so `claude` (or `opencode`, …) resolves in any exec, whatever PATH it
   *     starts from.
   *
   * Both are skipped when the path exists without our marker: an image that ships its own
   * agent binary or profile snippet keeps it. Pure string building, no I/O — the caller runs
   * this as part of its root exec.
   */
  private rootOnlyToolingScript(general: GeneralConfig, agents: AgentDefinition[]): string[] {
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
    const mine = '"porterclaude (generated)"';
    const lines = [
      'pcprof=/etc/profile.d/porterclaude.sh',
      `pcprofbody=${shQuote(profileBody)}`,
      `if mkdir -p /etc/profile.d 2>/dev/null && { [ ! -e "$pcprof" ] || grep -q ${mine} "$pcprof" 2>/dev/null; }; then`,
      '  printf \'%s\\n\' "$pcprofbody" > "$pcprof" 2>/dev/null && chmod 0644 "$pcprof" 2>/dev/null || echo "cannot write $pcprof" >&2',
      'fi',
    ];
    // one wrapper per agent command; the command is user-supplied config, so it is quoted
    const commands = [...new Set(agents.map((a) => a.command))].filter((c) => /^[A-Za-z0-9._-]+$/.test(c));
    for (const command of commands) {
      const wrapperBody = ['#!/bin/sh', GENERATED_MARKER, `exec "${toolsMountFor(general)}/bin/${command}" "$@"`].join('\n');
      lines.push(
        `pcwrap=${shQuote(`/usr/local/bin/${command}`)}`,
        `pcwrapbody=${shQuote(wrapperBody)}`,
        `if mkdir -p /usr/local/bin 2>/dev/null && { [ ! -e "$pcwrap" ] || grep -q ${mine} "$pcwrap" 2>/dev/null; }; then`,
        '  printf \'%s\\n\' "$pcwrapbody" > "$pcwrap" 2>/dev/null && chmod 0755 "$pcwrap" 2>/dev/null || echo "cannot write $pcwrap" >&2',
        'fi',
      );
    }
    return lines;
  }

  /**
   * The v0.2 replacement of v0.1's shared-volume repairs, run as uid 0 on every start
   * (docker allows exec --user even for containers running unprivileged):
   *
   *   * create `<home>/.porterclaude/agents` and every agent directory — docker creates the
   *     mountpoint parents as root:root, so an unprivileged container cannot write into them;
   *   * hand the agent volumes to the owner of `<home>` (the recipes' uid 1000 when that is
   *     still root, i.e. a freshly created, empty volume);
   *   * re-create the agent symlinks (`~/.claude -> <agentDir>/claude`, …). The tools
   *     entrypoint does the same from the inside, but a container created by an OLDER tools
   *     volume, or one whose HOME is not writable by its user, needs the outside repair;
   *   * create the history directory of every agent that declares one, so a shared-history
   *     container finds it and a private one has a well-owned mount point.
   *
   * Never fails a start: every step swallows its own error.
   */
  private async ensureAgentDirs(
    scope: HostScope,
    cfg: ContainerConfig,
    agents: AgentDefinition[],
    containerId: string,
  ): Promise<void> {
    const { backend, general } = scope;
    const home = containerHomeFor(general);
    const root = agentDataRoot(home);
    const user = (cfg.user ?? '').trim();

    const script = [
      'set -u',
      `h=${shQuote(home)}; r=${shQuote(root)}`,
      'mkdir -p "$r" 2>/dev/null || true',
      user ? `own=${shQuote(user)}` : 'own=',
      `case "\${own:-}" in '') own=$(stat -c '%u:%g' "$h" 2>/dev/null || echo);; esac`,
      `case "\${own:-}" in ''|0:*) own=${shQuote(SHARED_VOLUME_OWNER)};; esac`,
      'chown "$own" "$r" 2>/dev/null || true',
      ...agents.flatMap((agent) => {
        const dir = shQuote(agentDataDir(home, agent.id));
        const history = agentHistoryTarget(agent, home);
        const lines = [
          `mkdir -p ${dir} 2>/dev/null || true`,
          `chown -R "$own" ${dir} 2>/dev/null || echo "chown ${agent.id} failed" >&2`,
        ];
        for (const link of agentLinks(agent, home)) {
          const target = shQuote(link.target);
          const source = shQuote(link.source);
          // `{}` is an empty mapping in JSON *and* in YAML; anything else gets a 0-byte file
          const seed = /\.(json|ya?ml)$/i.test(link.source) ? '{}' : '';
          // An image may SHIP the agent's path (the v0.1 recipes create ~/.claude): that
          // real directory would shadow the auth volume and the login would silently live
          // in the container layer. It is replaced by the symlink - after its content is
          // copied into the still empty auth volume, so nothing is lost. Only paths BELOW
          // the container home are ever replaced (an agent definition is user-supplied
          // config; `~` or `/` must never turn into an `rm -rf`).
          const replaceable = link.target.startsWith(`${home}/`) && link.target.length > home.length + 1;
          lines.push(
            link.kind === 'dir'
              ? `mkdir -p ${source} 2>/dev/null || true`
              : `mkdir -p "$(dirname ${source})" 2>/dev/null || true`,
            `mkdir -p "$(dirname ${target})" 2>/dev/null || true`,
            `if [ -L ${target} ] || [ ! -e ${target} ]; then`,
            `  ln -sfn ${source} ${target} 2>/dev/null || echo "cannot link ${link.target}" >&2`,
            `  chown -h "$own" ${target} 2>/dev/null || true`,
            ...(replaceable
              ? [
                  `elif [ -d ${target} ]; then`,
                  `  if [ -z "$(ls -A ${source} 2>/dev/null)" ] && [ -n "$(ls -A ${target} 2>/dev/null)" ]; then`,
                  `    cp -a ${target}/. ${source}/ 2>/dev/null || true`,
                  '  fi',
                  `  rm -rf ${target} 2>/dev/null && ln -sfn ${source} ${target} 2>/dev/null &&`,
                  `    chown -h "$own" ${target} 2>/dev/null || echo "cannot replace ${link.target}" >&2`,
                  `elif [ -f ${target} ]; then`,
                  `  [ -e ${source} ] || cp -a ${target} ${source} 2>/dev/null || true`,
                  `  rm -f ${target} 2>/dev/null && ln -sfn ${source} ${target} 2>/dev/null &&`,
                  `    chown -h "$own" ${target} 2>/dev/null || echo "cannot replace ${link.target}" >&2`,
                ]
              : []),
            'fi',
            // A `kind:file` shared path is a symlink into the auth volume, so the SOURCE has
            // to exist before the link is ever used: aider's configargparse opens
            // ~/.aider.conf.yml on every start and dies with FileNotFoundError on a dangling
            // link (INT2-3). The entrypoint seeds it from the inside
            // (docker/tools/entrypoint.sh link_one), but on a FRESH auth volume it runs
            // before the chown above and cannot write - so the seed has to happen here, as
            // root, with exactly the same rules: `{}` (an empty mapping in JSON *and* YAML)
            // for .json/.yml/.yaml, an empty file otherwise, and a 0-byte structured file an
            // older build left behind is repaired the same way (QA OPS-2). It runs AFTER the
            // block above so a real file the image shipped is migrated, never overwritten.
            ...(link.kind === 'file'
              ? [
                  `if [ ! -e ${source} ]; then`,
                  seed
                    ? `  printf '%s\\n' ${shQuote(seed)} > ${source} 2>/dev/null || echo "cannot seed ${link.source}" >&2`
                    : `  : > ${source} 2>/dev/null || echo "cannot seed ${link.source}" >&2`,
                  ...(seed
                    ? [
                        `elif [ -f ${source} ] && [ ! -s ${source} ]; then`,
                        `  printf '%s\\n' ${shQuote(seed)} > ${source} 2>/dev/null || true`,
                      ]
                    : []),
                  'fi',
                ]
              : []),
            `chown -R "$own" ${source} 2>/dev/null || true`,
          );
        }
        if (history) {
          lines.push(
            `mkdir -p ${shQuote(history)} 2>/dev/null || true`,
            `chown "$own" ${shQuote(history)} 2>/dev/null || true`,
          );
        }
        // credentials must never be world readable
        lines.push(
          `find ${dir} -maxdepth 2 -name '.credentials.json' -exec chmod 0600 {} \\; 2>/dev/null || true`,
        );
        return lines;
      }),
      'exit 0',
    ].join('\n');

    try {
      await backend.runExec(containerId, ['sh', '-c', script], { user: '0', timeoutMs: 30_000 });
    } catch (err) {
      this.deps.log.debug({ err, containerId }, 'repairing the agent directories failed (ignored)');
    }
  }

  /** stop -> remove -> create -> start (used by update/recreate). */
  private async replaceContainer(cfg: ContainerConfig): Promise<ContainerView> {
    const scope = this.scope(cfg.hostId);

    // Before anything is torn down: a build/sync takes minutes, and destroying a working
    // container first would leave the container down for all of it. The stored definition is
    // updated right away so the edit is never lost, and the replace runs after the host is
    // ready (see prepare()).
    const steps = await this.preparationSteps(scope, cfg);
    if (steps.length) {
      await this.deps.config.putContainer(cfg);
      this.prepare(scope, cfg, steps, 'replace');
      return this.get(cfg.name);
    }

    await this.doReplace(scope, cfg);
    return this.get(cfg.name);
  }

  /** replaceContainer without the preparation check — the half that actually swaps the
   *  container, called again by runPreparation once the host is ready. */
  private async doReplace(scope: HostScope, cfg: ContainerConfig): Promise<void> {
    const { backend, general } = scope;
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

    const created = await this.createContainerFor(scope, cfg);
    cfg.specHash = created.specHash;
    await this.deps.config.putContainer(cfg);

    if (wasRunning || cfg.autoStart) {
      await backend.startContainer(created.id);
      await this.afterStart(scope, cfg, created.id);
    }
    if (created.warnings.length) this.addWarnings(cfg.name, created.warnings);
  }

  /** Resolve the image ref and read the PATH it declares (needed for the container PATH,
   *  see container.ts composeToolsPath) plus its Cmd (which the create request has to
   *  repeat verbatim, see container.ts imageCmd). */
  private async resolveImage(
    scope: HostScope,
    cfg: ContainerConfig,
  ): Promise<{ ref: string; imageEnvPath: string | null; imageCmd: string[] | null }> {
    const { backend, general } = scope;
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
      return { ref, imageEnvPath: envValue(inspect.env, 'PATH'), imageCmd: inspect.cmd ?? null };
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
    return { ref, imageEnvPath: envValue(inspect?.env, 'PATH'), imageCmd: inspect?.cmd ?? null };
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
    scope: HostScope,
    cfg: ContainerConfig,
    containerId: string,
  ): Promise<void> {
    if (cfg.workspace.type !== 'git') return;
    const target = scope.general.workspaceMount;
    const branch = cfg.workspace.branch ? ` --branch ${shQuote(cfg.workspace.branch)}` : '';
    const script =
      `set -e; if [ -z "$(ls -A ${shQuote(target)} 2>/dev/null)" ]; then ` +
      `git clone${branch} ${shQuote(cfg.workspace.url)} ${shQuote(target)}; fi`;
    try {
      const res = await scope.backend.runExec(containerId, ['sh', '-lc', script], { timeoutMs: 300_000 });
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
    // deduplicated: the same sentence twice carries no more information than once, and the
    // per-start warnings (an unsynced tools volume, a failed clone) would otherwise fill the
    // whole buffer with copies of themselves after ten restarts
    this.warnings.set(name, [...new Set([...current, ...warnings])].slice(-10));
  }

  private toView(
    cfg: ContainerConfig,
    container: ContainerSummary | null,
    inspect: ContainerInspect | null,
    general: GeneralConfig,
    opts: {
      hostName: string;
      hostMissing?: boolean;
      orphan?: boolean;
      images?: Map<string, ImageInspect>;
      /** warnings that belong to this render pass (dead host, missing host) */
      warnings?: string[];
    },
  ): ContainerView {
    const orphan = opts.orphan ?? false;
    const images = opts.images ?? new Map<string, ImageInspect>();
    const warnings = [...(this.warnings.get(cfg.name) ?? []), ...(opts.warnings ?? [])];
    const status: ContainerState | 'absent' = container ? container.state : 'absent';
    const startedAt = inspect?.startedAt ?? null;
    const running = container?.state === 'running';
    const uptimeSec =
      running && startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000)) : null;

    const resolvedImage = resolvedImageRefFor(cfg, general);
    // what the container SHOULD mount (drives the spec hash / needsRecreate below) ...
    const agents = this.tryResolveAgents(cfg);
    // ... and what its container really mounts, which is what the UI must offer as agent
    // panes: enabling an agent on the host does not retro-mount it into a running container
    // (that is exactly the needsRecreate case), and the session would refuse it with 4410.
    const mounted = container ? containerAgentIds(container.labels, inspect?.env) : null;
    const resolvedAgents = (mounted ?? agents.map((a) => a.id)).filter((id) =>
      Boolean(this.deps.agents.get(id)),
    );

    const runtimePorts: PortBinding[] = inspect?.ports ?? container?.ports ?? [];

    let needsRecreate = false;
    if (container && !orphan) {
      try {
        const spec = buildContainerSpec({
          container: cfg,
          general,
          agents,
          // v0.4: the SAME profile resolution as createContainerFor, otherwise the recomputed
          // hash of a profiled container never matches its label and it reports needsRecreate
          // forever. A dangling id keeps the volume stable (see loginSetFor).
          profile: this.profileSpecInput(cfg),
          resolvedImage,
          imageType: cfg.image.type,
          instanceId: this.deps.config.instanceId(),
          // recover the image PATH the container was created with, otherwise the recomputed
          // hash of a container would never match (container.ts composeToolsPath)
          imageEnvPath: imagePathFromEnv(inspect?.env, general),
          // ... and the Cmd it was created with, for the same reason (container.ts imageCmd)
          imageCmd: inspect?.cmd ?? null,
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
      } catch (err) {
        // A stored definition this build can no longer turn into a container (e.g. a
        // workspace hostPath that escapes workspacesRoot) must not break the whole list.
        needsRecreate = true;
        warnings.push(`this definition cannot be applied as it is: ${errMessage(err)}`);
      }
    }

    // The image the container actually runs vs. the one its ref points at TODAY. Docker
    // reports the plain id (`sha256:…`) for a container whose image lost its tag, which is
    // exactly what a rebuild does — hence the stable ref in resolvedImage and the flag
    // instead of a bare digest in the UI.
    const containerImage = container?.image ?? null;
    const containerImageId = inspect?.imageId ?? container?.imageId ?? null;
    const currentImageId = images.get(resolvedImage)?.id ?? null;
    const imageOutdated = Boolean(
      container && containerImageId && currentImageId && containerImageId !== currentImageId,
    );

    const preparing = this.preparations.get(cfg.name) ?? null;

    return {
      ...cfg,
      hostName: opts.hostName,
      hostMissing: opts.hostMissing ?? false,
      // a live object while the preparation runs: copied so a later phase change cannot
      // mutate a response that was already serialised
      preparing: preparing ? { ...preparing, jobs: [...preparing.jobs] } : null,
      resolvedAgents,
      status,
      containerId: container?.id ?? null,
      containerName: container?.name ?? containerNameFor(general.containerPrefix, cfg.name),
      resolvedImage,
      containerImage,
      imageOutdated,
      startedAt,
      uptimeSec,
      runtimePorts,
      needsRecreate,
      orphan,
      warnings,
    };
  }

  /**
   * Best-effort ContainerConfig for a managed container with no stored definition (adoption
   * after /data loss). Everything that survives in the container is reconstructed -
   * host, agents, env, published ports, extra mounts, cpu/memory limits, network, restart
   * policy and user - because the adopted definition is what a later Recreate/Edit rebuilds
   * from: dropping a port mapping or an env var here would silently break the container.
   *
   * `hostId` is the host whose backend listed the container; the porterclaude.host label
   * wins when it is present (a container created by v0.2).
   *
   * `image` is the ImageInspect of the container image when available; its env/user are
   * subtracted so that only what PorterClaude (or the user) added ends up in the config.
   */
  private synthesizeConfig(
    container: ContainerSummary,
    inspect: ContainerInspect | null,
    general: GeneralConfig,
    hostId: string,
    image?: ImageInspect | null,
  ): ContainerConfig {
    const prefix = general.containerPrefix;
    const name =
      containerLabelOf(container.labels) ??
      (container.name.startsWith(prefix) ? container.name.slice(prefix.length) : container.name);
    // docker merges the IMAGE labels into the container's, so a custom container whose ref
    // happens to be a recipe image reports porterclaude.recipe as well - our own
    // image-type label decides
    const imageType = container.labels[CONTAINER_LABELS.imageType];
    const recipe = imageType === 'custom' ? undefined : container.labels[CONTAINER_LABELS.recipe];
    const createdAt =
      container.labels[CONTAINER_LABELS.createdAt] ??
      new Date(container.createdAt * 1000).toISOString();

    const home = containerHomeFor(general);
    const raw = asRecord(inspect?.raw);
    const hostConfig = asRecord(raw?.HostConfig);

    const mounts = inspect?.mounts ?? [];
    const workspaceMount = mounts.find((m) => m.destination === general.workspaceMount);
    const workspace: ContainerConfig['workspace'] = workspaceMount
      ? workspaceMount.type === 'bind'
        ? { type: 'bind', hostPath: workspaceMount.source ?? general.workspaceMount }
        : { type: 'volume', volume: workspaceMount.name ?? workspaceVolumeFor(general.volumePrefix, name) }
      : { type: 'volume' };

    // v0.2 history volumes live inside the agent dir; v0.1 ones at ~/.claude/projects
    const historyPrefix = `${general.volumePrefix}hist-${name}`;
    const shareHistory = !mounts.some(
      (m) =>
        m.destination === historyMountTargetFor(general) ||
        m.name === historyPrefix ||
        Boolean(m.name?.startsWith(`${historyPrefix}-`)),
    );

    // every mount buildContainerSpec creates on its own; the rest belongs to the user
    const agentRoot = agentDataRoot(home);
    const managedTargets = new Set([
      general.workspaceMount,
      sharedClaudeTargetFor(general),
      `${home}/.claude-home`,
      historyMountTargetFor(general),
      toolsMountFor(general),
      general.toolsMount,
    ]);
    const extraMounts = mounts
      .filter(
        (mount) =>
          !managedTargets.has(mount.destination) &&
          mount.destination !== agentRoot &&
          !mount.destination.startsWith(`${agentRoot}/`),
      )
      .map((mount) => toMountConfig(mount))
      .filter((mount): mount is ContainerConfig['extraMounts'][number] => mount !== null);

    const agentsLabel = container.labels[CONTAINER_LABELS.agents];
    // v0.4: recover the profile so adopting a profiled container keeps its login-set volumes
    // on the next recreate; a label naming a deleted profile stays as-is (dangling ids render
    // a warning instead of silently re-sharing the private volume, see resolveProfileForSpec).
    //
    // FILTERED through the id rule, like `agentsLabel` below: the stored schema validates
    // `profileId` strictly, so a container carrying a hand-written or foreign
    // `porterclaude.profile=My Profile` would make putContainer throw a raw ZodError — the
    // container would be un-adoptable AND un-startable. An unusable label is simply dropped.
    const rawProfileLabel = container.labels[CONTAINER_LABELS.profile];
    const profileLabel =
      rawProfileLabel !== undefined && PROFILE_ID_RE.test(rawProfileLabel) ? rawProfileLabel : undefined;
    if (rawProfileLabel !== undefined && profileLabel === undefined) {
      this.deps.log.warn(
        { container: name, label: rawProfileLabel },
        'ignoring an unusable porterclaude.profile label while adopting a container',
      );
    }

    return {
      name,
      // the label wins so adoption is lossless, but only when this install actually has that
      // host; a v0.1 container (and a label naming an unknown host) falls back to the host
      // whose backend listed it
      hostId: this.hostIdForContainer(container, hostId),
      agents: agentsLabel === undefined ? null : agentsLabel.split(',').filter((id) => id.length > 0),
      profileId: profileLabel === undefined ? null : profileLabel,
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
  const managed = new Set([
    'PORTERCLAUDE_SESSION',
    'PORTERCLAUDE_HOST',
    'PORTERCLAUDE_TOOLS',
    'PORTERCLAUDE_HOME',
    'PORTERCLAUDE_AGENT_IDS',
    'PORTERCLAUDE_AGENT_LINKS',
  ]);
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
): ContainerConfig['ports'] {
  const bindings = asRecord(hostConfig?.PortBindings);
  if (!bindings) {
    return (inspect?.ports ?? []).map((p) => ({
      containerPort: p.containerPort,
      protocol: p.protocol,
      ...(p.hostPort === undefined ? {} : { hostPort: p.hostPort }),
      ...(p.hostIp === undefined || p.hostIp === '' ? {} : { hostIp: p.hostIp }),
    }));
  }
  const ports: ContainerConfig['ports'] = [];
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

/** HostConfig.NanoCpus / Memory -> ContainerConfig.limits. */
function synthesizeLimits(hostConfig: Record<string, unknown> | null): ContainerConfig['limits'] {
  const limits: ContainerConfig['limits'] = {};
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

/** MountInfo -> the container config mount shape (tmpfs has no source: skipped). */
function toMountConfig(m: MountInfo): ContainerConfig['extraMounts'][number] | null {
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
