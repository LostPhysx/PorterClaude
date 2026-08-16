// OWNER: B1. The mapping layer shared by both docker transports + BackendManager wiring.
import { describe, it, expect, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import {
  createDemuxer,
  decodeDockerStream,
  dockerMap,
  parseJsonLines,
  SocketBackend,
} from '../../src/backends/socket.js';
import { PortainerBackend, splitImageRef } from '../../src/backends/portainer.js';
import type { CreateContainerSpec, DockerBackend } from '../../src/backends/types.js';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true });
});

function frame(type: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

const spec: CreateContainerSpec = {
  name: 'pc-web',
  image: 'porterclaude/node:latest',
  cmd: ['sleep', 'infinity'],
  entrypoint: ['/opt/porterclaude/entrypoint.sh'],
  env: { PORTERCLAUDE_SESSION: 'web', TERM: 'xterm-256color' },
  labels: { 'porterclaude.managed': 'true', 'porterclaude.session': 'web' },
  workingDir: '/workspace',
  user: '1000:1000',
  init: true,
  mounts: [
    { type: 'volume', source: 'porterclaude-claude', target: '/home/dev/.claude' },
    { type: 'volume', source: 'porterclaude-tools', target: '/opt/porterclaude', readOnly: true },
    { type: 'bind', source: '/srv/ws', target: '/workspace' },
  ],
  ports: [{ containerPort: 3000, hostPort: 3000 }, { containerPort: 8080 }],
  restartPolicy: 'unless-stopped',
  resources: { cpus: 1.5, memoryMb: 2048, pidsLimit: 4096 },
  networks: ['pc-net', 'extra-net'],
};

describe('dockerMap', () => {
  it('maps docker states, defaulting to unknown', () => {
    expect(dockerMap.toState('running')).toBe('running');
    expect(dockerMap.toState('Exited')).toBe('exited');
    expect(dockerMap.toState(undefined)).toBe('unknown');
    expect(dockerMap.toState('weird')).toBe('unknown');
  });

  it('translates a CreateContainerSpec into the docker create body', () => {
    const body = dockerMap.toCreateBody(spec) as Record<string, any>;
    expect(body.Image).toBe('porterclaude/node:latest');
    expect(body.Cmd).toEqual(['sleep', 'infinity']);
    expect(body.Entrypoint).toEqual(['/opt/porterclaude/entrypoint.sh']);
    expect(body.Env).toContain('PORTERCLAUDE_SESSION=web');
    expect(body.WorkingDir).toBe('/workspace');
    expect(body.User).toBe('1000:1000');
    expect(body.ExposedPorts).toEqual({ '3000/tcp': {}, '8080/tcp': {} });

    const hc = body.HostConfig as Record<string, any>;
    expect(hc.Init).toBe(true);
    expect(hc.RestartPolicy).toEqual({ Name: 'unless-stopped' });
    expect(hc.NanoCpus).toBe(1_500_000_000);
    expect(hc.Memory).toBe(2048 * 1024 * 1024);
    expect(hc.PidsLimit).toBe(4096);
    expect(hc.NetworkMode).toBe('pc-net');
    expect(hc.Mounts).toEqual([
      { Type: 'volume', Target: '/home/dev/.claude', ReadOnly: false, Source: 'porterclaude-claude' },
      { Type: 'volume', Target: '/opt/porterclaude', ReadOnly: true, Source: 'porterclaude-tools' },
      { Type: 'bind', Target: '/workspace', ReadOnly: false, Source: '/srv/ws' },
    ]);
    // an omitted hostPort means "docker picks one"
    expect(hc.PortBindings['8080/tcp']).toEqual([{ HostIp: '', HostPort: '' }]);
    expect(hc.PortBindings['3000/tcp']).toEqual([{ HostIp: '', HostPort: '3000' }]);
    expect(body.NetworkingConfig).toEqual({ EndpointsConfig: { 'extra-net': {} } });
  });

  it('omits everything that was not asked for', () => {
    const body = dockerMap.toCreateBody({ name: 'pc-x', image: 'alpine' }) as Record<string, any>;
    expect(body.Cmd).toBeUndefined();
    expect(body.Entrypoint).toBeUndefined();
    expect(body.Env).toBeUndefined();
    expect(body.ExposedPorts).toBeUndefined();
    expect(body.HostConfig.Mounts).toBeUndefined();
    expect(body.HostConfig.RestartPolicy).toEqual({ Name: 'no' });
  });

  it('builds docker label filters', () => {
    expect(dockerMap.toLabelFilter(undefined)).toBeUndefined();
    expect(dockerMap.toLabelFilter({ 'porterclaude.managed': 'true' })).toBe('{"label":["porterclaude.managed=true"]}');
    expect(dockerMap.toLabelFilter({ 'porterclaude.managed': '' })).toBe('{"label":["porterclaude.managed"]}');
    expect(dockerMap.toLabelFilter({ a: '1' }, { status: ['running'] })).toBe('{"status":["running"],"label":["a=1"]}');
  });

  it('maps container summaries and inspects', () => {
    const summary = dockerMap.toContainerSummary({
      Id: 'abc',
      Names: ['/pc-web'],
      Image: 'porterclaude/node:latest',
      ImageID: 'sha256:1',
      State: 'running',
      Status: 'Up 3 hours',
      Created: 1700000000,
      Labels: { 'porterclaude.session': 'web' },
      Ports: [{ IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 32768, Type: 'tcp' }],
    });
    expect(summary.name).toBe('pc-web');
    expect(summary.state).toBe('running');
    expect(summary.ports[0]).toEqual({ containerPort: 3000, hostPort: 32768, protocol: 'tcp', hostIp: '0.0.0.0' });

    const inspect = dockerMap.toContainerInspect({
      Id: 'abc',
      Name: '/pc-web',
      Image: 'sha256:1',
      Created: '2026-08-15T10:00:00Z',
      Config: { Image: 'porterclaude/node:latest', Labels: { a: 'b' }, Env: ['A=B'], User: 'dev' },
      State: { Status: 'running', Running: true, StartedAt: '2026-08-15T10:00:01Z', ExitCode: 0 },
      Mounts: [{ Type: 'volume', Name: 'porterclaude-ws-web', Destination: '/workspace', RW: true }],
      NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '32768' }], '9000/tcp': null } },
    });
    expect(inspect.running).toBe(true);
    expect(inspect.name).toBe('pc-web');
    expect(inspect.mounts[0]?.name).toBe('porterclaude-ws-web');
    expect(inspect.ports).toEqual([
      { containerPort: 3000, protocol: 'tcp', hostPort: 32768, hostIp: '0.0.0.0' },
      { containerPort: 9000, protocol: 'tcp' },
    ]);
  });

  it('maps info, images, volumes and networks', () => {
    expect(
      dockerMap.toInfo({ Name: 'host', ServerVersion: '29.1.3', OperatingSystem: 'Ubuntu 24.04', Architecture: 'aarch64', NCPU: 4, MemTotal: 100, Containers: 2, ContainersRunning: 1, Images: 3 }),
    ).toMatchObject({ name: 'host', serverVersion: '29.1.3', architecture: 'aarch64', ncpu: 4 });
    expect(dockerMap.toImageSummary({ Id: 'sha256:x', RepoTags: ['<none>:<none>', 'a:1'], Created: 1, Size: 2 }).tags).toEqual(['a:1']);
    expect(dockerMap.toVolume({ Name: 'v', Driver: 'local' }).name).toBe('v');
    expect(dockerMap.toNetwork({ Id: 'n', Name: 'bridge', Driver: 'bridge', Scope: 'local' }).name).toBe('bridge');
  });

  it('builds the exec body', () => {
    const body = dockerMap.toExecBody({
      containerId: 'abc',
      cmd: ['sh', '-lc', 'echo hi'],
      tty: true,
      env: { TERM: 'xterm-256color' },
      workingDir: '/workspace',
      user: 'dev',
    }) as Record<string, any>;
    expect(body).toMatchObject({
      Cmd: ['sh', '-lc', 'echo hi'],
      Tty: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Env: ['TERM=xterm-256color'],
      WorkingDir: '/workspace',
      User: 'dev',
    });
  });
});

