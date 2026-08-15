// OWNER: B1. Portainer transport for the Docker Engine API.
//
// REST:   {baseUrl}/api/endpoints/{endpointId}/docker/<engine path>   header X-API-Key
//         e.g. GET /api/endpoints/2/docker/containers/json?all=1
// Exec:   1) POST .../docker/containers/{id}/exec           -> { Id }
//         2) wss://{host}/api/websocket/exec?endpointId={id}&id={execId}   header X-API-Key
//            (VERIFIED to work with the API key header on Portainer EE 2.39)
//            Portainer starts the exec itself when the socket opens; do NOT call
//            /exec/{id}/start as well.
//         3) resize goes over REST: POST .../docker/exec/{execId}/resize?h=<rows>&w=<cols>
// Build:  POST .../docker/build?t=<tag>&dockerfile=... with the tar stream as the body and
//         Content-Type: application/x-tar; response is a JSON-lines progress stream.
//
// Uses global fetch (Node 22) + the `ws` client. NEVER log the api key.
import WebSocket from 'ws';
import type {
  BackendKind, BuildOptions, ContainerInspect, ContainerSummary, CreateContainerSpec,
  DockerBackend, DockerInfo, ExecResult, ExecSpec, ExecStream, ImageInspect, ImageSummary,
  ListContainersOptions, LogsOptions, NetworkSummary, PortainerEndpoint, PullOptions,
  TerminalSize, VolumeSummary,
} from './types.js';

export interface PortainerBackendOptions {
  /** base url without trailing slash, e.g. https://portainer.example.com */
  url: string;
  apiKey: string;
  endpointId: number;
  /** allow self-signed certs (sets an https agent with rejectUnauthorized:false) */
  insecureTls?: boolean;
  /** request timeout for non-streaming calls, ms (default 20000) */
  timeoutMs?: number;
}

export class PortainerBackend implements DockerBackend {
  readonly kind: BackendKind = 'portainer';
  readonly id: string;

  constructor(private readonly opts: PortainerBackendOptions) {
    this.id = `portainer:${opts.url}#${opts.endpointId}`;
  }

  // --- internal helpers -----------------------------------------------------

  /** TODO(B1): `${url}/api/endpoints/${endpointId}/docker${path}` */
  private dockerUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    throw new Error('TODO(B1)');
  }

  /** TODO(B1): fetch with X-API-Key, JSON in/out, map !ok -> DockerApiError(status, body). */
  private async request<T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; raw?: boolean; signal?: AbortSignal },
  ): Promise<T> {
    throw new Error('TODO(B1)');
  }

  /** TODO(B1): consume a JSON-lines (docker progress) response body, calling onLine per line. */
  private async consumeJsonLines(res: Response, onLine: (line: unknown) => void): Promise<void> {
    throw new Error('TODO(B1)');
  }

  /** Portainer-specific: list endpoints for the Settings picker. GET /api/endpoints */
  async listEndpoints(): Promise<PortainerEndpoint[]> {
    throw new Error('TODO(B1)');
  }

  /** Portainer-specific: GET /api/status (version probe, cheap auth check). */
  async portainerStatus(): Promise<{ Version: string }> {
    throw new Error('TODO(B1)');
  }

  // --- DockerBackend --------------------------------------------------------

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

  async close(): Promise<void> { /* nothing to release for fetch-based transport */ }
}

/**
 * ExecStream over a Portainer websocket. Portainer relays raw tty bytes in both
 * directions; there is no control channel, so resize() calls the REST resize endpoint.
 * TODO(B1): implement.
 */
export class PortainerExecStream implements ExecStream {
  readonly execId: string;
  constructor(execId: string, private readonly ws: WebSocket, private readonly resizeFn: (s: TerminalSize) => Promise<void>) {
    this.execId = execId;
  }
  write(data: Uint8Array | string): void { throw new Error('TODO(B1)'); }
  onData(cb: (chunk: Uint8Array, stream: 'stdout' | 'stderr') => void): void { throw new Error('TODO(B1)'); }
  onClose(cb: (info: { code?: number; reason?: string }) => void): void { throw new Error('TODO(B1)'); }
  onError(cb: (err: Error) => void): void { throw new Error('TODO(B1)'); }
  async resize(size: TerminalSize): Promise<void> { throw new Error('TODO(B1)'); }
  close(): void { throw new Error('TODO(B1)'); }
}
