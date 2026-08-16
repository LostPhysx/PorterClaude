// OWNER: B2. The terminal websocket bridge (auth refusal, ready frame, control messages,
// close codes). Uses a real http server + ws client; the auth module is mocked so this
// test does not depend on B1's runtime code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { AppContext } from '../../src/context.js';
import { AppError } from '../../src/http/errors.js';
import { TERMINAL_CLOSE } from '../../src/terminals/protocol.js';
import { attachTerminalWs } from '../../src/terminals/ws.js';
import { silentLog, stubExecStream } from './helpers.js';

const authState = vi.hoisted(() => ({ ok: true }));
vi.mock('../../src/auth/index.js', () => ({
  authenticateUpgradeRequest: () => authState.ok,
}));

interface TestStream {
  emitData(text: string): void;
  emitClose(code?: number): void;
  emitError(err: Error): void;
  written: string[];
  closed: boolean;
}

let server: http.Server;
let handle: ReturnType<typeof attachTerminalWs>;
let stream: ReturnType<typeof stubExecStream> & TestStream;
let openError: unknown = null;
let sessionStateError: unknown = null;
let execExitCode: number | null = 0;
let unregistered: string[] = [];
let killed: string[] = [];

function makeCtx(): AppContext {
  return {
    log: silentLog,
    terminals: {
      open: async () => {
        if (openError) throw openError;
        return {
          terminalId: 't1',
          stream,
          containerId: 'c1',
          tmux: true,
          reattached: false,
        };
      },
      unregister: (id: string) => unregistered.push(id),
      killTmuxSession: async (session: string, name: string) => {
        killed.push(`${session}/${name}`);
        return true;
      },
    },
    sessions: {
      requireRunningContainer: async () => {
        if (sessionStateError) throw sessionStateError;
        return { containerId: 'c1', config: {} };
      },
    },
    backends: {
      get: () => ({
        execInspect: async () => ({ running: false, exitCode: execExitCode, pid: 1 }),
      }),
    },
  } as unknown as AppContext;
}