describe('docker stream helpers', () => {
  it('demultiplexes frames split across chunks', () => {
    const chunks: Array<[string, string]> = [];
    const feed = createDemuxer((c, which) => chunks.push([which, Buffer.from(c).toString('utf8')]));
    const buf = Buffer.concat([frame(1, 'hello '), frame(2, 'oops'), frame(1, 'world')]);
    feed(buf.subarray(0, 5));
    feed(buf.subarray(5, 20));
    feed(buf.subarray(20));
    expect(chunks).toEqual([
      ['stdout', 'hello '],
      ['stderr', 'oops'],
      ['stdout', 'world'],
    ]);
  });

  it('decodes multiplexed and raw payloads alike', () => {
    expect(decodeDockerStream(Buffer.concat([frame(1, 'a'), frame(2, 'b')]))).toBe('ab');
    expect(decodeDockerStream(Buffer.from('plain tty output', 'utf8'))).toBe('plain tty output');
  });

  it('parses docker json-lines, tolerating garbage', () => {
    expect(parseJsonLines('{"stream":"Step 1/2"}\n\n{"error":"boom"}\nnot json')).toEqual([
      { stream: 'Step 1/2' },
      { error: 'boom' },
      { stream: 'not json' },
    ]);
  });

  it('splits image refs', () => {
    expect(splitImageRef('nginx')).toEqual(['nginx', 'latest']);
    expect(splitImageRef('nginx:1.27')).toEqual(['nginx', '1.27']);
    expect(splitImageRef('registry.example.com:5000/team/app')).toEqual(['registry.example.com:5000/team/app', 'latest']);
    expect(splitImageRef('registry.example.com:5000/team/app:v2')).toEqual(['registry.example.com:5000/team/app', 'v2']);
  });
});

