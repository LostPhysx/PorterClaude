// OWNER: B2. Test doubles shared by the feature tests. No docker host, no B1 runtime code.
import pino from 'pino';
import type { ServiceDeps } from '../../src/context.js';
import type { ConfigStore } from '../../src/config/store.js';
import type { GeneralConfig } from '../../src/config/schema.js';
import { GeneralConfigSchema } from '../../src/config/schema.js';
import type { BackendManager } from '../../src/backends/index.js';
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
import type { SessionConfig, SessionInput } from '../../src/sessions/model.js';
import { SessionInputSchema } from '../../src/sessions/model.js';

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

export function sessionInput(overrides: Partial<SessionInput> = {}): SessionInput {
  return SessionInputSchema.parse({
    name: 'web',
    image: { type: 'recipe', recipe: 'node' },
    ...overrides,
  });
}

export function sessionConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  const { createdAt, updatedAt, specHash, ...rest } = overrides;
  return {
    ...sessionInput(rest),
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
  sessions: Map<string, SessionConfig>;
  general: GeneralConfig;
}

export function stubConfigStore(
  sessions: SessionConfig[] = [],
  general: GeneralConfig = generalConfig(),
): StubConfigStore {
  const map = new Map(sessions.map((s) => [s.name, s]));
  const store = {
    general: () => general,
    listSessions: () => [...map.values()],
    getSession: (name: string) => map.get(name) ?? null,
    putSession: async (cfg: SessionConfig) => {
      map.set(cfg.name, cfg);
      return cfg;
    },
    deleteSession: async (name: string) => map.delete(name),
  } as unknown as ConfigStore;
  return { store, sessions: map, general };
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
      'porterclaude.session': 'web',
      'porterclaude.image-type': 'recipe',
      'porterclaude.recipe': 'node',
    },
    ports: [],
    ...overrides,
  };
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

export function stubBackendManager(backend: DockerBackend | null): BackendManager {
  return {
    get: () => {
      if (!backend) throw new Error('no docker backend configured');
      return backend;
    },
    tryGet: () => backend,
    isConfigured: () => Boolean(backend),
    invalidate: () => undefined,
  } as unknown as BackendManager;
}

export function serviceDeps(opts: {
  config: ConfigStore;
  backends: BackendManager;
  paths?: Paths;
}): ServiceDeps {
  return {
    env: {} as ServiceDeps['env'],
    log: silentLog,
    paths: opts.paths ?? testPaths(),
    config: opts.config,
    backends: opts.backends,
  };
}
