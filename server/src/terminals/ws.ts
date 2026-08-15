// OWNER: B2. The websocket bridge. Wire protocol lives in protocol.ts (FROZEN).
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { AppContext } from '../context.js';

export interface TerminalWsHandle {
  wss: WebSocketServer;
  /** close every live terminal and the server */
  close(): Promise<void>;
}

/**
 * FROZEN SIGNATURE — index.ts (B1) calls exactly this.
 *
 * Implementation contract:
 *  - new WebSocketServer({ noServer: true }); listen for server.on('upgrade').
 *  - Only handle upgrades whose pathname is '/api/terminals'; ignore others (leave the
 *    socket alone so other upgrade handlers could exist).
 *  - authenticateUpgradeRequest(req, ctx) === false -> socket.write('HTTP/1.1 401 ...')
 *    and destroy (do NOT complete the handshake).
 *  - Validate the query with zod: session (slug), shell in bash|claude|sh, name
 *    (1..40 chars), cols/rows optional ints 1..1000 (default 80x24). Invalid ->
 *    accept the upgrade, send { type:'error', code:'bad_request' }, close 4400.
 *  - ctx.terminals.open(...) -> on failure map AppError to a ServerMessage + close code
 *    (session_not_found 4404, session_not_running 4409, backend_error 4502, else 4500).
 *  - On success send { type:'ready', ... } (text) and pipe:
 *        ExecStream data  -> ws.send(chunk, { binary: true })
 *        ws binary frame  -> stream.write(data)
 *        ws text frame    -> JSON ClientMessage: resize -> stream.resize(), ping -> pong,
 *                            signal SIGINT -> stream.write('\x03')
 *  - Heartbeat with ws.ping() every TERMINAL_HEARTBEAT_MS; terminate sockets that have not
 *    ponged within TERMINAL_HEARTBEAT_TIMEOUT_MS.
 *  - Backpressure: if ws.bufferedAmount > TERMINAL_MAX_BUFFER_BYTES, close 4500.
 *  - Cleanup on both directions: ws.on('close') -> stream.close() + terminals.unregister();
 *    stream.onClose -> send { type:'exit' } then ws.close(1000).
 *  - Never let an exception escape a socket handler: log and close 4500.
 */
export function attachTerminalWs(server: Server, ctx: AppContext): TerminalWsHandle {
  throw new Error('TODO(B2): implement attachTerminalWs');
}
