// OWNER: B2. Pure translation SessionConfig -> CreateContainerSpec. No I/O, no docker
// calls: this file must stay unit-testable without a docker host.
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CreateContainerSpec, MountSpec, PortMapSpec } from '../backends/types.js';
import type { GeneralConfig } from '../config/schema.js';
import { AppError } from '../http/errors.js';
import type { SessionConfig } from './model.js';
import { CONTAINER_LABELS, historyVolumeFor, workspaceVolumeFor } from './model.js';
import type { AgentDefinition } from '../agents/model.js';
import {
  SESSION_AGENTS_ENV,
  SESSION_AGENT_LINKS_ENV,
  agentAuthVolumeFor,
  agentDataDir,
  agentHistoryTarget,
  agentLinks,
  encodeAgentLinks,
} from '../agents/model.js';

export interface BuildSpecInput {
  session: SessionConfig;
  /** the EFFECTIVE settings of the session's host (`hosts.settingsFor(session.hostId)`) */
  general: GeneralConfig;
  /**
   * The agents mounted into this container, already resolved
   * (`agents.resolveForSession(host, session)`). Order matters: it goes into the
   * `porterclaude.agents` label and the spec hash, so pass it sorted by id.
   */
  agents: AgentDefinition[];
  /** concrete image ref: recipes resolve to <imageNamespace>/<recipe>:latest */
  resolvedImage: string;
  /** custom images get the tools-volume bootstrap entrypoint */
  imageType: 'recipe' | 'custom';
  /**
   * The PATH the resolved image declares (`ImageInspect.env`), used to build the container
   * PATH of custom images. Optional: falls back to the docker default. Pass the value
   * recovered with imagePathFromEnv() when recomputing the spec of an existing container,
   * otherwise its hash would differ from the one it was created with.
   */
  imageEnvPath?: string | null;
  /**
   * The Cmd the resolved image declares (`ImageInspect.cmd`). It MUST be passed through
   * explicitly: the engine only inherits the image Cmd when the create request leaves the
   * Entrypoint unset (moby `merge()`), and v0.2 sets an Entrypoint on every session — so
   * without this a recipe container comes up with Cmd=null and the php recipe never starts
   * supervisord (measured by O1, docs/design/requests/v2-O1.md 1).
   * When recomputing the spec of an EXISTING container pass its own `ContainerInspect.cmd`
   * (what it was created with), otherwise its hash would differ — same rule as imageEnvPath.
   */
  imageCmd?: string[] | null;
}

/** pidsLimit applied to every managed container. */
export const SESSION_PIDS_LIMIT = 4096;

/** `general.containerHome` without a trailing slash (`/home/dev` by default). */
export function containerHomeFor(general: GeneralConfig): string {
  return general.containerHome.replace(/\/+$/, '') || '/home/dev';
}

/**
 * @deprecated v0.1 layout. In v0.2 the history lives INSIDE the claude agent's auth volume
 * (`agentHistoryTarget(def, home)`); this helper only survives for the one-time legacy
 * import and for reading old containers back during reconcile.
 */
export function historyMountTargetFor(general: GeneralConfig): string {
  return `${containerHomeFor(general)}/.claude/projects`;
}

/** @deprecated v0.1 layout, see historyMountTargetFor. */
export function sharedClaudeTargetFor(general: GeneralConfig): string {
  return `${containerHomeFor(general)}/.claude`;
}

/** `general.toolsMount` without a trailing slash (`/opt/porterclaude` by default). */
export function toolsMountFor(general: GeneralConfig): string {
  return general.toolsMount.replace(/\/+$/, '') || '/opt/porterclaude';
}

/** Directory of the claude binaries inside the (read-only) tools volume. */
export function toolsBinDir(general: GeneralConfig): string {
  return `${toolsMountFor(general)}/bin`;
}

/** PATH docker hands a container whose image declares none. */
export const DEFAULT_CONTAINER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * The entries prepended to PATH for custom images. They must come from config only (never
 * from the image) so that the value is reproducible without a docker round-trip.
 */
export function toolsPathPrefix(general: GeneralConfig): string[] {
  return [toolsBinDir(general), `${containerHomeFor(general)}/.local/bin`];
}

/**
 * `<toolsMount>/bin:<home>/.local/bin:<image PATH>` - the container-level PATH of a custom
 * image session. Every `docker exec` inherits the container env, so this is what makes
 * `claude` resolvable in a terminal even when the session user cannot write any rc file
 * (docker creates the mountpoint parent `<containerHome>` as root:root, so a non-root
 * image cannot persist PATH in `$HOME/.profile`; see backend.md section 7).
 */
