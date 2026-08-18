// OWNER: B1. Local Docker socket transport via dockerode.
//
// exec stream: container.exec({AttachStdin:true, AttachStdout:true, Tty:true}) then
// exec.start({ hijack: true, stdin: true }) -> duplex stream of RAW bytes (tty mode).
// With Tty:false the stream is multiplexed (8-byte header) -> use the demuxer below.
//
// This file also owns `dockerMap`: the Docker Engine API request/response mapping shared
// with the Portainer backend (Portainer only proxies the same engine API), so the mapping
// exists exactly once.
import fs from 'node:fs/promises';
import type { Readable } from 'node:stream';
import Docker from 'dockerode';
import { DockerApiError } from '../http/errors.js';
import type {
  BackendKind, BuildLogLine, BuildOptions, ContainerInspect, ContainerState, ContainerSummary,
  CreateContainerSpec, DockerBackend, DockerInfo, ExecResult, ExecSpec, ExecStream, ImageInspect,
  ImageSummary, ListContainersOptions, LogsOptions, MountInfo, NetworkSummary, PortBinding,
  PullOptions, TerminalSize, VolumeSummary,
} from './types.js';

export interface SocketBackendOptions {
  socketPath: string;      // default /var/run/docker.sock
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

type Raw = Record<string, any>;

/** Turn any transport/dockerode failure into a DockerApiError (404 stays 404). */
export function toDockerApiError(err: unknown, what: string): DockerApiError {
  if (err instanceof DockerApiError) return err;
  const e = err as { statusCode?: number; status?: number; json?: { message?: string }; message?: string };
  const status = typeof e?.statusCode === 'number' ? e.statusCode : typeof e?.status === 'number' ? e.status : undefined;
  const message = e?.json?.message ?? e?.message ?? String(err);
  return new DockerApiError(`${what}: ${message}`, status);
}

/** Split a docker JSON-lines progress body into decoded objects. */
export function parseJsonLines(text: string): BuildLogLine[] {
  const out: BuildLogLine[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as BuildLogLine);
    } catch {
      out.push({ stream: trimmed });
    }
  }
  return out;
}

/** Incremental demultiplexer for the 8-byte docker stream framing (Tty:false). */
export function createDemuxer(onChunk: (chunk: Uint8Array, stream: 'stdout' | 'stderr') => void) {
  let buf = Buffer.alloc(0);
  return (data: Buffer): void => {
    buf = buf.length === 0 ? Buffer.from(data) : Buffer.concat([buf, data]);
    for (;;) {
      if (buf.length < 8) return;
      const type = buf[0] as number;
      const len = buf.readUInt32BE(4);
      if (buf.length < 8 + len) return;
      const payload = buf.subarray(8, 8 + len);
      onChunk(new Uint8Array(payload), type === 2 ? 'stderr' : 'stdout');
      buf = buf.subarray(8 + len);
    }
  };
}

/** True when the buffer looks like a complete multiplexed docker stream. */
function looksMultiplexed(buf: Buffer): boolean {
  let off = 0;
  let frames = 0;
  while (off + 8 <= buf.length) {
    const type = buf[off] as number;
    if (type > 2 || buf[off + 1] !== 0 || buf[off + 2] !== 0 || buf[off + 3] !== 0) return false;
    const len = buf.readUInt32BE(off + 4);
    off += 8 + len;
    frames++;
    if (off > buf.length) return false;
  }
  return frames > 0 && off === buf.length;
}

/** Decode a docker log/exec payload whether or not it is multiplexed. */
export function decodeDockerStream(buf: Buffer): string {
  if (!looksMultiplexed(buf)) return buf.toString('utf8');
  const parts: string[] = [];
  const feed = createDemuxer((chunk) => parts.push(Buffer.from(chunk).toString('utf8')));
  feed(buf);
  return parts.join('');
}

function labelsOf(raw: unknown): Record<string, string> {
  return raw && typeof raw === 'object' ? ({ ...(raw as Record<string, string>) }) : {};
}

