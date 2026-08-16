// FROZEN (planner-authored). THE terminal websocket wire protocol. The web topic mirrors
// these shapes; changing anything here breaks the frontend. See docs/design/api.md.
//
//   URL:  /api/terminals?session=<slug>&shell=bash|sh|agent:<agentId>&name=<terminal>&cols=<n>&rows=<n>
//         (v0.1 `shell=claude` is still accepted and means `agent:claude`)
//   The host is NOT part of the query: session names are unique across hosts and the server
//   routes session -> host -> backend.
//   Auth: the pc_session cookie (browsers send it automatically on same-origin WS).
//
//   Client -> server
//     binary frame : raw stdin bytes (what the user typed) -- NOT wrapped in JSON
//     text frame   : JSON ClientMessage
//   Server -> client
//     binary frame : raw pty output bytes (feed straight into xterm.write)
//     text frame   : JSON ServerMessage
//
//   The browser MUST set ws.binaryType = 'arraybuffer'.

import { AppError } from '../http/errors.js';
import type { ErrorCode } from '../http/errors.js';

/**
 * What a pane runs. v0.2 replaced the hard-wired `claude` row with `agent`, which carries
 * the agent id separately (`TerminalQuery.agentId`) — the wire value is `agent:<agentId>`.
 */
export type TerminalShell = 'bash' | 'sh' | 'agent';

/** the raw `shell` query value, e.g. 'bash' | 'sh' | 'agent:claude' | 'claude' (legacy) */
export type TerminalShellParam = string;

export interface TerminalQuery {
  session: string;
  shell: TerminalShell;
  /** set exactly when `shell === 'agent'` */
  agentId: string | null;
  /** stable per-pane name; drives the tmux session name, so reconnecting reattaches */
  name: string;
  cols?: number;
  rows?: number;
}

/** agent ids are slugs (agents/model.ts AGENT_ID_RE); kept local to avoid an import cycle */
const AGENT_SHELL_RE = /^agent:([a-z0-9][a-z0-9-]{0,31})$/;

/**
 * Parse the `shell` query parameter. Returns null for anything else (=> close 4400).
 *
 *   'bash'          -> { shell: 'bash',  agentId: null }
 *   'sh'            -> { shell: 'sh',    agentId: null }
 *   'agent:claude'  -> { shell: 'agent', agentId: 'claude' }
 *   'claude'        -> { shell: 'agent', agentId: 'claude' }   (v0.1 alias, deprecated)
 */
export function parseTerminalShell(
  raw: TerminalShellParam,
): { shell: TerminalShell; agentId: string | null } | null {
  if (raw === 'bash' || raw === 'sh') return { shell: raw, agentId: null };
  if (raw === 'claude') return { shell: 'agent', agentId: 'claude' };
  const match = AGENT_SHELL_RE.exec(raw);
  return match ? { shell: 'agent', agentId: match[1] as string } : null;
}

/** Inverse of parseTerminalShell — what the UI puts into the query. */
export function formatTerminalShell(shell: TerminalShell, agentId?: string | null): TerminalShellParam {
  return shell === 'agent' ? `agent:${agentId ?? ''}` : shell;
}

export type ClientMessage =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }
  /** optional convenience; server writes the matching control byte to stdin */
  | { type: 'signal'; signal: 'SIGINT' }
  /**
   * The USER closed this pane (not a reload, not a lost connection): end the shell for
   * good. The server runs `tmux kill-session -t pc_<name>` and closes the socket, so the
   * pane's processes do not keep running in the container forever. A plain disconnect
   * never kills anything — that is what makes a reload re-attach.
   */
  | { type: 'kill' };

export type ServerMessage =
  | {
      type: 'ready';
      terminalId: string;
      session: string;
      /** the host the session runs on (v0.2) */
      hostId: string;
      shell: TerminalShell;
      /** the agent this pane started, null for a plain shell (v0.2) */
      agentId: string | null;
      name: string;
      /** false => no tmux in the image: output is not reconnect-safe (UI shows a warning) */
      tmux: boolean;
      /** true => an existing tmux session was reattached */
      reattached: boolean;
      cols: number;
      rows: number;
    }
  | { type: 'info'; message: string }
  | { type: 'error'; code: TerminalErrorCode; message: string }
  | { type: 'exit'; code: number | null }
  | { type: 'pong' };

export type TerminalErrorCode =
  | 'unauthorized'
  | 'bad_request'
  | 'session_not_found'
  | 'session_not_running'
  /** the requested agent is unknown, or not mounted into this session (v0.2) */
  | 'agent_not_available'
  /** the session's host is gone or its connection type is not supported (v0.2) */
  | 'host_unavailable'
  | 'backend_error'
  | 'exec_failed'
  | 'internal';

/** WebSocket close codes used by the server (4xxx = application range). */
export const TERMINAL_CLOSE = {
  normal: 1000,
  /** client -> server: the user closed the pane; equivalent to a `kill` message (the
   *  browser cannot always send one before it closes the socket) */
  paneClosed: 4001,
  unauthorized: 4401,
  badRequest: 4400,
  sessionNotFound: 4404,
  sessionNotRunning: 4409,
  /** v0.2: the requested agent is not available in this session (do not auto-reconnect) */
  agentNotAvailable: 4410,
  /** v0.2: the session's host is unusable (missing host, unsupported connection) */
  hostUnavailable: 4411,
  backendError: 4502,
  internal: 4500,
} as const;

export type TerminalCloseCode = (typeof TERMINAL_CLOSE)[keyof typeof TERMINAL_CLOSE];

/** Server heartbeat: ws.ping() every 30s, terminate after 2 missed pongs. */
export const TERMINAL_HEARTBEAT_MS = 30_000;
export const TERMINAL_HEARTBEAT_TIMEOUT_MS = 70_000;

/** Max buffered stdin bytes before the server drops the connection (backpressure guard). */
export const TERMINAL_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * A refusal that carries its own wire code + close code (v0.2). `mapError` in ws.ts uses it
 * verbatim, which is how `agent_not_available` (4410) and `host_unavailable` (4411) reach the
 * client: both are conditions no AppError code can express (an unknown agent is not a 404 of
 * the session, and a dead host is not a broken backend — the client must not reconnect).
 */
export class TerminalRefusal extends AppError {
  readonly terminalCode: TerminalErrorCode;
  readonly closeCode: TerminalCloseCode;

  constructor(
    terminalCode: TerminalErrorCode,
    closeCode: TerminalCloseCode,
    message: string,
    appCode: ErrorCode = 'conflict',
  ) {
    super(appCode, message);
    this.name = 'TerminalRefusal';
    this.terminalCode = terminalCode;
    this.closeCode = closeCode;
  }

  /** the requested agent is unknown or not mounted into this session */
  static agentNotAvailable(message: string): TerminalRefusal {
    return new TerminalRefusal('agent_not_available', TERMINAL_CLOSE.agentNotAvailable, message, 'conflict');
  }

  /** the session's host is gone, or its connection type is not supported by this version */
  static hostUnavailable(message: string): TerminalRefusal {
    return new TerminalRefusal('host_unavailable', TERMINAL_CLOSE.hostUnavailable, message, 'conflict');
  }
}
