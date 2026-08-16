// OWNER: B2. Pure translation SessionConfig -> CreateContainerSpec. No I/O, no docker
// calls: this file must stay unit-testable without a docker host.
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CreateContainerSpec, MountSpec, PortMapSpec } from '../backends/types.js';
import type { GeneralConfig } from '../config/schema.js';
import { AppError } from '../http/errors.js';
import type { SessionConfig } from './model.js';
import { CONTAINER_LABELS, historyVolumeFor, workspaceVolumeFor } from './model.js';

export interface BuildSpecInput {
  session: SessionConfig;
  general: GeneralConfig;
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
}

/** pidsLimit applied to every managed container. */
export const SESSION_PIDS_LIMIT = 4096;

/** `general.containerHome` without a trailing slash (`/home/dev` by default). */
export function containerHomeFor(general: GeneralConfig): string {
  return general.containerHome.replace(/\/+$/, '') || '/home/dev';
}

/** Absolute path of the conversation-history directory inside a session container. */
export function historyMountTargetFor(general: GeneralConfig): string {
  return `${containerHomeFor(general)}/.claude/projects`;
}

/** Absolute path of the shared claude volume inside a session container. */
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
 * Contract (docs/design/backend.md "Container layout"):
 *   name        <containerPrefix><session>            e.g. pc-web
 *   labels      porterclaude.managed=true
 *               porterclaude.session=<slug>
 *               porterclaude.image-type=recipe|custom
 *               porterclaude.recipe=<name>            (recipes only)
 *               porterclaude.spec-hash=<sha256>
 *               porterclaude.created-at=<iso>
 *   mounts      <sharedClaudeVolume>      -> <containerHome>/.claude
 *               <sharedClaudeHomeVolume>  -> <containerHome>/.claude-home
 *               workspace                 -> <workspaceMount>            (bind or volume)
 *               <toolsVolume> (ro)        -> <toolsMount>                (custom images only)
 *               porterclaude-hist-<slug>  -> <containerHome>/.claude/projects  (shareHistory=false)
 *               ...extraMounts
 *   env         PORTERCLAUDE_SESSION=<slug>, TERM=xterm-256color, ...session.env
 *               custom images additionally: PORTERCLAUDE_TOOLS=<toolsMount>,
 *               PORTERCLAUDE_HOME=<containerHome>, HOME=<containerHome>,
 *               PATH=<toolsMount>/bin:<containerHome>/.local/bin:<image PATH>
 *   custom      entrypoint ["<toolsMount>/entrypoint.sh"], cmd ["sleep","infinity"]
 *   recipes     entrypoint/cmd left to the image
 *   workingDir  <workspaceMount>;  init true;  tty false;  pidsLimit 4096
 *   restart     autoStart ? 'unless-stopped' : 'no'
 *   resources   cpus -> NanoCpus, memoryMb -> Memory
 *
 * The private-history mount overlays a directory *inside* the shared claude volume, so the
 * mountpoint must already exist with the shared volume's ownership when the container
 * starts - otherwise docker creates it as root:root and ~/.claude/projects becomes
 * unwritable for THIS session and for every other (shared) session too.
 * SessionService.prepareHistoryVolume() pre-creates it (backend.md section 7); this file
 * only declares the mount.
 *
 * HOME is pinned for custom images because docker otherwise inherits HOME from the image
 * (usually /root for the root images people pick), which would make claude write its
 * credentials and history outside the shared volumes -> "log in once, every session
 * authenticated" would not hold.
 */
export function buildContainerSpec(input: BuildSpecInput): CreateContainerSpec {
  const { session, general, resolvedImage, imageType } = input;
  const home = containerHomeFor(general);

  const mounts: MountSpec[] = [
    { type: 'volume', source: general.sharedClaudeVolume, target: `${home}/.claude`, readOnly: false },
    { type: 'volume', source: general.sharedClaudeHomeVolume, target: `${home}/.claude-home`, readOnly: false },
  ];

  // Private conversation history: must be mounted *after* the shared .claude volume.
  if (!session.shareHistory) {
    mounts.push({
      type: 'volume',
      source: historyVolumeFor(session.name),
      target: historyMountTargetFor(general),
      readOnly: false,
    });
  }

  mounts.push(workspaceMountFor(session, general));

  if (imageType === 'custom') {
    mounts.push({ type: 'volume', source: general.toolsVolume, target: general.toolsMount, readOnly: true });
  }

  for (const m of session.extraMounts) {
    mounts.push({ type: m.type, source: m.source, target: m.target, readOnly: m.readOnly });
  }

  const env: Record<string, string> = {
    PORTERCLAUDE_SESSION: session.name,
    TERM: 'xterm-256color',
  };
  if (imageType === 'custom') {
    env.PORTERCLAUDE_TOOLS = general.toolsMount;
    env.PORTERCLAUDE_HOME = home;
    // Pin PATH: `docker exec` inherits the CONTAINER env, not whatever the entrypoint
    // exported, and a non-root custom image cannot persist PATH in an rc file (docker
    // creates <containerHome> as root:root). Without this a terminal cannot find claude.
    env.PATH = composeToolsPath(general, input.imageEnvPath);
    // Pin HOME: docker would otherwise use the image's HOME (/root for root images) and
    // claude would write credentials/history outside the shared volumes.
    env.HOME = home;
  }
  for (const [k, v] of Object.entries(session.env)) env[k] = v;

  const labels: Record<string, string> = {
    [CONTAINER_LABELS.managed]: 'true',
    [CONTAINER_LABELS.session]: session.name,
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
    ...(session.user ? { user: session.user } : {}),
    ...(network ? { networks: [network] } : {}),
  };

  if (imageType === 'custom') {
    spec.entrypoint = [`${general.toolsMount.replace(/\/+$/, '')}/entrypoint.sh`];
    spec.cmd = ['sleep', 'infinity'];
  }

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
  const volume = ws.volume ?? workspaceVolumeFor(session.name);
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