/** Shared helpers B1 implements once and reuses in both backends. */
export const dockerMap = {
  /** docker "State" string -> ContainerState */
  toState(_s: string | undefined): ContainerState {
    const s = (_s ?? '').toLowerCase();
    switch (s) {
      case 'created':
      case 'running':
      case 'paused':
      case 'restarting':
      case 'removing':
      case 'exited':
      case 'dead':
        return s;
      default:
        return 'unknown';
    }
  },

  /** CreateContainerSpec -> docker POST /containers/create body (identical for both backends) */
  toCreateBody(_spec: CreateContainerSpec): Record<string, unknown> {
    const spec = _spec;
    const env = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`);

    const exposedPorts: Record<string, Record<string, never>> = {};
    const portBindings: Record<string, Array<{ HostIp?: string; HostPort: string }>> = {};
    for (const p of spec.ports ?? []) {
      const key = `${p.containerPort}/${p.protocol ?? 'tcp'}`;
      exposedPorts[key] = {};
      portBindings[key] = [
        { HostIp: p.hostIp ?? '', HostPort: p.hostPort === undefined ? '' : String(p.hostPort) },
      ];
    }

    const mounts = (spec.mounts ?? []).map((m) => {
      const entry: Record<string, unknown> = { Type: m.type, Target: m.target, ReadOnly: !!m.readOnly };
      if (m.type !== 'tmpfs') entry.Source = m.source;
      return entry;
    });

    const networks = spec.networks ?? [];
    const hostConfig: Record<string, unknown> = {
      Init: spec.init ?? undefined,
      Mounts: mounts.length ? mounts : undefined,
      PortBindings: Object.keys(portBindings).length ? portBindings : undefined,
      RestartPolicy: { Name: spec.autoRemove ? 'no' : spec.restartPolicy ?? 'no' },
      NanoCpus: spec.resources?.cpus !== undefined ? Math.round(spec.resources.cpus * 1e9) : undefined,
      Memory: spec.resources?.memoryMb !== undefined ? spec.resources.memoryMb * 1024 * 1024 : undefined,
      PidsLimit: spec.resources?.pidsLimit,
      CapAdd: spec.capAdd?.length ? spec.capAdd : undefined,
      AutoRemove: spec.autoRemove ?? undefined,
      NetworkMode: networks[0],
    };

    const body: Record<string, unknown> = {
      Hostname: spec.hostname,
      User: spec.user,
      Image: spec.image,
      Cmd: spec.cmd,
      Entrypoint: spec.entrypoint,
      Env: env.length ? env : undefined,
      Labels: spec.labels && Object.keys(spec.labels).length ? spec.labels : undefined,
      WorkingDir: spec.workingDir,
      Tty: spec.tty ?? false,
      OpenStdin: spec.openStdin ?? false,
      AttachStdin: spec.openStdin ?? false,
      StdinOnce: false,
      ExposedPorts: Object.keys(exposedPorts).length ? exposedPorts : undefined,
      HostConfig: hostConfig,
    };

    if (networks.length > 1) {
      const endpoints: Record<string, Record<string, never>> = {};
      for (const n of networks.slice(1)) endpoints[n] = {};
      body.NetworkingConfig = { EndpointsConfig: endpoints };
    }

    for (const key of Object.keys(hostConfig)) {
      if (hostConfig[key] === undefined) delete hostConfig[key];
    }
    for (const key of Object.keys(body)) {
      if (body[key] === undefined) delete body[key];
    }
    return body;
  },

  /** labelFilters -> the JSON value of the docker `filters` query parameter */
  toLabelFilter(_labels: Record<string, string> | undefined, _extra?: Record<string, string[]>): string | undefined {
    const filters: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(_extra ?? {})) filters[k] = [...v];
    const labels = Object.entries(_labels ?? {}).map(([k, v]) => (v === '' ? k : `${k}=${v}`));
    if (labels.length) filters.label = [...(filters.label ?? []), ...labels];
    return Object.keys(filters).length ? JSON.stringify(filters) : undefined;
  },

  // --- response mapping (shared by both transports) -------------------------

  toContainerSummary(raw: Raw): ContainerSummary {
    const names: string[] = (raw.Names ?? []).map((n: string) => n.replace(/^\//, ''));
    return {
      id: raw.Id ?? '',
      name: names[0] ?? '',
      names,
      image: raw.Image ?? '',
      imageId: raw.ImageID ?? '',
      state: dockerMap.toState(raw.State),
      status: raw.Status ?? '',
      createdAt: typeof raw.Created === 'number' ? raw.Created : 0,
      labels: labelsOf(raw.Labels),
      ports: (raw.Ports ?? []).map(
        (p: Raw): PortBinding => ({
          containerPort: p.PrivatePort,
          hostPort: p.PublicPort || undefined,
          protocol: p.Type === 'udp' ? 'udp' : 'tcp',
          hostIp: p.IP || undefined,
        }),
      ),
    };
  },

  toContainerInspect(raw: Raw): ContainerInspect {
    const state = raw.State ?? {};
    const config = raw.Config ?? {};
    return {
      id: raw.Id ?? '',
      name: (raw.Name ?? '').replace(/^\//, ''),
      image: config.Image ?? '',
      imageId: raw.Image ?? '',
      state: dockerMap.toState(state.Status),
      running: !!state.Running,
      createdAt: raw.Created ?? undefined,
      startedAt: state.StartedAt ?? undefined,
      finishedAt: state.FinishedAt ?? undefined,
      exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : undefined,
      labels: labelsOf(config.Labels),
      env: Array.isArray(config.Env) ? [...config.Env] : [],
      mounts: (raw.Mounts ?? []).map(
        (m: Raw): MountInfo => ({
          type: m.Type ?? 'volume',
          source: m.Source || undefined,
          name: m.Name || undefined,
          destination: m.Destination ?? '',
          readOnly: m.RW === false,
        }),
      ),
      ports: dockerMap.toPortBindings(raw.NetworkSettings?.Ports),
      user: config.User || undefined,
      cmd: Array.isArray(config.Cmd) ? [...config.Cmd] : undefined,
      raw,
    };
  },

  /** NetworkSettings.Ports -> PortBinding[] */
  toPortBindings(ports: Raw | undefined): PortBinding[] {
    const out: PortBinding[] = [];
    for (const [key, list] of Object.entries(ports ?? {})) {
      const [portStr, protoStr] = key.split('/');
      const containerPort = Number(portStr);
      if (!Number.isFinite(containerPort)) continue;
      const protocol = protoStr === 'udp' ? 'udp' : 'tcp';
      const bindings = (list ?? []) as Array<{ HostIp?: string; HostPort?: string }>;
      if (!bindings.length) {
        out.push({ containerPort, protocol });
        continue;
      }
      for (const b of bindings) {
        out.push({
          containerPort,
          protocol,
          hostPort: b.HostPort ? Number(b.HostPort) : undefined,
          hostIp: b.HostIp || undefined,
        });
      }
    }
    return out;
  },

  toInfo(raw: Raw): DockerInfo {
    return {
      name: raw.Name ?? '',
      serverVersion: raw.ServerVersion ?? '',
      apiVersion: raw.ApiVersion ?? undefined,
      os: raw.OperatingSystem ?? '',
      osType: raw.OSType ?? undefined,
      architecture: raw.Architecture ?? '',
      ncpu: raw.NCPU ?? 0,
      memTotalBytes: raw.MemTotal ?? 0,
      containers: raw.Containers ?? 0,
      containersRunning: raw.ContainersRunning ?? 0,
      images: raw.Images ?? 0,
    };
  },

  toImageSummary(raw: Raw): ImageSummary {
    const tags: string[] = (raw.RepoTags ?? []).filter((t: string) => t && t !== '<none>:<none>');
    return {
      id: raw.Id ?? '',
      tags,
      createdAt: typeof raw.Created === 'number' ? raw.Created : 0,
      sizeBytes: raw.Size ?? 0,
      labels: labelsOf(raw.Labels),
    };
  },

  toImageInspect(raw: Raw): ImageInspect {
    const config = raw.Config ?? {};
    return {
      id: raw.Id ?? '',
      tags: (raw.RepoTags ?? []).filter((t: string) => t && t !== '<none>:<none>'),
      createdAt: raw.Created ?? '',
      sizeBytes: raw.Size ?? 0,
      labels: labelsOf(config.Labels),
      architecture: raw.Architecture ?? undefined,
      os: raw.Os ?? undefined,
      user: config.User || undefined,
      entrypoint: config.Entrypoint ?? undefined,
      cmd: config.Cmd ?? undefined,
      env: Array.isArray(config.Env) ? [...config.Env] : [],
      raw,
    };
  },

  toVolume(raw: Raw): VolumeSummary {
    return {
      name: raw.Name ?? '',
      driver: raw.Driver ?? 'local',
      mountpoint: raw.Mountpoint ?? undefined,
      labels: labelsOf(raw.Labels),
      createdAt: raw.CreatedAt ?? undefined,
    };
  },

  toNetwork(raw: Raw): NetworkSummary {
    return {
      id: raw.Id ?? '',
      name: raw.Name ?? '',
      driver: raw.Driver ?? '',
      scope: raw.Scope ?? '',
      internal: !!raw.Internal,
      labels: labelsOf(raw.Labels),
    };
  },

  /** ExecSpec -> docker POST /containers/{id}/exec body */
  toExecBody(spec: ExecSpec): Record<string, unknown> {
    const body: Record<string, unknown> = {
      Cmd: spec.cmd,
      Tty: spec.tty ?? false,
      AttachStdin: spec.attachStdin ?? true,
      AttachStdout: spec.attachStdout ?? true,
      AttachStderr: spec.attachStderr ?? true,
    };
    const env = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`);
    if (env.length) body.Env = env;
    if (spec.workingDir) body.WorkingDir = spec.workingDir;
    if (spec.user) body.User = spec.user;
    return body;
  },
};

