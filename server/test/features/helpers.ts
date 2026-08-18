// OWNER: B2. Test doubles shared by the feature tests. No docker host, no B1 runtime code.
import { Readable } from 'node:stream';
import pino from 'pino';
import type { ServiceDeps } from '../../src/context.js';
import { AppError } from '../../src/http/errors.js';
import type { ConfigStore } from '../../src/config/store.js';
import type { GeneralConfig } from '../../src/config/schema.js';
import { GeneralConfigSchema } from '../../src/config/schema.js';
import type { HostManager } from '../../src/hosts/manager.js';
import type { AgentRegistry } from '../../src/agents/registry.js';
import type { HostConfig } from '../../src/hosts/model.js';
import type { AgentDefinition } from '../../src/agents/model.js';
import { BUILTIN_AGENTS } from '../../src/agents/builtin.js';
import type {
  ContainerInspect,
  ContainerSummary,
  DockerBackend,
  ExecResult,
  ExecStream,
  ImageInspect,
  ImageSummary,
  VolumeSummary,
} from '../../src/backends/types.js';
import type { Paths } from '../../src/paths.js';
import type { ContainerConfig, ContainerInput } from '../../src/containers/model.js';
import { ContainerInputSchema, LEGACY_CONTAINER_LABEL } from '../../src/containers/model.js';

export const silentLog = pino({ level: 'silent' });

export function generalConfig(overrides: Partial<GeneralConfig> = {}): GeneralConfig {
  return { ...GeneralConfigSchema.parse({}), ...overrides };
}

export function testPaths(overrides: Partial<Paths> = {}): Paths {
  return {
    repoRoot: '/repo',
    serverRoot: '/repo/server',
    nodeModules: '/repo/node_modules',
    webPublic: '/repo/web/public',
    dockerDir: '/repo/docker',
    recipesDir: '/repo/docker/recipes',
    toolsDir: '/repo/docker/tools',
    dataDir: '/repo/data',
    configFile: '/repo/data/config.json',
    secretFile: '/repo/data/secret.key',
    ...overrides,
  };
}

export const TEST_HOST_ID = 'default';

/** `config.instanceId()` of the stub store — the porterclaude.instance label of the tests. */
export const TEST_INSTANCE_ID = 'pc-test';

export function containerInput(overrides: Partial<ContainerInput> = {}): ContainerInput {
  return ContainerInputSchema.parse({
    name: 'web',
    hostId: TEST_HOST_ID,
    image: { type: 'recipe', recipe: 'node' },
    ...overrides,
  });
}

export function hostConfig(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    id: TEST_HOST_ID,
    name: 'Local docker',
    connection: { type: 'socket', socketPath: '/var/run/docker.sock' },
    overrides: {},
    agents: { enabled: ['claude'] },
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function containerConfig(overrides: Partial<ContainerConfig> = {}): ContainerConfig {
  const { createdAt, updatedAt, specHash, hostId, ...rest } = overrides;
  return {
    ...containerInput(rest),
    hostId: hostId ?? TEST_HOST_ID,
    createdAt: createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: updatedAt ?? '2026-01-01T00:00:00.000Z',
    ...(specHash ? { specHash } : {}),
  };
}

// ---------------------------------------------------------------------------
// stub config store
// ---------------------------------------------------------------------------

export interface StubConfigStore {
  store: ConfigStore;
  containers: Map<string, ContainerConfig>;
  general: GeneralConfig;
}

export function stubConfigStore(
  containers: ContainerConfig[] = [],
  general: GeneralConfig = generalConfig(),
): StubConfigStore {
  const map = new Map(containers.map((c) => [c.name, c]));
  const store = {
    general: () => general,
    instanceId: () => TEST_INSTANCE_ID,
    listContainers: () => [...map.values()],
    getContainer: (name: string) => map.get(name) ?? null,
    putContainer: async (cfg: ContainerConfig) => {
      map.set(cfg.name, cfg);
      return cfg;
    },
    deleteContainer: async (name: string) => map.delete(name),
  } as unknown as ConfigStore;
  return { store, containers: map, general };
}

/** `hostConfig()` with another id/name (the second host of the multi-host tests). */
export function otherHostConfig(overrides: Partial<HostConfig> = {}): HostConfig {
  return hostConfig({ id: 'edge', name: 'Edge box', ...overrides });
}

// ---------------------------------------------------------------------------
// stub docker backend
// ---------------------------------------------------------------------------

export interface StubBackend {
  backend: DockerBackend;
  /** ordered method names, e.g. ['createVolume','createContainer','startContainer'] */
  calls: string[];
  /** full call log with arguments */
  log: Array<{ method: string; args: unknown[] }>;
  containers: ContainerSummary[];
  images: Map<string, ImageInspect>;
  volumes: VolumeSummary[];
}

export function containerSummary(overrides: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: 'c1',
    name: 'pc-web',
    names: ['pc-web'],
    image: 'porterclaude/node:latest',
    imageId: 'sha256:img',
    state: 'running',
    status: 'Up 2 minutes',
    createdAt: Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000),
    labels: {
      'porterclaude.managed': 'true',
      'porterclaude.container': 'web',
      'porterclaude.image-type': 'recipe',
      'porterclaude.recipe': 'node',
    },
    ports: [],
    ...overrides,
  };
}

