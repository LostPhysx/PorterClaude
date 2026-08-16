// OWNER: B2. The websocket bridge. Wire protocol lives in protocol.ts (FROZEN).
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { authenticateUpgradeRequest } from '../auth/index.js';
import type { AppContext } from '../context.js';
import type { ExecStream } from '../backends/types.js';
import { AppError, toAppError } from '../http/errors.js';
import { SLUG_RE } from '../util/slug.js';
import {
  TERMINAL_CLOSE,
  TERMINAL_HEARTBEAT_MS,
  TERMINAL_HEARTBEAT_TIMEOUT_MS,
  TERMINAL_MAX_BUFFER_BYTES,
} from './protocol.js';
import type { ClientMessage, ServerMessage, TerminalCloseCode, TerminalErrorCode } from './protocol.js';

export const TERMINAL_PATH = '/api/terminals';

export interface TerminalWsHandle {
  wss: WebSocketServer;
  /** close every live terminal and the server */
  close(): Promise<void>;
}

/** The pane name the UI generates: <session>-<shell>-<n>. */
const TERMINAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

const QuerySchema = z.object({
  session: z.string().regex(SLUG_RE, 'invalid session name'),
  shell: z.enum(['bash', 'claude', 'sh']).default('bash'),
  name: z.string().regex(TERMINAL_NAME_RE, 'invalid terminal name'),
  cols: z.coerce.number().int().min(1).max(1000).optional().default(80),
  rows: z.coerce.number().int().min(1).max(1000).optional().default(24),
});

const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('resize'),
    cols: z.coerce.number().int().min(1).max(1000),
    rows: z.coerce.number().int().min(1).max(1000),
  }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('signal'), signal: z.literal('SIGINT') }),
  z.object({ type: z.literal('kill') }),
]);

/**
 * FROZEN SIGNATURE — index.ts (B1) calls exactly this.
 */