// ---------------------------------------------------------------------------
// SocketBackend
// ---------------------------------------------------------------------------

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
    if (!socketPath) return false;
    if (socketPath.startsWith('\\\\.\\pipe\\') || socketPath.startsWith('//./pipe/')) return true;
    try {
      const st = await fs.stat(socketPath);
      return st.isSocket();
    } catch {
      return false;
    }
  }

  private async call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toDockerApiError(err, what);
    }
  }

  async ping(): Promise<void> {
    await this.call('docker ping', () => this.docker.ping());
  }

  async info(): Promise<DockerInfo> {
    const raw = await this.call('docker info', () => this.docker.info());
    return dockerMap.toInfo(raw as Raw);
  }

  async listContainers(opts?: ListContainersOptions): Promise<ContainerSummary[]> {
    const filters = dockerMap.toLabelFilter(opts?.labelFilters);
    const query: Docker.ContainerListOptions = { all: opts?.all ?? true, ...(filters ? { filters } : {}) };
    const raw = await this.call('list containers', () => this.docker.listContainers(query));
    return (raw as unknown as Raw[]).map((r) => dockerMap.toContainerSummary(r));
  }

  async inspectContainer(id: string): Promise<ContainerInspect> {
    const raw = await this.call(`inspect container ${id}`, () => this.docker.getContainer(id).inspect());
    return dockerMap.toContainerInspect(raw as unknown as Raw);
  }

  async createContainer(spec: CreateContainerSpec): Promise<{ id: string; warnings: string[] }> {
    const body = { ...dockerMap.toCreateBody(spec), name: spec.name } as Docker.ContainerCreateOptions;
    const created = await this.call(`create container ${spec.name}`, () => this.docker.createContainer(body));
    const raw = created as unknown as Raw;
    return { id: created.id, warnings: raw?.Warnings ?? [] };
  }

  async startContainer(id: string): Promise<void> {
    await this.call(`start container ${id}`, () => this.docker.getContainer(id).start());
  }

  async stopContainer(id: string, opts?: { timeoutSec?: number }): Promise<void> {
    try {
      await this.docker.getContainer(id).stop({ t: opts?.timeoutSec ?? 5 });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 304) return; // already stopped
      throw toDockerApiError(err, `stop container ${id}`);
    }
  }

  async restartContainer(id: string, opts?: { timeoutSec?: number }): Promise<void> {
    await this.call(`restart container ${id}`, () => this.docker.getContainer(id).restart({ t: opts?.timeoutSec ?? 5 }));
  }

  async removeContainer(id: string, opts?: { force?: boolean; removeVolumes?: boolean }): Promise<void> {
    await this.call(`remove container ${id}`, () =>
      this.docker.getContainer(id).remove({ force: opts?.force ?? true, v: opts?.removeVolumes ?? false }),
    );
  }

  async waitContainer(id: string): Promise<{ statusCode: number }> {
    const res = await this.call(`wait container ${id}`, () => this.docker.getContainer(id).wait());
    return { statusCode: (res as Raw)?.StatusCode ?? 0 };
  }

  async containerLogs(id: string, opts?: LogsOptions): Promise<string> {
    const buf = await this.call(`logs of container ${id}`, () =>
      this.docker.getContainer(id).logs({
        follow: false,
        stdout: opts?.stdout ?? true,
        stderr: opts?.stderr ?? true,
        tail: opts?.tail ?? 200,
        timestamps: opts?.timestamps ?? false,
        ...(opts?.since ? { since: opts.since } : {}),
      }),
    );
    return decodeDockerStream(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8'));
  }

  async getArchive(containerId: string, path: string): Promise<Readable> {
    const stream = await this.call(`read ${path} from container ${containerId}`, () =>
      this.docker.getContainer(containerId).getArchive({ path }),
    );
    return stream as unknown as Readable;
  }

  async putArchive(
    containerId: string,
    path: string,
    tar: Readable,
    opts?: { noOverwriteDirNonDir?: boolean },
  ): Promise<void> {
    await this.call(`write ${path} into container ${containerId}`, () =>
      // @types/dockerode types the options as `{}`; the engine reads path/noOverwriteDirNonDir
      this.docker.getContainer(containerId).putArchive(tar as unknown as NodeJS.ReadableStream, {
        path,
        ...(opts?.noOverwriteDirNonDir ? { noOverwriteDirNonDir: 'true' } : {}),
      }),
    );
  }

  async execCreate(spec: ExecSpec): Promise<{ execId: string }> {
    const exec = await this.call(`create exec in ${spec.containerId}`, () =>
      this.docker.getContainer(spec.containerId).exec(dockerMap.toExecBody(spec) as Docker.ExecCreateOptions),
    );
    return { execId: exec.id };
  }

  async execStart(execId: string, opts: { tty: boolean; stdin: boolean }): Promise<ExecStream> {
    const stream = await this.call(`start exec ${execId}`, () =>
      this.docker.getExec(execId).start({ hijack: true, stdin: opts.stdin, Tty: opts.tty }),
    );
    return new SocketExecStream(execId, stream as unknown as NodeJS.ReadWriteStream, (s) => this.execResize(execId, s), opts.tty);
  }

  async execResize(execId: string, size: TerminalSize): Promise<void> {
    await this.call(`resize exec ${execId}`, () => this.docker.getExec(execId).resize({ h: size.rows, w: size.cols }));
  }

  async execInspect(execId: string): Promise<{ running: boolean; exitCode: number | null; pid: number }> {
    const raw = (await this.call(`inspect exec ${execId}`, () => this.docker.getExec(execId).inspect())) as unknown as Raw;
    return {
      running: !!raw.Running,
      exitCode: typeof raw.ExitCode === 'number' ? raw.ExitCode : null,
      pid: raw.Pid ?? 0,
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
    const stream = (await this.call(`start exec ${execId}`, () =>
      this.docker.getExec(execId).start({ hijack: true, stdin: false, Tty: false }),
    )) as unknown as NodeJS.ReadableStream;

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const feed = createDemuxer((chunk, which) => {
      (which === 'stderr' ? err : out).push(Buffer.from(chunk));
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        (stream as unknown as { destroy?: () => void }).destroy?.();
        resolve();
      }, opts?.timeoutMs ?? 15_000);
      stream.on('data', (d: Buffer) => feed(Buffer.from(d)));
      stream.on('error', (e: Error) => {
        clearTimeout(timer);
        reject(toDockerApiError(e, `exec in ${containerId}`));
      });
      stream.on('end', () => {
        clearTimeout(timer);
        resolve();
      });
      stream.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    let exitCode = 0;
    try {
      const info = await this.execInspect(execId);
      exitCode = info.exitCode ?? 0;
    } catch {
      exitCode = 0;
    }
    return { exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
  }

  async listImages(opts?: { all?: boolean; labelFilters?: Record<string, string> }): Promise<ImageSummary[]> {
    const filters = dockerMap.toLabelFilter(opts?.labelFilters);
    const query: Docker.ListImagesOptions = { all: opts?.all ?? false, ...(filters ? { filters } : {}) };
    const raw = await this.call('list images', () => this.docker.listImages(query));
    return (raw as unknown as Raw[]).map((r) => dockerMap.toImageSummary(r));
  }

  async inspectImage(ref: string): Promise<ImageInspect | null> {
    try {
      const raw = await this.docker.getImage(ref).inspect();
      return dockerMap.toImageInspect(raw as unknown as Raw);
    } catch (err) {
      const e = toDockerApiError(err, `inspect image ${ref}`);
      if (e.dockerStatus === 404) return null;
      throw e;
    }
  }

  async pullImage(ref: string, opts?: PullOptions): Promise<void> {
    const stream = (await this.call(`pull image ${ref}`, () =>
      this.docker.pull(ref, opts?.platform ? { platform: opts.platform } : {}),
    )) as unknown as NodeJS.ReadableStream;
    await consumeJsonLineStream(stream, opts?.onLog, opts?.signal, `pull image ${ref}`);
  }

  async removeImage(ref: string, opts?: { force?: boolean }): Promise<void> {
    await this.call(`remove image ${ref}`, () => this.docker.getImage(ref).remove({ force: opts?.force ?? false }));
  }

  async buildImage(opts: BuildOptions): Promise<void> {
    const query: Record<string, string> = { t: opts.tag, dockerfile: opts.dockerfile ?? 'Dockerfile' };
    if (opts.noCache) query.nocache = '1';
    if (opts.pull) query.pull = '1';
    if (opts.platform) query.platform = opts.platform;
    if (opts.labels && Object.keys(opts.labels).length) query.labels = JSON.stringify(opts.labels);
    if (opts.buildArgs && Object.keys(opts.buildArgs).length) query.buildargs = JSON.stringify(opts.buildArgs);

    const stream = (await this.call(`build image ${opts.tag}`, () =>
      this.docker.buildImage(opts.context as unknown as NodeJS.ReadableStream, query as Docker.ImageBuildOptions),
    )) as unknown as NodeJS.ReadableStream;
    await consumeJsonLineStream(stream, opts.onLog, opts.signal, `build image ${opts.tag}`);
  }

  async listVolumes(): Promise<VolumeSummary[]> {
    const raw = (await this.call('list volumes', () => this.docker.listVolumes())) as unknown as Raw;
    return (raw?.Volumes ?? []).map((v: Raw) => dockerMap.toVolume(v));
  }

  async createVolume(spec: { name: string; labels?: Record<string, string>; driver?: string }): Promise<VolumeSummary> {
    const raw = await this.call(`create volume ${spec.name}`, () =>
      this.docker.createVolume({ Name: spec.name, Labels: spec.labels, Driver: spec.driver ?? 'local' }),
    );
    return dockerMap.toVolume(raw as unknown as Raw);
  }

  async removeVolume(name: string, opts?: { force?: boolean }): Promise<void> {
    await this.call(`remove volume ${name}`, () => this.docker.getVolume(name).remove({ force: opts?.force ?? false }));
  }

  async listNetworks(): Promise<NetworkSummary[]> {
    const raw = await this.call('list networks', () => this.docker.listNetworks());
    return (raw as unknown as Raw[]).map((n) => dockerMap.toNetwork(n));
  }

  async close(): Promise<void> { /* dockerode holds no persistent agent we own */ }
}

/** Read a docker JSON-lines progress stream to the end, reporting every decoded line. */
export async function consumeJsonLineStream(
  stream: NodeJS.ReadableStream,
  onLog: ((line: BuildLogLine) => void) | undefined,
  signal: AbortSignal | undefined,
  what: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let pending = '';
    let failed: Error | null = null;

    const onAbort = () => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      failed = new DockerApiError(`${what}: cancelled`);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const emit = (text: string) => {
      for (const line of parseJsonLines(text)) {
        if (line.error) failed = new DockerApiError(`${what}: ${line.error}`);
        onLog?.(line);
      }
    };

    stream.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      if (parts.length) emit(parts.join('\n'));
    });
    stream.on('error', (err: Error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(toDockerApiError(err, what));
    });
    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort);
      if (pending.trim()) emit(pending);
      if (failed) reject(failed);
      else resolve();
    });
  });
}

