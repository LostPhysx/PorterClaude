// FROZEN (planner-authored). THE terminal websocket wire protocol. The web topic mirrors
// these shapes; changing anything here breaks the frontend. See docs/design/api.md.
//
//   URL:  /api/terminals?session=<slug>&shell=bash|claude|sh&name=<terminal>&cols=<n>&rows=<n>
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

export type TerminalShell = 'bash' | 'claude' | 'sh';

export interface TerminalQuery {
  session: string;
  shell: TerminalShell;
  /** stable per-pane name; drives the tmux session name, so reconnecting reattaches */
  name: string;
  cols?: number;
  rows?: number;
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
      shell: TerminalShell;
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
  backendError: 4502,
  internal: 4500,
} as const;

export type TerminalCloseCode = (typeof TERMINAL_CLOSE)[keyof typeof TERMINAL_CLOSE];

/** Server heartbeat: ws.ping() every 30s, terminate after 2 missed pongs. */
export const TERMINAL_HEARTBEAT_MS = 30_000;
export const TERMINAL_HEARTBEAT_TIMEOUT_MS = 70_000;

/** Max buffered stdin bytes before the server drops the connection (backpressure guard). */
export const TERMINAL_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