/**
 * A container created BEFORE v0.3: it carries only the legacy `porterclaude.session` label.
 *
 * Its docker name deliberately does NOT match `<containerPrefix><name>`, so `matchContainer`'s
 * second fallback (match by derived name) cannot mask a missing compatibility read — without
 * `containerLabelOf`'s `?? LEGACY_CONTAINER_LABEL` this container is invisible.
 *
 * It carries `porterclaude.instance` because that is the shape a v0.2.1/v0.2.2 container really
 * has, and `ownedByThisInstance` takes a DIFFERENT branch for a container with no instance label
 * at all (a v0.1/v0.2.0 one). Pass `{ labels: … }` to model that older shape instead.
 */
export function legacyContainerSummary(
  name: string,
  overrides: Partial<ContainerSummary> = {},
): ContainerSummary {
  return containerSummary({
    id: `c-legacy-${name}`,
    // NOT `pc-${name}`: the derived-name fallback must not be able to find this one
    name: `renamed-${name}`,
    names: [`renamed-${name}`],
    labels: {
      'porterclaude.managed': 'true',
      [LEGACY_CONTAINER_LABEL]: name,
      'porterclaude.instance': TEST_INSTANCE_ID,
      'porterclaude.image-type': 'recipe',
      'porterclaude.recipe': 'node',
    },
    ...overrides,
  });
}

export function imageInspect(overrides: Partial<ImageInspect> = {}): ImageInspect {
  return {
    id: 'sha256:img',
    tags: ['porterclaude/node:latest'],
    createdAt: '2026-01-01T00:00:00.000Z',
    sizeBytes: 100,
    labels: {},
    env: [],
    raw: {},
    ...overrides,
  };
}