export function composeToolsPath(general: GeneralConfig, imagePath?: string | null): string {
  const prefix = toolsPathPrefix(general);
  const rest = (imagePath && imagePath.trim() ? imagePath : DEFAULT_CONTAINER_PATH)
    .split(':')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !prefix.includes(p));
  return [...prefix, ...rest].join(':');
}

/**
 * Inverse of composeToolsPath: recover the image's own PATH from the env of a container we
 * created. Needed so that recomputing the spec hash of a running session (SessionView
 * .needsRecreate) yields the value the container was created with instead of flapping
 * whenever the image PATH is unknown.
 */
export function imagePathFromEnv(env: string[] | undefined, general: GeneralConfig): string | null {
  const entry = (env ?? []).find((e) => e.startsWith('PATH='));
  if (!entry) return null;
  const prefix = toolsPathPrefix(general);
  let parts = entry.slice('PATH='.length).split(':').filter((p) => p.length > 0);
  while (parts.length && prefix.includes(parts[0]!)) parts = parts.slice(1);
  return parts.length ? parts.join(':') : null;
}

/**
 * Contract (docs/design/backend.md v0.2 §7 "Container layout"):
 *   name        <containerPrefix><session>            e.g. pc-web
 *   labels      porterclaude.managed=true
 *               porterclaude.session=<slug>
 *               porterclaude.host=<hostId>                        (v0.2)
 *               porterclaude.agents=<id,id,...>                   (v0.2)
 *               porterclaude.image-type=recipe|custom
 *               porterclaude.recipe=<name>            (recipes only)
 *               porterclaude.spec-hash=<sha256>
 *               porterclaude.created-at=<iso>
 *   mounts      <volumePrefix>auth-<agentId> -> <home>/.porterclaude/agents/<agentId>
 *                                                              (one per resolved agent)
 *               <volumePrefix>hist-<slug>[-<agentId>]
 *                                           -> agentHistoryTarget(agent)  (shareHistory=false)
 *               workspace                   -> <workspaceMount>       (bind or volume)
 *               <toolsVolume> (ro)          -> <toolsMount>           (EVERY session in v0.2)
 *               ...extraMounts
 *   env         PORTERCLAUDE_SESSION=<slug>, PORTERCLAUDE_HOST=<hostId>, TERM=xterm-256color,
 *               PORTERCLAUDE_TOOLS=<toolsMount>, PORTERCLAUDE_HOME=<containerHome>,
 *               HOME=<containerHome>,
 *               PATH=<toolsMount>/bin:<containerHome>/.local/bin:<image PATH>,
 *               PORTERCLAUDE_AGENT_IDS=<id,id>, PORTERCLAUDE_AGENT_LINKS=<target|source|kind;...>,
 *               <agent.env>..., ...session.env
 *   entrypoint  ["<toolsMount>/entrypoint.sh"]        for EVERY session (v0.2)
 *   cmd         ["sleep","infinity"] for custom images; recipes get the image's OWN CMD
 *               passed back explicitly, so the php recipe still starts supervisord behind
 *               the bootstrap (and ["sleep","infinity"] when the image declares none)
 *   workingDir  <workspaceMount>;  init true;  tty false;  pidsLimit 4096
 *   restart     autoStart ? 'unless-stopped' : 'no'
 *   resources   cpus -> NanoCpus, memoryMb -> Memory
 *
 * WHY the uniform bootstrap: v0.1 baked claude into the recipe images and mounted the tools
 * volume only into custom ones. With N agents that would mean rebuilding every recipe for
 * every agent, so v0.2 delivers ALL agents through the tools volume and wires PATH/HOME the
 * same way everywhere. Recipes still run their CMD because the create request repeats it
 * verbatim: the engine DROPS the image Cmd as soon as the request sets an Entrypoint (moby
 * `merge()` only inherits Cmd when the user config has no Entrypoint), so a recipe created
 * without it would reach entrypoint.sh with no argv and idle instead of serving.
 *
 * WHY symlinks instead of direct mounts of ~/.claude & co: see agents/model.ts. The
 * private-history volume therefore mounts at `agentHistoryTarget(...)` (a path inside the
 * agent volume), never at `~/.claude/projects` (a symlink) — docker resolves mount targets
 * before the bootstrap runs.
 *
 * The ownership/symlink repairs that make this layout work inside a running container live
 * in sessions/service.ts (`ensureAgentDirs`, run as uid 0 after every start).
 */
