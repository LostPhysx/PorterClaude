// OWNER: B1. The mapping layer shared by both docker transports + the per-host transport
// cache of HostManager (v0.2 replacement of the single global BackendManager).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { buildContext } from './helpers.js';
import { AppError } from '../../src/http/errors.js';
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
  labels: { 'porterclaude.managed': 'true', 'porterclaude.container': 'web' },
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
      Labels: { 'porterclaude.container': 'web' },
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

describe('HostManager transports', () => {
  const API_KEY = 'ptr_supersecret_0abc';

  async function harness(): Promise<Awaited<ReturnType<typeof buildContext>>> {
    const built = await buildContext();
    dirs.push(built.dataDir);
    return built;
  }

  it('has nothing to hand out while no host is configured', async () => {
    const { ctx } = await harness();
    expect(ctx.hosts.isConfigured()).toBe(false);
    expect(ctx.hosts.list()).toEqual([]);
    expect(ctx.hosts.defaultHostId()).toBeNull();

    try {
      ctx.hosts.requireHostId();
      expect.unreachable('requireHostId() must throw without a host');
    } catch (err) {
      expect((err as AppError).code).toBe('backend_not_configured');
      expect((err as AppError).status).toBe(409);
    }
    expect(() => ctx.hosts.backendFor('default')).toThrow(/does not exist/);
    expect(ctx.hosts.tryBackendFor('default')).toBeNull();
    expect(ctx.backends.tryGet()).toBeNull();
    expect(() => ctx.backends.get()).toThrow();
  });

  it('caches ONE transport per host and hands out the same instance twice', async () => {
    const { ctx } = await harness();
    await ctx.credentials.create({ name: 'P', url: 'https://portainer.example.com', apiKey: API_KEY });
    await ctx.hosts.create({ name: 'Local', connection: { type: 'socket', socketPath: '/x.sock' } });
    await ctx.hosts.create({
      name: 'Prod',
      connection: { type: 'portainer', credentialId: 'portainer-1', endpointId: 2 },
    });

    const local = ctx.hosts.backendFor('local');
    const prod = ctx.hosts.backendFor('prod');
    expect(local).toBe(ctx.hosts.backendFor('local'));
    expect(prod).toBe(ctx.hosts.backendFor('prod'));
    expect(local).not.toBe(prod);
    expect(local.id).toBe('socket:/x.sock');
    expect(prod.id).toBe('portainer:https://portainer.example.com#2');
    expect(ctx.hosts.isConfigured()).toBe(true);
    // the default host is what the v0.1 compatibility shim resolves to
    expect(ctx.backends.get()).toBe(local);
    await ctx.hosts.close();
  });

  it('drops only the host that really changed', async () => {
    const { ctx } = await harness();
    await ctx.credentials.create({ name: 'P', url: 'https://portainer.example.com', apiKey: API_KEY });
    await ctx.hosts.create({ name: 'Local', connection: { type: 'socket', socketPath: '/x.sock' } });
    await ctx.hosts.create({
      name: 'Prod',
      connection: { type: 'portainer', credentialId: 'portainer-1', endpointId: 2 },
    });

    const local = ctx.hosts.backendFor('local');
    const prod = ctx.hosts.backendFor('prod');

    // a UI layout autosave must not tear down a transport that carries running builds
    const spy = vi.spyOn(ctx.hosts, 'invalidateChanged');
    await ctx.config.update((draft) => {
      draft.ui.layout = { savedAt: 1 };
    });
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.results.map((r) => r.value)).toEqual([[]]);
    expect(ctx.hosts.backendFor('local')).toBe(local);
    expect(ctx.hosts.backendFor('prod')).toBe(prod);
    spy.mockRestore();

    // changing the connection of one host rebuilds exactly that one
    await ctx.hosts.update('local', { connection: { type: 'socket', socketPath: '/y.sock' } });
    const local2 = ctx.hosts.backendFor('local');
    expect(local2).not.toBe(local);
    expect(local2.id).toBe('socket:/y.sock');
    expect(ctx.hosts.backendFor('prod')).toBe(prod);

    // ... and so does rotating the credential a host uses
    await ctx.credentials.update('portainer-1', { apiKey: 'ptr_rotated_1def' });
    const prod2 = ctx.hosts.backendFor('prod');
    expect(prod2).not.toBe(prod);
    expect(ctx.hosts.backendFor('local')).toBe(local2);
    await ctx.hosts.close();
  });

  it('refuses a reserved connection type with not_implemented (501)', async () => {
    const { ctx } = await harness();
    await ctx.hosts.create({
      name: 'Future',
      connection: { type: 'tcp', url: 'tcp://10.0.0.5:2376', credentialId: null, insecureTls: false },
    });
    await ctx.hosts.create({
      name: 'Remote',
      connection: { type: 'ssh', url: 'ssh://root@10.0.0.5', credentialId: null, socketPath: '/var/run/docker.sock' },
    });
    for (const id of ['future', 'remote']) {
      try {
        ctx.hosts.backendFor(id);
        expect.unreachable(`backendFor('${id}') must throw`);
      } catch (err) {
        expect((err as AppError).code).toBe('not_implemented');
        expect((err as AppError).status).toBe(501);
      }
      const view = await ctx.hosts.view(id, { probe: true });
      expect(view.supported).toBe(false);
      expect(view.status).toBe('not_configured');
    }
    expect(ctx.hosts.isConfigured()).toBe(false);
  });

  it('reports an incomplete portainer connection as backend_not_configured', async () => {
    const { ctx } = await harness();
    const now = new Date().toISOString();
    await ctx.config.putHost({
      id: 'broken',
      name: 'Broken',
      connection: { type: 'portainer', credentialId: 'gone', endpointId: 1 },
      overrides: {},
      agents: { enabled: ['claude'] },
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    try {
      ctx.hosts.backendFor('broken');
      expect.unreachable('an unresolvable credential must throw');
    } catch (err) {
      expect((err as AppError).code).toBe('backend_not_configured');
    }
    const view = await ctx.hosts.view('broken', { probe: true });
    expect(view.status).toBe('not_configured');
    expect(view.error).toContain('gone');
  });

  it('never throws (and never echoes the api key) from a failing test()', async () => {
    const { ctx } = await harness();
    await ctx.credentials.create({ name: 'P', url: 'http://127.0.0.1:1', apiKey: API_KEY });
    await ctx.hosts.create({
      name: 'Prod',
      connection: { type: 'portainer', credentialId: 'portainer-1', endpointId: 2 },
    });
    await ctx.hosts.create({ name: 'Local', connection: { type: 'socket', socketPath: '/nope.sock' } });

    for (const id of ['prod', 'local']) {
      const result = await ctx.hosts.test(id);
      expect(result.ok).toBe(false);
      expect(typeof result.error?.message).toBe('string');
      expect(JSON.stringify(result)).not.toContain(API_KEY);
    }

    const unsaved = await ctx.hosts.testConnection({ type: 'socket', socketPath: '/nope.sock' });
    expect(unsaved.ok).toBe(false);
    expect(JSON.stringify(await ctx.hosts.views({ probe: true }))).not.toContain(API_KEY);
    await ctx.hosts.close();
  });

  it('merges the general settings with the host overrides', async () => {
    const { ctx } = await harness();
    await ctx.hosts.create({
      name: 'Local',
      connection: { type: 'socket', socketPath: '/x.sock' },
      overrides: { workspacesRoot: '/srv/other', volumePrefix: 'pc2-' },
    });
    const settings = ctx.hosts.settingsFor('local');
    expect(settings.workspacesRoot).toBe('/srv/other');
    expect(settings.volumePrefix).toBe('pc2-');
    expect(settings.toolsMount).toBe(ctx.config.general().toolsMount);
    expect(ctx.config.general().workspacesRoot).toBe('/srv/porterclaude/workspaces');
  });
});

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

/**
 * Regression (QA B-1): PortainerBackend.waitContainer() must NOT inherit the 20 s default
 * request timeout of send(). The v0.2 tools sync runs the agent installers inside the
 * populate container, which takes minutes; with the default timeout every
 * `POST /api/hosts/:id/images/tools/sync` died with "request timed out after 20000ms" and
 * the caller's finally block force-removed the container mid-install.
 */
describe('PortainerBackend.waitContainer', () => {
  async function withServer(
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
    run: (backend: PortainerBackend) => Promise<void>,
  ): Promise<void> {
    const http = await import('node:http');
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    // a deliberately tiny default: anything that honours it fails in well under a second
    const backend = new PortainerBackend({
      url: `http://127.0.0.1:${port}`, apiKey: 'k', endpointId: 2, timeoutMs: 250,
    });
    try {
      await run(backend);
    } finally {
      await backend.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('waits past the default request timeout (long install) and returns the exit status', async () => {
    let waitCalls = 0;
    await withServer(
      (req, res) => {
        const url = req.url ?? '';
        if (url.includes('/wait')) {
          waitCalls += 1;
          // ~4x the configured default timeout
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ StatusCode: 0 }));
          }, 1000);
          return;
        }
        if (url.includes('/info')) return; // never answers: the default timeout must bite
        res.writeHead(404).end();
      },
      async (backend) => {
        await expect(backend.waitContainer('pc-tools')).resolves.toEqual({ statusCode: 0 });
        // the default timeout still applies to the ordinary calls
        await expect(backend.info()).rejects.toThrow(/timed out after 250ms/);
      },
    );
    expect(waitCalls).toBe(1);
  }, 20_000);

  it('falls back to inspect when the wait connection is cut, and reports the exit code', async () => {
    let waitCalls = 0;
    await withServer(
      (req, res) => {
        const url = req.url ?? '';
        if (url.includes('/wait')) {
          waitCalls += 1;
          res.socket?.destroy(); // proxy dropped the idle connection
          return;
        }
        if (url.includes('/json')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ Id: 'pc-tools', Name: '/pc-tools', State: { Status: 'exited', Running: false, ExitCode: 3 } }));
          return;
        }
        res.writeHead(404).end();
      },
      async (backend) => {
        await expect(backend.waitContainer('pc-tools')).resolves.toEqual({ statusCode: 3 });
      },
    );
    expect(waitCalls).toBe(1);
  }, 20_000);

  it('re-issues the wait while the container is still running, then gives up', async () => {
    let waitCalls = 0;
    await withServer(
      (req, res) => {
        const url = req.url ?? '';
        if (url.includes('/wait')) {
          waitCalls += 1;
          res.socket?.destroy();
          return;
        }
        if (url.includes('/json')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ Id: 'pc-tools', Name: '/pc-tools', State: { Status: 'running', Running: true } }));
          return;
        }
        res.writeHead(404).end();
      },
      async (backend) => {
        await expect(backend.waitContainer('pc-tools')).rejects.toThrow(/wait/i);
      },
    );
    expect(waitCalls).toBe(5);
  }, 20_000);
});