export function stubBackend(overrides: Partial<DockerBackend> = {}): StubBackend {
  const calls: string[] = [];
  const log: Array<{ method: string; args: unknown[] }> = [];
  const state: Omit<StubBackend, 'backend' | 'calls' | 'log'> = {
    containers: [],
    images: new Map<string, ImageInspect>(),
    volumes: [],
  };

  const record = <T>(method: string, args: unknown[], value: T): T => {
    calls.push(method);
    log.push({ method, args });
    return value;
  };

  const base: DockerBackend = {
    kind: 'socket',
    id: 'stub',
    ping: async () => record('ping', [], undefined),
    info: async () =>
      record('info', [], {
        name: 'stub',
        serverVersion: '1',
        os: 'linux',
        architecture: 'x86_64',
        ncpu: 1,
        memTotalBytes: 1,
        containers: 0,
        containersRunning: 0,
        images: 0,
      }),
    listContainers: async (opts) => record('listContainers', [opts], state.containers),
    inspectContainer: async (id) =>
      record('inspectContainer', [id], {
        id,
        name: 'pc-web',
        image: 'porterclaude/node:latest',
        imageId: 'sha256:img',
        state: 'running',
        running: true,
        startedAt: new Date().toISOString(),
        labels: {},
        env: [],
        mounts: [],
        ports: [],
        raw: {},
      } satisfies ContainerInspect),
    createContainer: async (spec) => record('createContainer', [spec], { id: 'new-container', warnings: [] }),
    startContainer: async (id) => record('startContainer', [id], undefined),
    stopContainer: async (id, opts) => record('stopContainer', [id, opts], undefined),
    restartContainer: async (id, opts) => record('restartContainer', [id, opts], undefined),
    removeContainer: async (id, opts) => record('removeContainer', [id, opts], undefined),
    waitContainer: async (id) => record('waitContainer', [id], { statusCode: 0 }),
    containerLogs: async (id, opts) => record('containerLogs', [id, opts], 'log output'),
    execCreate: async (spec) => record('execCreate', [spec], { execId: 'exec-1' }),
    execStart: async (execId, opts) => record('execStart', [execId, opts], stubExecStream(execId)),
    execResize: async (execId, size) => record('execResize', [execId, size], undefined),
    execInspect: async (execId) => record('execInspect', [execId], { running: true, exitCode: null, pid: 1 }),
    runExec: async (containerId, cmd, opts) =>
      record('runExec', [containerId, cmd, opts], { exitCode: 0, stdout: '', stderr: '' } satisfies ExecResult),
    getArchive: async (id, path) => record('getArchive', [id, path], Readable.from([])),
    putArchive: async (id, path, tar, opts) => record('putArchive', [id, path, tar, opts], undefined),
    listImages: async () =>
      record(
        'listImages',
        [],
        [...state.images.entries()].map(
          ([ref, img]): ImageSummary => ({
            id: img.id,
            tags: [ref],
            createdAt: 0,
            sizeBytes: img.sizeBytes,
            labels: img.labels,
          }),
        ),
      ),
    inspectImage: async (ref) => record('inspectImage', [ref], state.images.get(ref) ?? null),
    pullImage: async (ref, opts) => record('pullImage', [ref, opts], undefined),
    removeImage: async (ref, opts) => record('removeImage', [ref, opts], undefined),
    buildImage: async (opts) => record('buildImage', [opts], undefined),
    listVolumes: async () => record('listVolumes', [], state.volumes),
    createVolume: async (spec) =>
      record('createVolume', [spec], { name: spec.name, driver: 'local', labels: spec.labels ?? {} }),
    removeVolume: async (name, opts) => record('removeVolume', [name, opts], undefined),
    listNetworks: async () => record('listNetworks', [], []),
    close: async () => record('close', [], undefined),
  };

  return { backend: { ...base, ...overrides }, calls, log, ...state };
}

export function stubExecStream(execId = 'exec-1'): ExecStream {
  let onData: ((chunk: Uint8Array, stream: 'stdout' | 'stderr') => void) | null = null;
  let onClose: ((info: { code?: number; reason?: string }) => void) | null = null;
  let onError: ((err: Error) => void) | null = null;
  const written: string[] = [];
  const stream = {
    execId,
    written,
    write: (data: Uint8Array | string) => {
      written.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    },
    onData: (cb: (chunk: Uint8Array, s: 'stdout' | 'stderr') => void) => {
      onData = cb;
    },
    onClose: (cb: (info: { code?: number; reason?: string }) => void) => {
      onClose = cb;
    },
    onError: (cb: (err: Error) => void) => {
      onError = cb;
    },
    resize: async () => undefined,
    close: () => {
      stream.closed = true;
    },
    closed: false,
    // test helpers
    emitData: (text: string) => onData?.(new TextEncoder().encode(text), 'stdout'),
    emitClose: (code = 0) => onClose?.({ code }),
    emitError: (err: Error) => onError?.(err),
  };
  return stream as unknown as ExecStream;
}

/** A host entry of the multi-host stub: its config, its transport and its settings. */
export interface StubHostEntry {
  host: HostConfig;
  /** null = the host has no usable transport (missing credential, dead engine, tcp/ssh) */
  backend: DockerBackend | null;
  general?: GeneralConfig;
}

/**
 * A HostManager stub over N hosts. `backendFor` throws for a host without a transport (like
 * the real manager does for an incomplete connection), `tryBackendFor` answers null, and
 * `hostForContainer` throws for a container whose host was deleted — which is exactly what the
 * multi-host paths of ContainerService and SessionService have to survive.
 */