export function buildContainerSpec(input: BuildSpecInput): CreateContainerSpec {
  const { session, general, resolvedImage, imageType, agents } = input;
  const home = containerHomeFor(general);
  const toolsMount = toolsMountFor(general);

  const mounts: MountSpec[] = [];

  // One auth volume per agent, mounted at the agent dir. Its private-history overlay (when
  // the session does not share history) is nested INSIDE that mount on purpose.
  for (const agent of agents) {
    mounts.push({
      type: 'volume',
      source: agentAuthVolumeFor(general.volumePrefix, agent.id),
      target: agentDataDir(home, agent.id),
      readOnly: false,
    });
    if (!session.shareHistory) {
      const historyTarget = agentHistoryTarget(agent, home);
      if (historyTarget) {
        mounts.push({
          type: 'volume',
          source: historyVolumeFor(general.volumePrefix, session.name, agent.id),
          target: historyTarget,
          readOnly: false,
        });
      }
    }
  }

  mounts.push(workspaceMountFor(session, general));

  // v0.2: the tools volume is mounted into EVERY session (it carries the agents now).
  mounts.push({ type: 'volume', source: general.toolsVolume, target: toolsMount, readOnly: true });

  for (const m of session.extraMounts) {
    mounts.push({ type: m.type, source: m.source, target: m.target, readOnly: m.readOnly });
  }

  const links = agents.flatMap((agent) => agentLinks(agent, home));

  const env: Record<string, string> = {
    PORTERCLAUDE_SESSION: session.name,
    PORTERCLAUDE_HOST: session.hostId,
    TERM: 'xterm-256color',
    PORTERCLAUDE_TOOLS: toolsMount,
    PORTERCLAUDE_HOME: home,
    // Pin PATH: `docker exec` inherits the CONTAINER env, not whatever the entrypoint
    // exported, and a non-root image cannot persist PATH in an rc file (docker creates
    // <containerHome> as root:root). Without this a terminal cannot find the agents.
    PATH: composeToolsPath(general, input.imageEnvPath),
    // Pin HOME: docker would otherwise use the image's HOME (/root for root images) and the
    // agents would write their credentials outside the shared auth volumes.
    HOME: home,
    [SESSION_AGENTS_ENV]: agents.map((a) => a.id).join(','),
    [SESSION_AGENT_LINKS_ENV]: encodeAgentLinks(links),
  };
  // agent-declared env first, the user's own env always wins
  for (const agent of agents) for (const [k, v] of Object.entries(agent.env)) env[k] = v;
  for (const [k, v] of Object.entries(session.env)) env[k] = v;

  const labels: Record<string, string> = {
    [CONTAINER_LABELS.managed]: 'true',
    [CONTAINER_LABELS.session]: session.name,
    [CONTAINER_LABELS.host]: session.hostId,
    [CONTAINER_LABELS.agents]: agents.map((a) => a.id).join(','),
    [CONTAINER_LABELS.imageType]: imageType,
    [CONTAINER_LABELS.createdAt]: session.createdAt,
  };
  if (session.image.type === 'recipe') labels[CONTAINER_LABELS.recipe] = session.image.recipe;

  const ports: PortMapSpec[] = session.ports.map((p) => ({
    containerPort: p.containerPort,
    ...(p.hostPort === undefined ? {} : { hostPort: p.hostPort }),
    protocol: p.protocol,
    ...(p.hostIp === undefined ? {} : { hostIp: p.hostIp }),
  }));

  const network = session.network ?? general.sessionNetwork;

  const spec: CreateContainerSpec = {
    name: containerName(general, session),
    image: resolvedImage,
    env,
    labels,
    workingDir: general.workspaceMount,
    hostname: session.name,
    tty: false,
    openStdin: false,
    init: true,
    mounts,
    ports,
    restartPolicy: session.autoStart ? 'unless-stopped' : 'no',
    resources: {
      ...(session.limits.cpus === undefined ? {} : { cpus: session.limits.cpus }),
      ...(session.limits.memoryMb === undefined ? {} : { memoryMb: session.limits.memoryMb }),
      pidsLimit: SESSION_PIDS_LIMIT,
    },
    entrypoint: [`${toolsMount}/entrypoint.sh`],
    ...(session.user ? { user: session.user } : {}),
    ...(network ? { networks: [network] } : {}),
  };

  // Custom images idle; recipes repeat their own CMD (php runs supervisord). The image Cmd
  // must be restated because the entrypoint override above makes the engine drop it.
  const imageCmd = input.imageCmd ?? null;
  spec.cmd =
    imageType === 'custom' || !imageCmd?.length ? ['sleep', 'infinity'] : [...imageCmd];

  // The hash covers everything above; adding it as a label must not change it (labels are
  // excluded from the hash on purpose).
  spec.labels = { ...labels, [CONTAINER_LABELS.specHash]: specHash(spec) };
  return spec;
}