describe('both backends implement the DockerBackend surface', () => {
  const members: Array<keyof DockerBackend> = [
    'ping', 'info', 'listContainers', 'inspectContainer', 'createContainer', 'startContainer',
    'stopContainer', 'restartContainer', 'removeContainer', 'waitContainer', 'containerLogs',
    'execCreate', 'execStart', 'execResize', 'execInspect', 'runExec', 'listImages',
    'inspectImage', 'pullImage', 'removeImage', 'buildImage', 'listVolumes', 'createVolume',
    'removeVolume', 'listNetworks', 'close',
  ];

  it('exposes every member on both implementations', () => {
    const socket: DockerBackend = new SocketBackend({ socketPath: '/var/run/docker.sock' });
    const portainer: DockerBackend = new PortainerBackend({ url: 'https://p.example.com', apiKey: 'k', endpointId: 2 });
    for (const m of members) {
      expect(typeof socket[m]).toBe('function');
      expect(typeof portainer[m]).toBe('function');
    }
    expect(socket.kind).toBe('socket');
    expect(socket.id).toBe('socket:/var/run/docker.sock');
    expect(portainer.kind).toBe('portainer');
    expect(portainer.id).toBe('portainer:https://p.example.com#2');
  });

  it('SocketBackend.isAvailable is false for a path that is not a socket', async () => {
    await expect(SocketBackend.isAvailable('/definitely/not/here.sock')).resolves.toBe(false);
    await expect(SocketBackend.isAvailable('')).resolves.toBe(false);
  });
});

// TODO(B1): the v0.1 `BackendManager` suite lived here. Rewrite it against HostManager:
//   * no host configured           -> backendFor() throws backend_not_configured (409),
//                                     tryBackendFor() is null, isConfigured() is false;
//   * one socket host + one portainer host  -> two DIFFERENT cached instances, and
//     backendFor() returns the same instance on a second call;
//   * changing host A's connection invalidates ONLY A (invalidateChanged() returns ['a']),
//     a PUT /api/settings/ui write invalidates nothing;
//   * an unimplemented connection type (tcp/ssh) -> not_implemented (501);
//   * testConnection() never throws and never echoes the api key (grep the JSON).

/**
 * PortainerBackend.startContainer falls back to /restart.
 *
 * Portainer's docker proxy re-encodes POST /containers/{id}/start so the engine sees a
 * non-empty body and answers 400 (verified live against EE 2.39.5 / Docker 29.1.3 with
 * every body variant, including none). /restart returns 204 and starts a created/exited
 * container, so the Portainer transport falls back to it. SocketBackend keeps plain /start.
 */
