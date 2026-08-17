// FROZEN (planner-authored, types only). THE contract between B1 (implementations) and
// B2 (consumers: containers / sessions / images). Do not change any exported shape.
import type { Readable } from 'node:stream';

export type BackendKind = 'portainer' | 'socket';

export type ContainerState =
  | 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead' | 'unknown';

export interface PortBinding {
  containerPort: number;
  hostPort?: number;
  protocol: 'tcp' | 'udp';
  hostIp?: string;
}

export interface MountInfo {
  type: string;            // 'bind' | 'volume' | 'tmpfs'
  source?: string;         // host path for binds
  name?: string;           // volume name
  destination: string;
  readOnly: boolean;
}

export interface ContainerSummary {
  id: string;
  name: string;            // primary name without leading slash
  names: string[];
  image: string;
  imageId: string;
  state: ContainerState;
  status: string;          // human string from docker, e.g. "Up 3 hours"
  createdAt: number;       // unix seconds
  labels: Record<string, string>;
  ports: PortBinding[];
}

export interface ContainerInspect {
  id: string;
  name: string;
  image: string;
  imageId: string;
  state: ContainerState;
  running: boolean;
  createdAt?: string;      // ISO
  startedAt?: string;      // ISO
  finishedAt?: string;     // ISO
  exitCode?: number;
  labels: Record<string, string>;
  env: string[];           // "KEY=value"
  mounts: MountInfo[];
  ports: PortBinding[];
  user?: string;
  /**
   * The container's own `Config.Cmd`, i.e. exactly the argv it was CREATED with (never the
   * image default — the engine does not inherit the image Cmd once the create request sets
   * an Entrypoint). Read back when recomputing a container spec hash, see
   * containers/container.ts `imageCmd`.
   */
  cmd?: string[];
  raw: unknown;            // full docker inspect JSON, for anything not modelled here
}

export interface MountSpec {
  type: 'bind' | 'volume' | 'tmpfs';
  /** host path for bind, volume name for volume, ignored for tmpfs */
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface PortMapSpec {
  containerPort: number;
  hostPort?: number;       // undefined => random host port
  protocol?: 'tcp' | 'udp';
  hostIp?: string;
}

export interface ResourceSpec {
  cpus?: number;           // 1.5 => NanoCpus 1500000000
  memoryMb?: number;       // => Memory bytes
  pidsLimit?: number;
}

export interface CreateContainerSpec {
  name: string;
  image: string;
  cmd?: string[];
  entrypoint?: string[];
  env?: Record<string, string>;
  labels?: Record<string, string>;
  workingDir?: string;
  user?: string;
  hostname?: string;
  tty?: boolean;
  openStdin?: boolean;
  init?: boolean;
  mounts?: MountSpec[];
  ports?: PortMapSpec[];
  restartPolicy?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  resources?: ResourceSpec;
  networks?: string[];
  capAdd?: string[];
  autoRemove?: boolean;
}

export interface ExecSpec {
  containerId: string;
  cmd: string[];
  tty?: boolean;
  env?: Record<string, string>;
  workingDir?: string;
  user?: string;
  attachStdin?: boolean;
  attachStdout?: boolean;
  attachStderr?: boolean;
}

export interface TerminalSize { cols: number; rows: number }

/**
 * A live exec attachment. With tty:true the docker stream is NOT multiplexed, so every
 * chunk is reported as 'stdout'. With tty:false implementations MUST demultiplex the
 * 8-byte docker frame header and report the correct stream.
 * Callbacks may be registered at most once each; last registration wins.
 */
export interface ExecStream {
  readonly execId: string;
  write(data: Uint8Array | string): void;
  onData(cb: (chunk: Uint8Array, stream: 'stdout' | 'stderr') => void): void;
  onClose(cb: (info: { code?: number; reason?: string }) => void): void;
  onError(cb: (err: Error) => void): void;
  resize(size: TerminalSize): Promise<void>;
  /** idempotent; also detaches callbacks */
  close(): void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ImageSummary {
  id: string;
  tags: string[];          // RepoTags, dangling entries filtered out
  createdAt: number;       // unix seconds
  sizeBytes: number;
  labels: Record<string, string>;
}

export interface ImageInspect {
  id: string;
  tags: string[];
  createdAt: string;       // ISO
  sizeBytes: number;
  labels: Record<string, string>;
  architecture?: string;
  os?: string;
  user?: string;
  entrypoint?: string[];
  cmd?: string[];
  env: string[];
  raw: unknown;
}

/** One decoded line of the docker build/pull JSON stream. */
export interface BuildLogLine {
  stream?: string;
  status?: string;
  progress?: string;
  id?: string;
  error?: string;
  aux?: unknown;
}

export interface BuildOptions {
  /** full image ref including tag, e.g. "porterclaude/node:latest" */
  tag: string;
  extraTags?: string[];
  /** tar stream of the build context (see images/tarContext.ts) */
  context: Readable;
  dockerfile?: string;     // path inside the context, default "Dockerfile"
  buildArgs?: Record<string, string>;
  labels?: Record<string, string>;
  pull?: boolean;
  noCache?: boolean;
  platform?: string;       // e.g. "linux/arm64"; omit to build natively
  onLog?: (line: BuildLogLine) => void;
  signal?: AbortSignal;
}

export interface PullOptions {
  onLog?: (line: BuildLogLine) => void;
  platform?: string;
  signal?: AbortSignal;
}

export interface VolumeSummary {
  name: string;
  driver: string;
  mountpoint?: string;
  labels: Record<string, string>;
  createdAt?: string;
}

export interface NetworkSummary {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  labels: Record<string, string>;
}

export interface DockerInfo {
  name: string;
  serverVersion: string;
  apiVersion?: string;
  os: string;
  osType?: string;
  architecture: string;
  ncpu: number;
  memTotalBytes: number;
  containers: number;
  containersRunning: number;
  images: number;
}

export interface ListContainersOptions {
  all?: boolean;
  /** ANDed label filters; empty string value means "label present with any value" */
  labelFilters?: Record<string, string>;
}

export interface LogsOptions {
  tail?: number;           // default 200
  since?: number;          // unix seconds
  stdout?: boolean;        // default true
  stderr?: boolean;        // default true
  timestamps?: boolean;    // default false
}

/**
 * Everything PorterClaude needs from a Docker engine. Both implementations speak the
 * Docker Engine API; only transport/auth/exec-stream differ.
 * Implementations MUST throw DockerApiError (http/errors.ts) on API failures and MUST
 * translate docker 404 into DockerApiError with dockerStatus=404.
 */
export interface DockerBackend {
  readonly kind: BackendKind;
  /** stable identity of the target engine, used to invalidate caches
   *  ("socket:/var/run/docker.sock", "portainer:https://host#2") */
  readonly id: string;

