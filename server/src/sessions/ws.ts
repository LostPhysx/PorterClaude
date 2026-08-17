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
  parseSessionShell,
  SessionRefusal,
  SESSION_CLOSE,
  SESSION_HEARTBEAT_MS,
  SESSION_HEARTBEAT_TIMEOUT_MS,
  SESSION_MAX_BUFFER_BYTES,
} from './protocol.js';
import type { ClientMessage, ServerMessage, SessionCloseCode, SessionErrorCode } from './protocol.js';

export const SESSION_WS_PATH = '/api/sessions';

export interface SessionWsHandle {
  wss: WebSocketServer;
  /** close every live session and the server */
  close(): Promise<void>;
}

/** The pane name the UI generates: <container>-<shell>-<n>. */
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

/**
 * v0.2: `shell` is a STRING on the wire (`bash` | `sh` | `agent:<id>`, plus the deprecated
 * `claude` alias) and is decoded with `parseSessionShell`, which also yields the agent id.
 * An unparsable value is a 4400.
 */
const QuerySchema = z.object({
  container: z.string().regex(SLUG_RE, 'invalid container name'),
  shell: z
    .string()
    .max(48)
    .default('bash')
    .transform((raw, ctx2) => {
      const parsed = parseSessionShell(raw);
      if (!parsed) {
        ctx2.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid shell' });
        return z.NEVER;
      }
      return parsed;
    }),
  session: z.string().regex(SESSION_NAME_RE, 'invalid session name'),
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
export function attachSessionWs(server: Server, ctx: AppContext): SessionWsHandle {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return;
    }
    // Not ours: leave the socket alone so other upgrade handlers can serve it.
    if (pathname !== SESSION_WS_PATH) return;

    let authenticated = false;
    try {
      authenticated = authenticateUpgradeRequest(req, ctx);
    } catch (err) {
      ctx.log.error({ err }, 'session upgrade authentication failed');
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
      ctx.log.error({ err }, 'session upgrade failed');
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
          client.close(SESSION_CLOSE.normal, 'server shutting down');
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

function fail(ws: WebSocket, code: SessionErrorCode, message: string, closeCode: SessionCloseCode): void {
  send(ws, { type: 'error', code, message });
  try {
    ws.close(closeCode, message.slice(0, 100));
  } catch {
    /* ignore */
  }
}

/**
 * Exec exit statuses that mean "the container went away under this shell" rather than "the
 * user typed exit": 128+SIGKILL and 128+SIGTERM, i.e. exactly what stopping (or killing) a
 * container produces. `null` = the engine could not report a status at all, which happens
 * for the same reason. INT-05.
 */
export const CONTAINER_STOP_EXIT_CODES: readonly number[] = [137, 143];

export function looksLikeContainerStop(exitCode: number | null): boolean {
  return exitCode === null || CONTAINER_STOP_EXIT_CODES.includes(exitCode);
}

/**
 * How long the server keeps re-checking the container state after such an exit before it
 * accepts "the container is still running" (INT-05). Mutable so tests can shrink the window.
 */
export const STOP_RECHECK = { intervalMs: 250, timeoutMs: 3_000 };

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // unref'd: a pending recheck must never hold the process open on shutdown
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Error -> (session error code, websocket close code).
 *
 * A `SessionRefusal` (v0.2) carries both itself: it is how `agent_not_available` (4410) and
 * `host_unavailable` (4411) reach the client. Everything else is mapped from the AppError
 * code, with `not_implemented` (a host whose connection type this version cannot talk to)
 * folded into `host_unavailable` as well.
 */
export function mapError(err: unknown): { code: SessionErrorCode; close: SessionCloseCode; message: string } {
  if (err instanceof SessionRefusal) {
    return { code: err.sessionCode, close: err.closeCode, message: err.message };
  }
  const appErr: AppError = toAppError(err);
  switch (appErr.code) {
    case 'not_implemented':
      return { code: 'host_unavailable', close: SESSION_CLOSE.hostUnavailable, message: appErr.message };
    case 'not_found':
      return { code: 'container_not_found', close: SESSION_CLOSE.containerNotFound, message: appErr.message };
    case 'conflict':
      return { code: 'container_not_running', close: SESSION_CLOSE.containerNotRunning, message: appErr.message };
    case 'backend_error':
    case 'backend_not_configured':
      return { code: 'backend_error', close: SESSION_CLOSE.backendError, message: appErr.message };
    case 'validation_error':
    case 'bad_request':
      return { code: 'bad_request', close: SESSION_CLOSE.badRequest, message: appErr.message };
    case 'unauthorized':
      return { code: 'unauthorized', close: SESSION_CLOSE.unauthorized, message: appErr.message };
    default:
      return { code: 'internal', close: SESSION_CLOSE.internal, message: 'internal error' };
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
  let sessionId: string | null = null;
  let closed = false;
  let lastPong = Date.now();
  /** the user closed the pane (kill message / close code 4001) -> end the tmux session */
  let killRequested = false;
  /** set once the query parsed; kill needs the container + pane name */
  let target: { container: string; session: string } | null = null;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (sessionId) ctx.sessions.unregister(sessionId);
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
      void ctx.sessions.killTmuxSession(target.container, target.session);
    }
  };

  const heartbeat = setInterval(() => {
    try {
      if (Date.now() - lastPong > SESSION_HEARTBEAT_TIMEOUT_MS) {
        log.warn('session heartbeat timeout; terminating socket');
        ws.terminate();
        cleanup();
        return;
      }
      ws.ping();
    } catch (err) {
      log.debug({ err }, 'session heartbeat failed');
    }
  }, SESSION_HEARTBEAT_MS);

  ws.on('pong', () => {
    lastPong = Date.now();
  });
  ws.on('error', (err) => {
    log.debug({ err }, 'session websocket error');
  });
  ws.on('close', (code: number) => {
    if (code === SESSION_CLOSE.paneClosed) killRequested = true;
    cleanup();
  });

  // --- query validation ----------------------------------------------------
  let query: z.infer<typeof QuerySchema>;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
    if (!parsed.success) {
      fail(ws, 'bad_request', 'invalid session query', SESSION_CLOSE.badRequest);
      cleanup();
      return;
    }
    query = parsed.data;
    target = { container: query.container, session: query.session };
  } catch {
    fail(ws, 'bad_request', 'invalid session query', SESSION_CLOSE.badRequest);
    cleanup();
    return;
  }

  // --- open the exec -------------------------------------------------------
  let opened;
  try {
    opened = await ctx.sessions.open({
      container: query.container,
      shell: query.shell.shell,
      agentId: query.shell.agentId,
      session: query.session,
      cols: query.cols,
      rows: query.rows,
    });
  } catch (err) {
    const mapped = mapError(err);
    log.warn({ err, container: query.container }, 'opening a session failed');
    fail(ws, mapped.code, mapped.message, mapped.close);
    cleanup();
    return;
  }

  if (ws.readyState !== WebSocket.OPEN) {
    // the client disappeared while we were opening the exec
    opened.stream.close();
    ctx.sessions.unregister(opened.sessionId);
    cleanup();
    return;
  }

  stream = opened.stream;
  sessionId = opened.sessionId;
  const execId = opened.stream.execId;

  send(ws, {
    type: 'ready',
    sessionId: opened.sessionId,
    container: query.container,
    hostId: opened.hostId,
    shell: query.shell.shell,
    agentId: opened.agentId,
    session: query.session,
    tmux: opened.tmux,
    reattached: opened.reattached,
    cols: query.cols,
    rows: query.rows,
  });
  if (opened.reattached) {
    send(ws, { type: 'info', message: `reattached to tmux session pc_${query.session}` });
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
      if (ws.bufferedAmount > SESSION_MAX_BUFFER_BYTES) {
        log.warn({ sessionId }, 'session backpressure limit exceeded; dropping socket');
        fail(ws, 'internal', 'client too slow', SESSION_CLOSE.internal);
        cleanup();
        return;
      }
      ws.send(chunk, { binary: true });
    } catch (err) {
      log.debug({ err }, 'forwarding session output failed');
    }
  });

  // The exec ended. `info.code` is the TRANSPORT close code (the portainer backend reports
  // the exec websocket's 1006 when the container dies), never a process status - so ask the
  // engine for the real exit status, and when the container is no longer running close with
  // 4409 instead of pretending the shell exited normally: the pane then shows the
  // "container is not running" note with its Start action rather than "[process exited]".
  //
  // INT-05: one state check races the stop. POST /containers/:name/stop kills the exec within
  // ~60 ms while the engine needs ~170 ms (portainer a bit more) to report the container as
  // exited, so the inspect right after the exec died still answered "running" and the pane
  // got `exit 137` + 1000. When the exit status looks like a container stop (128+SIGKILL /
  // 128+SIGTERM) or cannot be read at all, keep re-checking for a short while before
  // believing "running". A normal shell exit (0 or any other status while the container is
  // still up) is unaffected: it is answered on the first check, as before.
  const containerStopReason = async (): Promise<AppError | null> => {
    try {
      await ctx.containers.requireRunningContainer(query.container);
      return null;
    } catch (err) {
      const appErr = toAppError(err);
      // only a definite "gone"/"stopped" answer overrides the normal exit path
      if (appErr.code === 'not_found' || appErr.code === 'conflict') return appErr;
      log.debug({ err }, 'could not confirm the container state after the exec ended');
      return null;
    }
  };

  const onStreamClosed = async (): Promise<void> => {
    if (closed) return;
    // the real process status first: it decides how hard we look at the container state
    let code: number | null = null;
    try {
      // the exec lives on the CONTAINER'S host (v0.2), which the ready frame already named
      code = (await ctx.hosts.backendFor(opened.hostId).execInspect(execId)).exitCode;
    } catch (err) {
      log.debug({ err, sessionId }, 'inspecting the finished exec failed');
    }
    if (closed || ws.readyState !== WebSocket.OPEN) return;

    let stopped = await containerStopReason();
    if (!stopped && looksLikeContainerStop(code)) {
      const deadline = Date.now() + STOP_RECHECK.timeoutMs;
      while (!stopped && Date.now() < deadline) {
        await delay(STOP_RECHECK.intervalMs);
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        stopped = await containerStopReason();
      }
    }
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    if (stopped) {
      const mapped = mapError(stopped);
      log.info(
        { sessionId, container: query.container, exitCode: code, close: mapped.close },
        'the exec died with its container: closing the session as "container not running"',
      );
      fail(ws, mapped.code, mapped.message, mapped.close);
      cleanup();
      return;
    }
    send(ws, { type: 'exit', code });
    ws.close(SESSION_CLOSE.normal, 'shell exited');
    cleanup();
  };

  stream.onClose(() => {
    onStreamClosed().catch((err: unknown) => {
      log.debug({ err }, 'closing the session socket failed');
      cleanup();
    });
  });

  stream.onError((err) => {
    log.warn({ err, sessionId }, 'session exec stream error');
    try {
      fail(ws, 'backend_error', err.message, SESSION_CLOSE.backendError);
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
            log.debug({ err }, 'session resize failed');
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
            ws.close(SESSION_CLOSE.normal, 'pane closed');
          } catch {
            /* ignore */
          }
          cleanup();
          break;
      }
    } catch (err) {
      log.error({ err }, 'session message handler failed');
      try {
        fail(ws, 'internal', 'internal error', SESSION_CLOSE.internal);
      } finally {
        cleanup();
      }
    }
  });
}