function containerName(general: GeneralConfig, session: SessionConfig): string {
  return `${general.containerPrefix}${session.name}`;
}

/** `/a/b/` -> `/a/b`, `//` -> `/`. */
function normaliseDir(p: string): string {
  const normalised = path.posix.normalize(p).replace(/\/+$/, '');
  return normalised.length ? normalised : '/';
}

/**
 * Resolve a bind workspace `hostPath` to the absolute path that is handed to the engine.
 *
 * An absolute path is taken as given (the single, admin user may bind anything on the
 * host); a RELATIVE one is resolved under `general.workspacesRoot` and must stay there.
 * `path.posix.join` alone does not confine it — `join('/srv/ws', '../../../etc')` is
 * `/etc` — so the result is normalised and checked against the root. The API schema
 * already rejects `.`/`..` segments (model.ts WorkspaceHostPathSchema); this is the
 * defence in depth that also covers configs stored before that rule existed, adopted
 * containers and any future caller.
 *
 * @throws AppError.badRequest when a relative path escapes `workspacesRoot`.
 */
export function resolveWorkspaceHostPath(hostPath: string, workspacesRoot: string): string {
  if (/[\0\\]/.test(hostPath)) {
    throw AppError.badRequest('workspace hostPath must not contain a backslash or a NUL byte');
  }
  if (path.posix.isAbsolute(hostPath)) return normaliseDir(hostPath);
  const root = normaliseDir(workspacesRoot);
  const resolved = normaliseDir(path.posix.join(root, hostPath));
  if (resolved !== root && !resolved.startsWith(root === '/' ? '/' : `${root}/`)) {
    throw AppError.badRequest(
      `workspace hostPath '${hostPath}' escapes the workspaces root ${root} ` +
        '(relative paths must stay under it; pass an absolute path to bind anything else)',
    );
  }
  return resolved;
}

/** The workspace mount for a session (creating the volume is the service's job). */
export function workspaceMountFor(session: SessionConfig, general: GeneralConfig): MountSpec {
  const target = general.workspaceMount;
  const ws = session.workspace;
  if (ws.type === 'bind') {
    return {
      type: 'bind',
      source: resolveWorkspaceHostPath(ws.hostPath, general.workspacesRoot),
      target,
      readOnly: false,
    };
  }
  const volume = ws.volume ?? workspaceVolumeFor(general.volumePrefix, session.name);
  return { type: 'volume', source: volume, target, readOnly: false };
}

/**
 * Stable sha256 over the fields that require a container recreate (image, mounts, env,
 * ports, limits, user, network, shareHistory). Stored in the porterclaude.spec-hash label;
 * SessionView.needsRecreate compares the stored config's hash with the container's label.
 *
 * Labels are deliberately NOT part of the hash: they carry the hash itself plus the
 * creation timestamp, neither of which should trigger a recreate.
 */
export function specHash(spec: CreateContainerSpec): string {
  const relevant = {
    name: spec.name,
    image: spec.image,
    cmd: spec.cmd ?? null,
    entrypoint: spec.entrypoint ?? null,
    env: spec.env ?? {},
    workingDir: spec.workingDir ?? null,
    user: spec.user ?? null,
    hostname: spec.hostname ?? null,
    init: spec.init ?? false,
    mounts: [...(spec.mounts ?? [])]
      .map((m) => ({ type: m.type, source: m.source, target: m.target, readOnly: m.readOnly ?? false }))
      .sort((a, b) => `${a.target}\u0000${a.source}`.localeCompare(`${b.target}\u0000${b.source}`)),
    ports: [...(spec.ports ?? [])]
      .map((p) => ({
        containerPort: p.containerPort,
        hostPort: p.hostPort ?? null,
        protocol: p.protocol ?? 'tcp',
        hostIp: p.hostIp ?? null,
      }))
      .sort((a, b) => a.containerPort - b.containerPort || a.protocol.localeCompare(b.protocol)),
    restartPolicy: spec.restartPolicy ?? 'no',
    resources: {
      cpus: spec.resources?.cpus ?? null,
      memoryMb: spec.resources?.memoryMb ?? null,
      pidsLimit: spec.resources?.pidsLimit ?? null,
    },
    networks: [...(spec.networks ?? [])].sort(),
    capAdd: [...(spec.capAdd ?? [])].sort(),
  };
  return createHash('sha256').update(stableStringify(relevant)).digest('hex');
}

/** JSON with recursively sorted object keys and dropped `undefined` values. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      if (src[key] === undefined) continue;
      out[key] = normalise(src[key]);
    }
    return out;
  }
  return value === undefined ? null : value;
}