function url(query: string): string {
  const { port } = server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}/api/terminals?${query}`;
}

function connect(query = 'session=web&shell=bash&name=main&cols=100&rows=30'): WebSocket {
  const ws = new WebSocket(url(query));
  ws.binaryType = 'arraybuffer';
  return ws;
}

function nextText(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data, isBinary) => {
      if (isBinary) return reject(new Error('expected a text frame'));
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    ws.once('error', reject);
  });
}

function nextClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

beforeEach(async () => {
  authState.ok = true;
  openError = null;
  sessionStateError = null;
  execExitCode = 0;
  unregistered = [];
  killed = [];
  stream = stubExecStream() as ReturnType<typeof stubExecStream> & TestStream;
  server = http.createServer((_req, res) => res.end('ok'));
  handle = attachTerminalWs(server, makeCtx());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  await handle.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('attachTerminalWs', () => {
  it('refuses an unauthenticated upgrade with HTTP 401 before the handshake', async () => {
    authState.ok = false;
    const ws = connect();
    const status = await new Promise<number>((resolve, reject) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => reject(new Error('handshake must not complete')));
      ws.on('error', (err) => reject(err));
      setTimeout(() => reject(new Error('timeout')), 4000);
    });
    expect(status).toBe(401);
  });

  it('leaves upgrades on other paths to other handlers', async () => {
    const seen: string[] = [];
    // registered after attachTerminalWs: it only ever runs if our handler left the socket alone
    server.on('upgrade', (req, socket) => {
      seen.push(req.url ?? '');
      expect(socket.destroyed).toBe(false);
      socket.destroy();
    });
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/somewhere-else`);
    await new Promise<void>((resolve) => {
      ws.on('error', () => resolve());
      ws.on('close', () => resolve());
      ws.on('unexpected-response', () => resolve());
    });
    expect(seen).toEqual(['/somewhere-else']);
  });

  it('sends ready as the first text frame', async () => {
    const ws = connect();
    const ready = await nextText(ws);
    expect(ready).toMatchObject({
      type: 'ready',
      terminalId: 't1',
      session: 'web',
      shell: 'bash',
      name: 'main',
      tmux: true,
      reattached: false,
      cols: 100,
      rows: 30,
    });
    ws.close();
  });

  it('bridges binary frames in both directions', async () => {
    const ws = connect();
    await nextText(ws);
    ws.send(Buffer.from('echo hi\n'), { binary: true });
    await vi.waitFor(() => expect(stream.written.join('')).toContain('echo hi'));

    const output = await new Promise<Buffer>((resolve) => {
      ws.once('message', (data, isBinary) => {
        expect(isBinary).toBe(true);
        resolve(Buffer.from(data as ArrayBuffer));
      });
      stream.emitData('hi\r\n');
    });
    expect(output.toString()).toBe('hi\r\n');
    ws.close();
  });

  it('answers {type:ping} with {type:pong} and forwards resize/signal', async () => {
    const ws = connect();
    await nextText(ws);

    ws.send(JSON.stringify({ type: 'ping' }));
    expect(await nextText(ws)).toEqual({ type: 'pong' });

    const resize = vi.spyOn(stream, 'resize');
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    await vi.waitFor(() => expect(resize).toHaveBeenCalledWith({ cols: 120, rows: 40 }));

    ws.send(JSON.stringify({ type: 'signal', signal: 'SIGINT' }));
    await vi.waitFor(() => expect(stream.written.join('')).toContain('\x03'));
    ws.close();
  });

  it('rejects an invalid control message without closing the socket', async () => {
    const ws = connect();
    await nextText(ws);
    ws.send(JSON.stringify({ type: 'nonsense' }));
    expect(await nextText(ws)).toMatchObject({ type: 'error', code: 'bad_request' });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('closes 1000 with the real exec exit code when the shell exits', async () => {
    execExitCode = 3;
    const ws = connect();
    await nextText(ws);
    const exit = nextText(ws);
    const closed = nextClose(ws);
    // the transport close code (1006 from the portainer exec socket) is NOT an exit status
    stream.emitClose(1006);
    expect(await exit).toEqual({ type: 'exit', code: 3 });
    expect(await closed).toBe(TERMINAL_CLOSE.normal);
    expect(unregistered).toContain('t1');
  });

  it('closes 4409 when the exec ends because the session was stopped', async () => {
    sessionStateError = AppError.conflict("session 'web' is not running");
    const ws = connect();
    await nextText(ws);
    const message = nextText(ws);
    const closed = nextClose(ws);
    stream.emitClose(1006);
    expect(await message).toMatchObject({ type: 'error', code: 'session_not_running' });
    expect(await closed).toBe(TERMINAL_CLOSE.sessionNotRunning);
    expect(unregistered).toContain('t1');
  });

  it('closes 4404 when the exec ends because the session is gone', async () => {
    sessionStateError = AppError.notFound("session 'web' does not exist");
    const ws = connect();
    await nextText(ws);
    const message = nextText(ws);
    const closed = nextClose(ws);
    stream.emitClose(1006);
    expect(await message).toMatchObject({ type: 'error', code: 'session_not_found' });
    expect(await closed).toBe(TERMINAL_CLOSE.sessionNotFound);
  });

  it('still reports a normal exit when the session state cannot be confirmed', async () => {
    sessionStateError = new Error('portainer unreachable');
    execExitCode = null;
    const ws = connect();
    await nextText(ws);
    const exit = nextText(ws);
    const closed = nextClose(ws);
    stream.emitClose(1006);
    expect(await exit).toEqual({ type: 'exit', code: null });
    expect(await closed).toBe(TERMINAL_CLOSE.normal);
  });

  it.each([
    ['session=web&shell=bash', TERMINAL_CLOSE.badRequest],
    ['session=Bad Name&shell=bash&name=main', TERMINAL_CLOSE.badRequest],
    ['session=web&shell=fish&name=main', TERMINAL_CLOSE.badRequest],
    ['session=web&shell=bash&name=' + 'x'.repeat(60), TERMINAL_CLOSE.badRequest],
  ])('closes %s with %i', async (query, expected) => {
    const ws = connect(query);
    const code = await nextClose(ws);
    expect(code).toBe(expected);
  });

  it.each([
    [AppError.notFound("session 'web' does not exist"), TERMINAL_CLOSE.sessionNotFound, 'session_not_found'],
    [AppError.conflict("session 'web' is not running"), TERMINAL_CLOSE.sessionNotRunning, 'session_not_running'],
    [AppError.backendNotConfigured(), TERMINAL_CLOSE.backendError, 'backend_error'],
    [new Error('boom'), TERMINAL_CLOSE.internal, 'internal'],
  ])('maps open failures to the documented close code', async (err, closeCode, errorCode) => {
    openError = err;
    const ws = connect();
    const message = await nextText(ws);
    const code = await nextClose(ws);
    expect(message).toMatchObject({ type: 'error', code: errorCode });
    expect(code).toBe(closeCode);
  });

  it('closes the exec stream when the browser disconnects', async () => {
    const ws = connect();
    await nextText(ws);
    ws.close();
    await vi.waitFor(() => expect(stream.closed).toBe(true));
    expect(unregistered).toContain('t1');
  });
});

// INT-06: a closed pane left its tmux session (and everything running in it) alive in the
// container forever, while a reload MUST keep it so the next connect re-attaches.
describe('ending a pane for good', () => {
  it('kills the tmux session on a {type:kill} message and closes 1000', async () => {
    const ws = connect();
    await nextText(ws);
    const closed = nextClose(ws);
    ws.send(JSON.stringify({ type: 'kill' }));
    expect(await closed).toBe(TERMINAL_CLOSE.normal);
    await vi.waitFor(() => expect(killed).toEqual(['web/main']));
    expect(stream.closed).toBe(true);
  });

  it('kills it when the client closes with 4001', async () => {
    const ws = connect();
    await nextText(ws);
    ws.close(TERMINAL_CLOSE.paneClosed, 'pane closed');
    await vi.waitFor(() => expect(killed).toEqual(['web/main']));
  });

  it('keeps it on a plain disconnect (reload) and on an exec exit', async () => {
    const first = connect();
    await nextText(first);
    first.close();
    await vi.waitFor(() => expect(stream.closed).toBe(true));

    const second = connect();
    await nextText(second);
    const closed = nextClose(second);
    stream.emitClose(1006);
    await closed;
    expect(killed).toEqual([]);
  });
});