export function attachTerminalWs(server: Server, ctx: AppContext): TerminalWsHandle {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return;
    }
    // Not ours: leave the socket alone so other upgrade handlers can serve it.
    if (pathname !== TERMINAL_PATH) return;

    let authenticated = false;
    try {
      authenticated = authenticateUpgradeRequest(req, ctx);
    } catch (err) {
      ctx.log.error({ err }, 'terminal upgrade authentication failed');
      authenticated = false;
    }
    if (!authenticated) {
      // Refuse BEFORE the handshake (close code 4401 has no chance to be delivered).
      const body = '{"error":{"code":"unauthorized","message":"authentication required"}}';
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\n' +
          'Connection: close\r\n' +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          '\r\n' +
          body,
      );
      socket.destroy();
      return;
    }

    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        void handleConnection(ws, req, ctx);
      });
    } catch (err) {
      ctx.log.error({ err }, 'terminal upgrade failed');
      socket.destroy();
    }
  };

  server.on('upgrade', onUpgrade);

  return {
    wss,
    async close(): Promise<void> {
      server.off('upgrade', onUpgrade);
      for (const client of wss.clients) {
        try {
          client.close(TERMINAL_CLOSE.normal, 'server shutting down');
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* the socket is going away; nothing to do */
  }
}

function fail(ws: WebSocket, code: TerminalErrorCode, message: string, closeCode: TerminalCloseCode): void {
  send(ws, { type: 'error', code, message });
  try {
    ws.close(closeCode, message.slice(0, 100));
  } catch {
    /* ignore */
  }
}

/** AppError -> (terminal error code, websocket close code). */
export function mapError(err: unknown): { code: TerminalErrorCode; close: TerminalCloseCode; message: string } {
  const appErr: AppError = toAppError(err);
  switch (appErr.code) {
    case 'not_found':
      return { code: 'session_not_found', close: TERMINAL_CLOSE.sessionNotFound, message: appErr.message };
    case 'conflict':
      return { code: 'session_not_running', close: TERMINAL_CLOSE.sessionNotRunning, message: appErr.message };
    case 'backend_error':
    case 'backend_not_configured':
      return { code: 'backend_error', close: TERMINAL_CLOSE.backendError, message: appErr.message };
    case 'validation_error':
    case 'bad_request':
      return { code: 'bad_request', close: TERMINAL_CLOSE.badRequest, message: appErr.message };
    case 'unauthorized':
      return { code: 'unauthorized', close: TERMINAL_CLOSE.unauthorized, message: appErr.message };
    default:
      return { code: 'internal', close: TERMINAL_CLOSE.internal, message: 'internal error' };
  }
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  return Buffer.from(String(data));
}

async function handleConnection(ws: WebSocket, req: IncomingMessage, ctx: AppContext): Promise<void> {
  const log = ctx.log;
  let stream: ExecStream | null = null;
  let terminalId: string | null = null;
  let closed = false;
  let lastPong = Date.now();
  /** the user closed the pane (kill message / close code 4001) -> end the tmux session */
  let killRequested = false;
  /** set once the query parsed; kill needs the session + pane name */
  let target: { session: string; name: string } | null = null;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (terminalId) ctx.terminals.unregister(terminalId);
    if (stream) {
      try {
        stream.close();
      } catch (err) {
        log.debug({ err }, 'closing exec stream failed');
      }
    }
    // Only an EXPLICIT close ends the shell: a reload or a dropped connection must leave
    // the tmux session alone, that is what makes re-attaching work (INT-06).
    if (killRequested && target) {
      void ctx.terminals.killTmuxSession(target.session, target.name);
    }
  };

  const heartbeat = setInterval(() => {
    try {
      if (Date.now() - lastPong > TERMINAL_HEARTBEAT_TIMEOUT_MS) {
        log.warn('terminal heartbeat timeout; terminating socket');
        ws.terminate();
        cleanup();
        return;
      }
      ws.ping();
    } catch (err) {
      log.debug({ err }, 'terminal heartbeat failed');
    }
  }, TERMINAL_HEARTBEAT_MS);

  ws.on('pong', () => {
    lastPong = Date.now();
  });
  ws.on('error', (err) => {
    log.debug({ err }, 'terminal websocket error');
  });
  ws.on('close', (code: number) => {
    if (code === TERMINAL_CLOSE.paneClosed) killRequested = true;
    cleanup();
  });

  // --- query validation ----------------------------------------------------
  let query: z.infer<typeof QuerySchema>;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
    if (!parsed.success) {
      fail(ws, 'bad_request', 'invalid terminal query', TERMINAL_CLOSE.badRequest);
      cleanup();
      return;
    }
    query = parsed.data;
    target = { session: query.session, name: query.name };
  } catch {
    fail(ws, 'bad_request', 'invalid terminal query', TERMINAL_CLOSE.badRequest);
    cleanup();
    return;
  }

  // --- open the exec -------------------------------------------------------
  let opened;
  try {
    opened = await ctx.terminals.open({
      session: query.session,
      shell: query.shell,
      name: query.name,
      cols: query.cols,
      rows: query.rows,
    });
  } catch (err) {
    const mapped = mapError(err);
    log.warn({ err, session: query.session }, 'opening terminal failed');
    fail(ws, mapped.code, mapped.message, mapped.close);
    cleanup();
    return;
  }

  if (ws.readyState !== WebSocket.OPEN) {
    // the client disappeared while we were opening the exec
    opened.stream.close();
    ctx.terminals.unregister(opened.terminalId);
    cleanup();
    return;
  }

  stream = opened.stream;
  terminalId = opened.terminalId;
  const execId = opened.stream.execId;

  send(ws, {
    type: 'ready',
    terminalId: opened.terminalId,
    session: query.session,
    shell: query.shell,
    name: query.name,
    tmux: opened.tmux,
    reattached: opened.reattached,
    cols: query.cols,
    rows: query.rows,
  });
  if (opened.reattached) {
    send(ws, { type: 'info', message: `reattached to tmux session pc_${query.name}` });
  } else if (!opened.tmux) {
    send(ws, {
      type: 'info',
      message: 'no tmux in this image: reloading the page will kill this shell',
    });
  }

  // --- container -> browser ------------------------------------------------
  stream.onData((chunk) => {
    try {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > TERMINAL_MAX_BUFFER_BYTES) {
        log.warn({ terminalId }, 'terminal backpressure limit exceeded; dropping socket');
        fail(ws, 'internal', 'client too slow', TERMINAL_CLOSE.internal);
        cleanup();
        return;
      }
      ws.send(chunk, { binary: true });
    } catch (err) {
      log.debug({ err }, 'forwarding terminal output failed');
    }
  });

  // The exec ended. `info.code` is the TRANSPORT close code (the portainer backend reports
  // the exec websocket's 1006 when the container dies), never a process status - so ask the
  // engine for the real exit status, and when the container is no longer running close with
  // 4409 instead of pretending the shell exited normally: the pane then shows the
  // "session is not running" note with its Start action rather than "[process exited]".
  const onStreamClosed = async (): Promise<void> => {
    if (closed) return;
    let stopped: unknown = null;
    try {
      await ctx.sessions.requireRunningContainer(query.session);
    } catch (err) {
      const appErr = toAppError(err);
      // only a definite "gone"/"stopped" answer overrides the normal exit path
      if (appErr.code === 'not_found' || appErr.code === 'conflict') stopped = appErr;
      else log.debug({ err }, 'could not confirm the session state after the exec ended');
    }
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    if (stopped) {
      const mapped = mapError(stopped);
      fail(ws, mapped.code, mapped.message, mapped.close);
      cleanup();
      return;
    }
    let code: number | null = null;
    try {
      code = (await ctx.backends.get().execInspect(execId)).exitCode;
    } catch (err) {
      log.debug({ err, terminalId }, 'inspecting the finished exec failed');
    }
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    send(ws, { type: 'exit', code });
    ws.close(TERMINAL_CLOSE.normal, 'shell exited');
    cleanup();
  };

  stream.onClose(() => {
    onStreamClosed().catch((err: unknown) => {
      log.debug({ err }, 'closing terminal socket failed');
      cleanup();
    });
  });

  stream.onError((err) => {
    log.warn({ err, terminalId }, 'terminal exec stream error');
    try {
      fail(ws, 'backend_error', err.message, TERMINAL_CLOSE.backendError);
    } finally {
      cleanup();
    }
  });

  // --- browser -> container ------------------------------------------------
  ws.on('message', (data, isBinary) => {
    try {
      if (!stream) return;
      if (isBinary) {
        stream.write(new Uint8Array(toBuffer(data)));
        return;
      }
      let msg: ClientMessage;
      try {
        const parsed = ClientMessageSchema.safeParse(JSON.parse(toBuffer(data).toString('utf8')));
        if (!parsed.success) {
          send(ws, { type: 'error', code: 'bad_request', message: 'invalid control message' });
          return;
        }
        msg = parsed.data;
      } catch {
        send(ws, { type: 'error', code: 'bad_request', message: 'invalid control message' });
        return;
      }

      switch (msg.type) {
        case 'resize':
          void stream.resize({ cols: msg.cols, rows: msg.rows }).catch((err: unknown) => {
            log.debug({ err }, 'terminal resize failed');
          });
          break;
        case 'ping':
          send(ws, { type: 'pong' });
          break;
        case 'signal':
          stream.write('\x03');
          break;
        case 'kill':
          // the pane is gone for good: cleanup() kills pc_<name> after the socket closed
          killRequested = true;
          try {
            ws.close(TERMINAL_CLOSE.normal, 'pane closed');
          } catch {
            /* ignore */
          }
          cleanup();
          break;
      }
    } catch (err) {
      log.error({ err }, 'terminal message handler failed');
      try {
        fail(ws, 'internal', 'internal error', TERMINAL_CLOSE.internal);
      } finally {
        cleanup();
      }
    }
  });
}