/** ExecStream over a hijacked docker socket duplex. */
export class SocketExecStream implements ExecStream {
  readonly execId: string;
  private dataCb: ((chunk: Uint8Array, stream: 'stdout' | 'stderr') => void) | null = null;
  private closeCb: ((info: { code?: number; reason?: string }) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;
  private closed = false;
  private readonly feed: (data: Buffer) => void;

  constructor(
    execId: string,
    private readonly stream: NodeJS.ReadWriteStream,
    private readonly resizeFn: (s: TerminalSize) => Promise<void>,
    private readonly tty: boolean,
  ) {
    this.execId = execId;
    const demux = createDemuxer((chunk, which) => this.dataCb?.(chunk, which));
    this.feed = (data: Buffer) => {
      if (this.tty) this.dataCb?.(new Uint8Array(data), 'stdout');
      else demux(data);
    };

    this.stream.on('data', (d: Buffer) => this.feed(Buffer.from(d)));
    this.stream.on('error', (err: Error) => this.errorCb?.(err));
    const finish = () => {
      if (this.closed) return;
      this.closed = true;
      this.closeCb?.({});
    };
    this.stream.on('end', finish);
    (this.stream as unknown as NodeJS.EventEmitter).on('close', finish);
  }

  write(data: Uint8Array | string): void {
    if (this.closed) return;
    this.stream.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data));
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
      (this.stream as unknown as { end?: () => void }).end?.();
      (this.stream as unknown as { destroy?: () => void }).destroy?.();
    } catch {
      // already gone
    }
  }
}