export function stubHosts(entries: StubHostEntry[], defaultHostId?: string): HostManager {
  const byId = new Map(entries.map((e) => [e.host.id, e]));
  const entryFor = (id: string): StubHostEntry => {
    const entry = byId.get(id);
    if (!entry) throw AppError.notFound(`host '${id}' does not exist`);
    return entry;
  };
  const backendOf = (id: string): DockerBackend => {
    const entry = entryFor(id);
    if (!entry.backend) throw AppError.backendNotConfigured(`host '${id}' has no docker backend configured`);
    return entry.backend;
  };
  const settingsOf = (id: string): GeneralConfig => entryFor(id).general ?? generalConfig();
  const fallbackId = defaultHostId ?? entries[0]?.host.id ?? null;

  return {
    list: () => entries.map((e) => e.host),
    get: (id: string) => byId.get(id)?.host ?? null,
    require: (id: string) => entryFor(id).host,
    defaultHostId: () => fallbackId,
    requireHostId: (id?: string | null) => {
      if (id) return entryFor(id).host.id;
      if (!fallbackId) throw AppError.backendNotConfigured('no docker host configured');
      return fallbackId;
    },
    hostForContainer: (container: { name: string; hostId: string }) => entryFor(container.hostId).host,
    settingsFor: (id: string) => settingsOf(id),
    settingsForHost: (host: HostConfig) => byId.get(host.id)?.general ?? generalConfig(),
    backendFor: (id: string) => backendOf(id),
    tryBackendFor: (id: string) => byId.get(id)?.backend ?? null,
    legacyAccess: () => ({
      get: () => backendOf(fallbackId ?? ''),
      tryGet: () => (fallbackId ? byId.get(fallbackId)?.backend ?? null : null),
    }),
    isConfigured: () => entries.some((e) => Boolean(e.backend)),
    invalidate: () => undefined,
    invalidateChanged: () => [],
    close: async () => undefined,
  } as unknown as HostManager;
}

/** A HostManager stub with ONE host (`TEST_HOST_ID`) whose transport is `backend`. */
export function stubHostManager(
  backend: DockerBackend | null,
  opts: { host?: HostConfig; general?: GeneralConfig } = {},
): HostManager {
  const host = opts.host ?? hostConfig();
  return stubHosts([{ host, backend, ...(opts.general ? { general: opts.general } : {}) }]);
}

/** @deprecated v0.1 name kept so older feature tests keep compiling. */
export const stubBackendManager = stubHostManager;

/** Registry stub over the built-in agents (no config access). */
export function stubAgentRegistry(agents: AgentDefinition[] = BUILTIN_AGENTS): AgentRegistry {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return {
    list: () => agents.map((a) => ({ ...a, builtin: true })),
    get: (id: string) => byId.get(id) ?? null,
    require: (id: string) => {
      const found = byId.get(id);
      if (!found) throw new Error(`unknown agent '${id}'`);
      return found;
    },
    isBuiltin: (id: string) => byId.has(id),
    enabledForHost: (host: HostConfig) =>
      host.agents.enabled.map((id) => byId.get(id)).filter((a): a is AgentDefinition => Boolean(a)),
    resolveForContainer: (host: HostConfig, container: { agents: string[] | null }) =>
      (container.agents ?? host.agents.enabled)
        .map((id) => byId.get(id))
        .filter((a): a is AgentDefinition => Boolean(a)),
    installSpecsForHost: () => [],
  } as unknown as AgentRegistry;
}

export function serviceDeps(opts: {
  config: ConfigStore;
  /** v0.1 name, still accepted: the same stub object also satisfies HostManager */
  backends?: HostManager;
  hosts?: HostManager;
  agents?: AgentRegistry;
  paths?: Paths;
}): ServiceDeps {
  const hosts = (opts.hosts ?? opts.backends ?? stubHostManager(null)) as HostManager;
  return {
    env: {} as ServiceDeps['env'],
    log: silentLog,
    paths: opts.paths ?? testPaths(),
    config: opts.config,
    hosts,
    agents: opts.agents ?? stubAgentRegistry(),
    backends: hosts.legacyAccess(),
  };
}
