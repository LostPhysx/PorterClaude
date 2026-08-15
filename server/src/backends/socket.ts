// OWNER: B1. Local Docker socket transport via dockerode.
//
// exec stream: container.exec({AttachStdin:true, AttachStdout:true, Tty:true}) then
// exec.start({ hijack: true, stdin: true }) -> duplex stream of RAW bytes (tty mode).
// With Tty:false the stream is multiplexed (8-byte header) -> use docker.modem.demuxStream.
import Docker from 'dockerode';
import type {
  BackendKind, BuildOptions, ContainerInspect, ContainerSummary, CreateContainerSpec,
  DockerBackend, DockerInfo, ExecResult, ExecSpec, ExecStream, ImageInspect, ImageSummary,
  ListContainersOptions, LogsOptions, NetworkSummary, PullOptions, TerminalSize, VolumeSummary,
} from './types.js';

export interface SocketBackendOptions {
  socketPath: string;      // default /var/run/docker.sock
}

export class SocketBackend implements DockerBackend {
  readonly kind: BackendKind = 'socket';
  readonly id: string;
  private readonly docker: Docker;

  constructor(private readonly opts: SocketBackendOptions) {
    this.id = `socket:${opts.socketPath}`;
    this.docker = new Docker({ socketPath: opts.socketPath });
  }

  /** True when the socket path exists and is a socket (used for auto-detection in Settings). */
  static async isAvailable(socketPath: string): Promise<boolean> {
    throw new Error('TODO(B1)');
  }

  async ping(): Promise<void> { throw new Error('TODO(B1)'); }
  async info(): Promise<DockerInfo> { throw new Error('TODO(B1)'); }

  async listContainers(opts?: ListContainersOptions): Promise<ContainerSummary[]> { throw new Error('TODO(B1)'); }
  async inspectContainer(id: string): Promise<ContainerInspect> { throw new Error('TODO(B1)'); }
  async createContainer(spec: CreateContainerSpec): Promise<{ id: string; warnings: string[] }> { throw new Error('TODO(B1)'); }
  async startContainer(id: string): Promise<void> { throw new Error('TODO(B1)'); }
  async stopContainer(id: string, opts?: { timeoutSec?: number }): Promise<void> { throw new Error('TODO(B1)'); }
  async restartContainer(id: string, opts?: { timeoutSec?: number }): Promise<void> { throw new Error('TODO(B1)'); }
  async removeContainer(id: string, opts?: { force?: boolean; removeVolumes?: boolean }): Promise<void> { throw new Error('TODO(B1)'); }
  async waitContainer(id: string): Promise<{ statusCode: number }> { throw new Error('TODO(B1)'); }
  async containerLogs(id: string, opts?: LogsOptions): Promise<string> { throw new Error('TODO(B1)'); }

  async execCreate(spec: ExecSpec): Promise<{ execId: string }> { throw new Error('TODO(B1)'); }
  async execStart(execId: string, opts: { tty: boolean; stdin: boolean }): Promise<ExecStream> { throw new Error('TODO(B1)'); }
  async execResize(execId: string, size: TerminalSize): Promise<void> { throw new Error('TODO(B1)'); }
  async execInspect(execId: string): Promise<{ running: boolean; exitCode: number | null; pid: number }> { throw new Error('TODO(B1)'); }
  async runExec(containerId: string, cmd: string[], opts?: { user?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<ExecResult> { throw new Error('TODO(B1)'); }

  async listImages(opts?: { all?: boolean; labelFilters?: Record<string, string> }): Promise<ImageSummary[]> { throw new Error('TODO(B1)'); }
  async inspectImage(ref: string): Promise<ImageInspect | null> { throw new Error('TODO(B1)'); }
  async pullImage(ref: string, opts?: PullOptions): Promise<void> { throw new Error('TODO(B1)'); }
  async removeImage(ref: string, opts?: { force?: boolean }): Promise<void> { throw new Error('TODO(B1)'); }
  async buildImage(opts: BuildOptions): Promise<void> { throw new Error('TODO(B1)'); }

  async listVolumes(): Promise<VolumeSummary[]> { throw new Error('TODO(B1)'); }
  async createVolume(spec: { name: string; labels?: Record<string, string>; driver?: string }): Promise<VolumeSummary> { throw new Error('TODO(B1)'); }
  async removeVolume(name: string, opts?: { force?: boolean }): Promise<void> { throw new Error('TODO(B1)'); }

  async listNetworks(): Promise<NetworkSummary[]> { throw new Error('TODO(B1)'); }

  async close(): Promise<void> { /* dockerode holds no persistent agent we own */ }
}

/** ExecStream over a hijacked docker socket duplex. TODO(B1): implement. */
export class SocketExecStream implements ExecStream {
  readonly execId: string;
  constructor(execId: string, private readonly stream: NodeJS.ReadWriteStream, private readonly resizeFn: (s: TerminalSize) => Promise<void>, private readonly tty: boolean) {
    this.execId = execId;
  }
  write(data: Uint8Array | string): void { throw new Error('TODO(B1)'); }
  onData(cb: (chunk: Uint8Array, stream: 'stdout' | 'stderr') => void): void { throw new Error('TODO(B1)'); }
  onClose(cb: (info: { code?: number; reason?: string }) => void): void { throw new Error('TODO(B1)'); }
  onError(cb: (err: Error) => void): void { throw new Error('TODO(B1)'); }
  async resize(size: TerminalSize): Promise<void> { throw new Error('TODO(B1)'); }
  close(): void { throw new Error('TODO(B1)'); }
}

/** Shared helpers B1 should implement once and reuse in both backends. */
export const dockerMap = {
  /** docker "State" string -> ContainerState */
  toState(_s: string | undefined): ContainerSummary['state'] { throw new Error('TODO(B1)'); },
  /** CreateContainerSpec -> docker POST /containers/create body (identical for both backends) */
  toCreateBody(_spec: CreateContainerSpec): Record<string, unknown> { throw new Error('TODO(B1)'); },
  /** labelFilters -> the JSON value of the docker `filters` query parameter */
  toLabelFilter(_labels: Record<string, string> | undefined, _extra?: Record<string, string[]>): string | undefined { throw new Error('TODO(B1)'); },
};