  ping(): Promise<void>;
  info(): Promise<DockerInfo>;

  listContainers(opts?: ListContainersOptions): Promise<ContainerSummary[]>;
  inspectContainer(id: string): Promise<ContainerInspect>;
  createContainer(spec: CreateContainerSpec): Promise<{ id: string; warnings: string[] }>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, opts?: { timeoutSec?: number }): Promise<void>;
  restartContainer(id: string, opts?: { timeoutSec?: number }): Promise<void>;
  removeContainer(id: string, opts?: { force?: boolean; removeVolumes?: boolean }): Promise<void>;
  waitContainer(id: string): Promise<{ statusCode: number }>;
  containerLogs(id: string, opts?: LogsOptions): Promise<string>;

  execCreate(spec: ExecSpec): Promise<{ execId: string }>;
  execStart(execId: string, opts: { tty: boolean; stdin: boolean }): Promise<ExecStream>;
  execResize(execId: string, size: TerminalSize): Promise<void>;
  execInspect(execId: string): Promise<{ running: boolean; exitCode: number | null; pid: number }>;
  /** convenience: create+start+collect a non-tty exec. Used for capability probes (tmux, apt, ...). */
  runExec(
    containerId: string,
    cmd: string[],
    opts?: { user?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<ExecResult>;

  listImages(opts?: { all?: boolean; labelFilters?: Record<string, string> }): Promise<ImageSummary[]>;
  /** null when the image does not exist on the engine */
  inspectImage(ref: string): Promise<ImageInspect | null>;
  pullImage(ref: string, opts?: PullOptions): Promise<void>;
  removeImage(ref: string, opts?: { force?: boolean }): Promise<void>;
  buildImage(opts: BuildOptions): Promise<void>;

  listVolumes(): Promise<VolumeSummary[]>;
  createVolume(spec: { name: string; labels?: Record<string, string>; driver?: string }): Promise<VolumeSummary>;
  removeVolume(name: string, opts?: { force?: boolean }): Promise<void>;

  listNetworks(): Promise<NetworkSummary[]>;

  /** release sockets/agents; safe to call twice */
  close(): Promise<void>;
}

/** Portainer-only: the endpoint picker in Settings. */
export interface PortainerEndpoint {
  id: number;
  name: string;
  type: number;            // 1 = docker
  status: number;          // 1 = up
  url?: string;
  publicUrl?: string;
}

export interface BackendTestResult {
  ok: boolean;
  info?: DockerInfo;
  endpoints?: PortainerEndpoint[];
  error?: { code: string; message: string };
}
