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
// Transport note (deviation from the sketch in backend.md, same wire behaviour): the REST
// calls use node:http/node:https directly instead of global fetch. Node 22 exposes no
// public way to give fetch a TLS-relaxed dispatcher (that needs the `undici` package,
// which is not a dependency), and `insecureTls` must work; node:https also streams the
// build tar as a chunked request body without the `duplex: 'half'` dance. Everything else
// (headers, JSON-lines handling, error mapping) is unchanged. NEVER log the api key.
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import WebSocket from 'ws';
import { DockerApiError } from '../http/errors.js';
import {
  consumeJsonLineStream, createDemuxer, decodeDockerStream, dockerMap, toDockerApiError,
} from './socket.js';
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

type Raw = Record<string, any>;

type QueryValue = string | number | boolean | undefined;

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
}

function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export class PortainerBackend implements DockerBackend {
  readonly kind: BackendKind = 'portainer';
  readonly id: string;
  private agent: http.Agent | https.Agent | null = null;
  /** number of HTTP requests currently using `agent` (or a draining one) */
  private inflight = 0;
  /**
   * Agents detached by close() that still carry in-flight requests. `Agent.destroy()`
   * kills sockets that are *in use* as well as idle ones, so destroying eagerly would
   * abort long-running streams (image builds/pulls, `git clone` execs) that a still
   * running job holds on this instance. They are destroyed once nothing is in flight.
   */
  private draining: (http.Agent | https.Agent)[] = [];

  constructor(private readonly opts: PortainerBackendOptions) {
    this.id = `portainer:${opts.url}#${opts.endpointId}`;
  }

  // --- internal helpers -----------------------------------------------------

  private get baseUrl(): string {
    return this.opts.url.replace(/\/+$/, '');
  }

  private isTls(): boolean {
    return this.baseUrl.toLowerCase().startsWith('https:');
  }

  private getAgent(): http.Agent | https.Agent {
    if (!this.agent) {
      this.agent = this.isTls()
        ? new https.Agent({ keepAlive: true, rejectUnauthorized: !this.opts.insecureTls })
        : new http.Agent({ keepAlive: true });
    }
    return this.agent;
  }

  /** Called when a request finishes; drops agents parked by close() once idle. */
  private endRequest(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    if (this.inflight > 0 || this.draining.length === 0) return;
    const parked = this.draining;
    this.draining = [];
    for (const a of parked) a.destroy();
  }

  /** `${url}/api/endpoints/${endpointId}/docker${path}` */
  private dockerUrl(path: string, query?: Record<string, QueryValue>): string {
    return `${this.baseUrl}/api/endpoints/${this.opts.endpointId}/docker${path}${buildQuery(query)}`;
  }

  /** Raw HTTP call against Portainer. Never throws for a non-2xx status. */
  private send(
    method: string,
    url: string,
    opts?: {
      body?: Buffer | string | Readable;
      contentType?: string;
      signal?: AbortSignal;
      timeoutMs?: number | null;
    },
  ): Promise<RawResponse> {
    const lib = this.isTls() ? https : http;
    const headers: Record<string, string> = {
      'X-API-Key': this.opts.apiKey,
      Accept: 'application/json',
    };
    if (opts?.contentType) headers['Content-Type'] = opts.contentType;

    return new Promise<RawResponse>((resolve, reject) => {
      const agent = this.getAgent();
      this.inflight += 1;
      let released = false;
      // the request is "done" when its response stream closes (keep-alive: the socket is
      // only reusable then); if no response ever arrives, the request 'close' releases it.
      const release = () => {
        if (released) return;
        released = true;
        this.endRequest();
      };
      let gotResponse = false;

      const req = lib.request(url, { method, headers, agent }, (res) => {
        gotResponse = true;
        res.on('close', release);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res });
      });

      const timeout = opts?.timeoutMs === null ? 0 : opts?.timeoutMs ?? this.opts.timeoutMs ?? 20_000;
      if (timeout > 0) {
        req.setTimeout(timeout, () => {
          req.destroy(new Error(`request timed out after ${timeout}ms`));
        });
      }
      req.on('error', (err) => {
        if (!gotResponse) release();
        reject(err);
      });

      const onAbort = () => req.destroy(new Error('cancelled'));
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => {
        opts?.signal?.removeEventListener('abort', onAbort);
        if (!gotResponse) release();
      });

      const body = opts?.body;
      if (body instanceof Readable) body.pipe(req);
      else if (body !== undefined) req.end(body);
      else req.end();
    });
  }

  private static async readAll(stream: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  }

  /** HTTP request with X-API-Key, JSON in/out; !ok -> DockerApiError(status, body). */
  private async request<T>(
    method: string,
    path: string,
    opts?: {
      query?: Record<string, QueryValue>;
      body?: unknown;
      raw?: boolean;
      signal?: AbortSignal;
      absoluteUrl?: string;
    },
  ): Promise<T> {
    const url = opts?.absoluteUrl ?? this.dockerUrl(path, opts?.query);
    const what = `${method} ${path}`;
    let res: RawResponse;
    try {
      res = await this.send(method, url, {
        body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
        contentType: opts?.body === undefined ? undefined : 'application/json',
        signal: opts?.signal,
      });
    } catch (err) {
      throw toDockerApiError(err, what);
    }

    const buf = await PortainerBackend.readAll(res.stream);
    if (res.status >= 400) {
      throw new DockerApiError(`${what}: ${PortainerBackend.errorMessage(buf, res.status)}`, res.status);
    }
    if (opts?.raw) return buf as unknown as T;
    const text = buf.toString('utf8').trim();
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  private static errorMessage(buf: Buffer, status: number): string {
    const text = buf.toString('utf8').trim();
    if (!text) return `HTTP ${status}`;
    try {
      const json = JSON.parse(text) as { message?: string; details?: string; err?: string };
      return json.message ?? json.details ?? json.err ?? text.slice(0, 400);
    } catch {
      return text.slice(0, 400);
    }
  }

  /** Consume a JSON-lines (docker progress) response body, calling onLine per line. */
  private async consumeJsonLines(res: RawResponse, onLine: (line: unknown) => void): Promise<void> {
    await consumeJsonLineStream(res.stream, (line) => onLine(line), undefined, 'docker stream');
  }

  /** Portainer-specific: list endpoints for the Settings picker. GET /api/endpoints */
  async listEndpoints(): Promise<PortainerEndpoint[]> {
    const raw = await this.request<Raw[]>('GET', '/api/endpoints', {
      absoluteUrl: `${this.baseUrl}/api/endpoints`,
    });
    return (raw ?? []).map((e) => ({
      id: e.Id,
      name: e.Name ?? '',
      type: e.Type ?? 0,
      status: e.Status ?? 0,
      url: e.URL ?? undefined,
      publicUrl: e.PublicURL ?? undefined,
    }));
  }

  /** Portainer-specific: GET /api/status (version probe, cheap auth check). */
  async portainerStatus(): Promise<{ Version: string }> {
    return this.request<{ Version: string }>('GET', '/api/status', {
      absoluteUrl: `${this.baseUrl}/api/status`,
    });
  }

  // --- DockerBackend --------------------------------------------------------

  async ping(): Promise<void> {
    await this.request<string>('GET', '/_ping', { raw: true });
  }

  async info(): Promise<DockerInfo> {
    return dockerMap.toInfo(await this.request<Raw>('GET', '/info'));
  }

  async listContainers(opts?: ListContainersOptions): Promise<ContainerSummary[]> {
    const raw = await this.request<Raw[]>('GET', '/containers/json', {
      query: { all: opts?.all ?? true, filters: dockerMap.toLabelFilter(opts?.labelFilters) },
    });
    return (raw ?? []).map((c) => dockerMap.toContainerSummary(c));
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    return dockerMap.toContainerInspect(await this.request<Raw>('GET', `/containers/${id}/json`));
  }

  async createContainer(spec: CreateContainerSpec): Promise<{ id: string; warnings: string[] }> {
    const res = await this.request<Raw>('POST', '/containers/create', {
      query: { name: spec.name },
      body: dockerMap.toCreateBody(spec),
    });
    return { id: res?.Id ?? '', warnings: res?.Warnings ?? [] };
  }

  async startContainer(id: string): Promise<void> {
    try {
      await this.request<void>('POST', `/containers/${id}/start`);
    } catch (err) {
      // Portainer's docker proxy re-encodes POST /containers/{id}/start so the engine sees a
      // non-empty request body and answers 400 ("... removed in v1.24"). Verified against the
      // reference host (EE 2.39.5 / Docker 29.1.3) with no body, Content-Length: 0, '' and an
      // empty Uint8Array -- all four fail identically, while /restart returns 204 and starts a
      // `created`/`exited` container. Fall back to /restart on this transport only;
      // SocketBackend keeps plain /start.
      if (
        err instanceof DockerApiError
        && err.dockerStatus === 400
        && /non-empty request body/i.test(err.message)
      ) {
        await this.request<void>('POST', `/containers/${id}/restart`);
        return;
      }
      throw err;
    }
  }

  async stopContainer(id: string, opts?: { timeoutSec?: number }): Promise<void> {
    try {
      await this.request<void>('POST', `/containers/${id}/stop`, { query: { t: opts?.timeoutSec ?? 5 } });
    } catch (err) {
      if (err instanceof DockerApiError && err.dockerStatus === 304) return; // already stopped
      throw err;
    }
  }

  async restartContainer(id: string, opts?: { timeoutSec?: number }): Promise<void> {
    await this.request<void>('POST', `/containers/${id}/restart`, { query: { t: opts?.timeoutSec ?? 5 } });
  }

  async removeContainer(id: string, opts?: { force?: boolean; removeVolumes?: boolean }): Promise<void> {
    await this.request<void>('DELETE', `/containers/${id}`, {
      query: { force: opts?.force ?? true, v: opts?.removeVolumes ?? false },
    });
  }

  /**
   * Block until the container stopped.
   *
   * QA B-1: this MUST NOT inherit send()'s 20 s default timeout. A v0.2 tools sync runs the
   * agent installers inside the populate container (curl/npm/uv, minutes), so the 20 s cut
   * turned every `POST /images/tools/sync` on a Portainer host into
   * "POST /containers/<id>/wait: request timed out after 20000ms" and the caller's `finally`
   * force-removed the container mid-install. The request therefore runs with `timeoutMs:
   * null` like the build/pull streams.
   *
   * A proxy in front of Portainer may still cut an idle connection (or answer with an empty
   * body); in that case ask the engine whether the container already exited, and otherwise
   * re-issue the wait. Bounded so a permanently broken transport still fails.
   */
  async waitContainer(id: string): Promise<{ statusCode: number }> {
    const what = `POST /containers/${id}/wait`;
    const maxAttempts = 5;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let res: RawResponse;
      try {
        res = await this.send('POST', this.dockerUrl(`/containers/${id}/wait`, { condition: 'not-running' }), {
          timeoutMs: null,
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const settled = await this.exitStatusIfStopped(id);
        if (settled) return settled;
        continue;
      }

      const buf = await PortainerBackend.readAll(res.stream);
      if (res.status >= 400) {
        throw new DockerApiError(`${what}: ${PortainerBackend.errorMessage(buf, res.status)}`, res.status);
      }
      const text = buf.toString('utf8').trim();
      if (text) {
        try {
          const raw = JSON.parse(text) as Raw;
          if (typeof raw?.StatusCode === 'number') return { statusCode: raw.StatusCode };
        } catch {
          // fall through to the inspect probe below
        }
      }
      // empty/garbled body: the connection was cut before the engine answered
      lastError = new Error('the wait stream ended without an exit status');
      const settled = await this.exitStatusIfStopped(id);
      if (settled) return settled;
    }

    throw toDockerApiError(lastError ?? new Error('wait failed'), what);
  }

  /** `{statusCode}` when the container exists and is no longer running, else null. */
  private async exitStatusIfStopped(id: string): Promise<{ statusCode: number } | null> {
    try {
      const inspect = await this.inspectContainer(id);
      if (inspect.running) return null;
      return { statusCode: inspect.exitCode ?? 0 };
    } catch {
      return null;
    }
  }

  async containerLogs(id: string, opts?: LogsOptions): Promise<string> {
    const buf = await this.request<Buffer>('GET', `/containers/${id}/logs`, {
      raw: true,
      query: {
        stdout: opts?.stdout ?? true,
        stderr: opts?.stderr ?? true,
        tail: opts?.tail ?? 200,
        timestamps: opts?.timestamps ?? false,
        since: opts?.since,
        follow: false,
      },
    });
    return decodeDockerStream(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8'));
  }

  async execCreate(spec: ExecSpec): Promise<{ execId: string }> {
    const res = await this.request<Raw>('POST', `/containers/${spec.containerId}/exec`, {
      body: dockerMap.toExecBody(spec),
    });
    const execId = res?.Id;
    if (!execId) throw new DockerApiError('portainer did not return an exec id');
    return { execId };
  }

  async execStart(execId: string, opts: { tty: boolean; stdin: boolean }): Promise<ExecStream> {
    const wsBase = this.baseUrl.replace(/^http/i, 'ws');
    const url = `${wsBase}/api/websocket/exec?endpointId=${this.opts.endpointId}&id=${encodeURIComponent(execId)}`;
    const socket = new WebSocket(url, {
      headers: { 'X-API-Key': this.opts.apiKey },
      rejectUnauthorized: !this.opts.insecureTls,
      perMessageDeflate: false,
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        socket.off('open', onOpen);
        reject(new DockerApiError(`portainer exec websocket failed: ${err.message}`, 502));
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });

    return new PortainerExecStream(execId, socket, (s) => this.execResize(execId, s), opts.tty);
  }

  async execResize(execId: string, size: TerminalSize): Promise<void> {
    await this.request<void>('POST', `/exec/${execId}/resize`, { query: { h: size.rows, w: size.cols } });
  }

  async execInspect(execId: string): Promise<{ running: boolean; exitCode: number | null; pid: number }> {
    const raw = await this.request<Raw>('GET', `/exec/${execId}/json`);
    return {
      running: !!raw?.Running,
      exitCode: typeof raw?.ExitCode === 'number' ? raw.ExitCode : null,
      pid: raw?.Pid ?? 0,
    };
  }

  async runExec(
    containerId: string,
    cmd: string[],
    opts?: { user?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<ExecResult> {
    const { execId } = await this.execCreate({
      containerId,
      cmd,
      tty: false,
      env: opts?.env,
      user: opts?.user,
      attachStdin: false,
      attachStdout: true,
      attachStderr: true,
    });

    // Non-tty start over REST: the response body IS the multiplexed exec output.
    let res: RawResponse;
    try {
      res = await this.send('POST', this.dockerUrl(`/exec/${execId}/start`), {
        body: JSON.stringify({ Detach: false, Tty: false }),
        contentType: 'application/json',
        timeoutMs: opts?.timeoutMs ?? 15_000,
      });
    } catch (err) {
      throw toDockerApiError(err, `start exec in ${containerId}`);
    }
    const buf = await PortainerBackend.readAll(res.stream);
    if (res.status >= 400) {
      throw new DockerApiError(
        `exec in ${containerId}: ${PortainerBackend.errorMessage(buf, res.status)}`,
        res.status,
      );
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const feed = createDemuxer((chunk, which) => {
      (which === 'stderr' ? err : out).push(Buffer.from(chunk));
    });
    feed(buf);

    let exitCode = 0;
    try {
      exitCode = (await this.execInspect(execId)).exitCode ?? 0;
    } catch {
      exitCode = 0;
    }
    return { exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
  }

  async listImages(opts?: { all?: boolean; labelFilters?: Record<string, string> }): Promise<ImageSummary[]> {
    const raw = await this.request<Raw[]>('GET', '/images/json', {
      query: { all: opts?.all ?? false, filters: dockerMap.toLabelFilter(opts?.labelFilters) },
    });
    return (raw ?? []).map((i) => dockerMap.toImageSummary(i));
  }

  async inspectImage(ref: string): Promise<ImageInspect | null> {
    try {
      return dockerMap.toImageInspect(await this.request<Raw>('GET', `/images/${ref}/json`));
    } catch (err) {
      if (err instanceof DockerApiError && err.dockerStatus === 404) return null;
      throw err;
    }
  }

  async pullImage(ref: string, opts?: PullOptions): Promise<void> {
    const [image, tag] = splitImageRef(ref);
    let res: RawResponse;
    try {
      res = await this.send(
        'POST',
        this.dockerUrl('/images/create', { fromImage: image, tag, platform: opts?.platform }),
        { signal: opts?.signal, timeoutMs: null },
      );
    } catch (err) {
      throw toDockerApiError(err, `pull image ${ref}`);
    }
    if (res.status >= 400) {
      const buf = await PortainerBackend.readAll(res.stream);
      throw new DockerApiError(`pull image ${ref}: ${PortainerBackend.errorMessage(buf, res.status)}`, res.status);
    }
    await consumeJsonLineStream(res.stream, opts?.onLog, opts?.signal, `pull image ${ref}`);
  }

  async removeImage(ref: string, opts?: { force?: boolean }): Promise<void> {
    await this.request<void>('DELETE', `/images/${ref}`, { query: { force: opts?.force ?? false } });
  }

  async buildImage(opts: BuildOptions): Promise<void> {
    const query: Record<string, QueryValue> = {
      t: opts.tag,
      dockerfile: opts.dockerfile ?? 'Dockerfile',
      nocache: opts.noCache ? 1 : undefined,
      pull: opts.pull ? 1 : undefined,
      platform: opts.platform,
      labels: opts.labels && Object.keys(opts.labels).length ? JSON.stringify(opts.labels) : undefined,
      buildargs:
        opts.buildArgs && Object.keys(opts.buildArgs).length ? JSON.stringify(opts.buildArgs) : undefined,
    };

    let res: RawResponse;
    try {
      res = await this.send('POST', this.dockerUrl('/build', query), {
        body: opts.context,
        contentType: 'application/x-tar',
        signal: opts.signal,
        timeoutMs: null,
      });
    } catch (err) {
      throw toDockerApiError(err, `build image ${opts.tag}`);
    }
    if (res.status >= 400) {
      const buf = await PortainerBackend.readAll(res.stream);
      throw new DockerApiError(
        `build image ${opts.tag}: ${PortainerBackend.errorMessage(buf, res.status)}`,
        res.status,
      );
    }
    await consumeJsonLineStream(res.stream, opts.onLog, opts.signal, `build image ${opts.tag}`);
  }

  async listVolumes(): Promise<VolumeSummary[]> {
    const raw = await this.request<Raw>('GET', '/volumes');
    return (raw?.Volumes ?? []).map((v: Raw) => dockerMap.toVolume(v));
  }

  async createVolume(spec: { name: string; labels?: Record<string, string>; driver?: string }): Promise<VolumeSummary> {
    const raw = await this.request<Raw>('POST', '/volumes/create', {
      body: { Name: spec.name, Labels: spec.labels, Driver: spec.driver ?? 'local' },
    });
    return dockerMap.toVolume(raw);
  }

  async removeVolume(name: string, opts?: { force?: boolean }): Promise<void> {
    await this.request<void>('DELETE', `/volumes/${name}`, { query: { force: opts?.force ?? false } });
  }

  async listNetworks(): Promise<NetworkSummary[]> {
    const raw = await this.request<Raw[]>('GET', '/networks');
    return (raw ?? []).map((n) => dockerMap.toNetwork(n));
  }

  /**
   * Detach the keep-alive agent. Sockets are only destroyed when no request is in
   * flight -- a backend rebuilt after a settings change must never abort the streams
   * (build/pull progress, exec output) of jobs that still hold the previous instance.
   */
  async close(): Promise<void> {
    const agent = this.agent;
    this.agent = null;
    if (!agent) return;
    if (this.inflight === 0) {
      agent.destroy();
      return;
    }
    this.draining.push(agent);
  }
}

/** "nginx:1.27" -> ["nginx", "1.27"]; digests and registries with a port are handled. */
export function splitImageRef(ref: string): [string, string] {
  const at = ref.indexOf('@');
  if (at > 0) return [ref.slice(0, at), ref.slice(at + 1)];
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > slash) return [ref.slice(0, colon), ref.slice(colon + 1)];
  return [ref, 'latest'];
}

/**
 * ExecStream over a Portainer websocket. Portainer relays raw tty bytes in both
 * directions; there is no control channel, so resize() calls the REST resize endpoint.
 */
export class PortainerExecStream implements ExecStream {
  readonly execId: string;
  private dataCb: ((chunk: Uint8Array, stream: 'stdout' | 'stderr') => void) | null = null;
  private closeCb: ((info: { code?: number; reason?: string }) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private closed = false;
  private readonly feed: (data: Buffer) => void;

  constructor(
    execId: string,
    private readonly ws: WebSocket,
    private readonly resizeFn: (s: TerminalSize) => Promise<void>,
    tty = true,
  ) {
    this.execId = execId;
    const demux = createDemuxer((chunk, which) => this.dataCb?.(chunk, which));
    this.feed = (data: Buffer) => {
      if (tty) this.dataCb?.(new Uint8Array(data), 'stdout');
      else demux(data);
    };

    this.ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
      void isBinary;
      this.feed(buf);
    });
    this.ws.on('error', (err: Error) => this.errorCb?.(err));
    this.ws.on('close', (code: number, reason: Buffer) => {
      if (this.closed) return;
      this.closed = true;
      this.closeCb?.({ code, reason: reason?.toString('utf8') });
    });
  }

  write(data: Uint8Array | string): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data), { binary: true });
  }

  onData(cb: (chunk: Uint8Array, stream: 'stdout' | 'stderr') => void): void {
    this.dataCb = cb;
  }

  onClose(cb: (info: { code?: number; reason?: string }) => void): void {
    this.closeCb = cb;
  }

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }

  async resize(size: TerminalSize): Promise<void> {
    await this.resizeFn(size);
  }

  close(): void {
    this.closed = true;
    this.dataCb = null;
    this.closeCb = null;
    this.errorCb = null;
    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
      else this.ws.terminate();
    } catch {
      // already gone
    }
  }
}