describe('PortainerBackend.startContainer', () => {
  async function withFakePortainer(
    handler: (path: string, res: import('node:http').ServerResponse) => void,
    run: (backend: PortainerBackend) => Promise<void>,
  ): Promise<string[]> {
    const http = await import('node:http');
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
      handler(req.url ?? '', res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const backend = new PortainerBackend({
      url: `http://127.0.0.1:${port}`, apiKey: 'k', endpointId: 2, timeoutMs: 5000,
    });
    try {
      await run(backend);
    } finally {
      await backend.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return seen;
  }

  const NON_EMPTY_BODY = JSON.stringify({
    message: 'starting container with non-empty request body was deprecated since API v1.22 '
      + 'and removed in v1.24',
  });

  it('retries with /restart when the engine rejects /start with the non-empty-body 400', async () => {
    const seen = await withFakePortainer(
      (url, res) => {
        if (url.endsWith('/start')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(NON_EMPTY_BODY);
          return;
        }
        res.writeHead(204).end();
      },
      async (backend) => {
        await expect(backend.startContainer('pc-x')).resolves.toBeUndefined();
      },
    );
    expect(seen.some((s) => s.endsWith('/containers/pc-x/start'))).toBe(true);
    expect(seen.some((s) => s.endsWith('/containers/pc-x/restart'))).toBe(true);
  });

  it('does not call /restart when /start succeeds', async () => {
    const seen = await withFakePortainer(
      (_url, res) => { res.writeHead(204).end(); },
      async (backend) => { await backend.startContainer('pc-x'); },
    );
    expect(seen.filter((s) => s.includes('/restart'))).toHaveLength(0);
  });

  it('rethrows a 400 that is not the non-empty-body case', async () => {
    const seen = await withFakePortainer(
      (_url, res) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'no such container' }));
      },
      async (backend) => {
        await expect(backend.startContainer('pc-x')).rejects.toThrow(/no such container/);
      },
    );
    expect(seen.filter((s) => s.includes('/restart'))).toHaveLength(0);
  });
});

/**
 * Regression (QA BE-1): BackendManager.invalidate() closes the previous PortainerBackend
 * while ImageService jobs still hold it. `https.Agent.destroy()` kills sockets that are
 * IN USE too, so an eager destroy aborted running builds/pulls with "socket hang up" /
 * "aborted". close() must therefore only park the agent and destroy it once idle.
 */
describe('PortainerBackend.close() and in-flight streams', () => {
  it('does not abort a running pull, and still frees the socket afterwards', async () => {
    const http = await import('node:http');
    const sockets: import('node:net').Socket[] = [];
    let release = (): void => {};

    const server = http.createServer((req, res) => {
      if (!(req.url ?? '').includes('/images/create')) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(`${JSON.stringify({ status: 'Pulling from library/alpine' })}\n`);
      // finish only once the test says so (after close() has been called)
      release = () => {
        res.write(`${JSON.stringify({ status: 'Download complete' })}\n`);
        res.end();
      };
    });
    server.on('connection', (s) => sockets.push(s));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const backend = new PortainerBackend({
      url: `http://127.0.0.1:${port}`, apiKey: 'k', endpointId: 2, timeoutMs: 5000,
    });
    try {
      const logs: string[] = [];
      const pull = backend.pullImage('alpine:3.20', { onLog: (l) => logs.push(JSON.stringify(l)) });

      // wait until the stream is established and the first progress line arrived
      const deadline = Date.now() + 5000;
      while (logs.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(logs.length).toBeGreaterThan(0);

      // this is what a PUT /api/settings/ui triggers via BackendManager.invalidate()
      await backend.close();
      await new Promise((r) => setTimeout(r, 50));

      release();
      await expect(pull).resolves.toBeUndefined();
      expect(logs.join('\n')).toContain('Download complete');

      // ... and the parked agent is destroyed once nothing is in flight
      const closedDeadline = Date.now() + 5000;
      while (sockets.some((s) => !s.destroyed) && Date.now() < closedDeadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(sockets.every((s) => s.destroyed)).toBe(true);
    } finally {
      await backend.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const s of sockets) s.destroy();
    }
  }, 20_000);

  it('is usable again after close() (a fresh agent is created)', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ID: 'x', Name: 'fake', ServerVersion: '29.1.3', OperatingSystem: 'linux', Architecture: 'aarch64', NCPU: 4, MemTotal: 1024, Containers: 0, ContainersRunning: 0, Images: 0 }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const backend = new PortainerBackend({
      url: `http://127.0.0.1:${port}`, apiKey: 'k', endpointId: 2, timeoutMs: 5000,
    });
    try {
      await backend.info();
      await backend.close();
      await expect(backend.info()).resolves.toBeTruthy();
    } finally {
      await backend.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
