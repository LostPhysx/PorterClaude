// OWNER: F2. One xterm.js terminal bound to one /api/terminals websocket.
// Wire protocol: docs/design/api.md "WebSocket: terminals" + server/src/terminals/protocol.ts.
// F1 must not edit this file.
//
// Globals provided by index.html classic scripts: Terminal, FitAddon, WebLinksAddon.
/* global Terminal, FitAddon, WebLinksAddon, TextEncoder, setTimeout, clearTimeout, requestAnimationFrame */
import { terminalWsUrl, TERMINAL_NAME_RE } from './api.js';
import { bus, EVENTS } from './bus.js';

/** Close codes (mirror of server/src/terminals/protocol.ts TERMINAL_CLOSE). FROZEN. */
export const CLOSE = Object.freeze({
  normal: 1000,
  badRequest: 4400,
  unauthorized: 4401,
  sessionNotFound: 4404,
  sessionNotRunning: 4409,
  backendError: 4502,
  internal: 4500,
});

/** Reconnect backoff per api.md: 1s -> 15s with jitter. */
export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 15000;
/** Client keepalive: send {type:'ping'} at this interval (server pings every 30s). */
export const PING_MS = 25000;

/** @typedef {'bash'|'claude'|'sh'} Shell */
/** @typedef {'connecting'|'open'|'closed'|'reconnecting'|'fatal'} PaneStatus */

/**
 * Build the stable pane name that drives the tmux session (`pc_<name>`).
 * FROZEN: code.js persists this in the layout, so the algorithm must stay stable.
 * @param {string} session @param {Shell} shell @param {number} n 1-based per session+shell
 * @returns {string} e.g. "web-claude-2"
 */
export function makeTerminalName(session, shell, n) {
  const name = `${session}-${shell}-${n}`.toLowerCase();
  if (!TERMINAL_NAME_RE.test(name)) throw new Error(`invalid terminal name: ${name}`);
  return name;
}

/**
 * A terminal pane: xterm instance + websocket + reconnect state machine.
 *
 * Lifecycle used by code.js:
 *   const pane = new TerminalPane({ session, shell, name });
 *   pane.attach(containerEl);   // creates the xterm, opens the socket
 *   pane.fit();                 // on GoldenLayout resize (debounced by code.js)
 *   pane.focus();
 *   pane.dispose();             // on pane close / layout destroy
 *
 * TODO(F2) implementation notes:
 *  - `new Terminal({ convertEol:false, cursorBlink:true, fontFamily:'…mono', fontSize:13,
 *     scrollback:5000, allowProposedApi:true, theme: THEMES.dark })`
 *  - addons: `new FitAddon.FitAddon()`, `new WebLinksAddon.WebLinksAddon()`; loadAddon
 *    BEFORE term.open(el), then fit() on the next animation frame.
 *  - socket: `new WebSocket(terminalWsUrl({...}))`, `ws.binaryType = 'arraybuffer'`.
 *  - ws.onmessage: ArrayBuffer -> `term.write(new Uint8Array(ev.data))`;
 *    string -> JSON.parse -> handleServerMessage().
 *  - term.onData(d => ...): keystrokes MUST go out as BINARY frames -
 *    `ws.send(new TextEncoder().encode(d))`. Text frames are reserved for JSON
 *    ClientMessages, so never `ws.send(d)` with a raw string.
 *  - term.onResize(({cols,rows}) => sendJson({type:'resize',cols,rows})) plus a resize
 *    right after `ready`.
 *  - on 'ready': store terminalId/tmux/reattached; if `tmux === false` print a dim warning
 *    line ("no tmux in this image - reloading the page kills this shell") and call
 *    onStatus('open', {tmux:false}).
 *  - on 'error': print the message in red; the close code that follows decides retry.
 *  - on 'exit': print "[process exited (code)]"; the socket then closes with 1000.
 *  - close handling: 1000 -> status 'closed', no auto-reconnect, offer "press Enter to
 *    restart" (Enter re-opens a fresh socket with the SAME name -> tmux reattaches);
 *    4401 -> status 'fatal', emit bus AUTH_REQUIRED, never retry;
 *    4400/4404/4409/4502/4500 and abnormal closes (1006) -> status 'reconnecting',
 *    retry with exponential backoff + jitter, capped, forever (reset the delay after a
 *    connection that stayed open > 10s). Show the countdown in the pane.
 *  - dispose(): clear timers, `ws.close(1000)`, `term.dispose()`, drop listeners. Idempotent.
 */
export class TerminalPane {
  /**
   * @param {{session:string, shell:Shell, name:string,
   *          onStatus?:(status:PaneStatus, info?:object)=>void,
   *          onTitle?:(title:string)=>void}} opts
   */
  constructor(opts) {
    this.session = opts.session;
    this.shell = opts.shell;
    this.name = opts.name;
    this.onStatus = opts.onStatus ?? (() => {});
    this.onTitle = opts.onTitle ?? (() => {});
    /** @type {PaneStatus} */
    this.status = 'closed';
    /** @type {WebSocket|null} */
    this.ws = null;
    /** @type {any} xterm Terminal */
    this.term = null;
    this.fitAddon = null;
    this.tmux = null;
    this.terminalId = null;
    this.disposed = false;
    this._retryDelay = RECONNECT_MIN_MS;
  }

  /** Create the xterm + open the socket. TODO(F2) @param {HTMLElement} el */
  attach(el) { void el; throw new Error('TODO(F2): implement TerminalPane.attach'); }

  /** (Re)open the websocket. TODO(F2) */
  connect() { throw new Error('TODO(F2): implement TerminalPane.connect'); }

  /** @param {import('./api.js').ApiError|object} msg TODO(F2) */
  handleServerMessage(msg) { void msg; throw new Error('TODO(F2): implement handleServerMessage'); }

  /** Send a JSON ClientMessage (text frame). TODO(F2) */
  sendJson(msg) { void msg; throw new Error('TODO(F2): implement sendJson'); }

  /** Send SIGINT via {type:'signal'}. TODO(F2) */
  interrupt() { throw new Error('TODO(F2): implement interrupt'); }

  /** FitAddon.fit() guarded against zero-size containers. TODO(F2) */
  fit() { throw new Error('TODO(F2): implement fit'); }

  focus() { this.term?.focus(); }

  /** Repaint colours after a theme switch. TODO(F2) */
  setTheme(theme) { void theme; throw new Error('TODO(F2): implement setTheme'); }

  /** Idempotent teardown. TODO(F2) */
  dispose() { throw new Error('TODO(F2): implement dispose'); }
}

/** xterm colour themes; keys match <html data-bs-theme>. TODO(F2): tune to app.css. */
export const THEMES = {
  dark: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff', selectionBackground: '#264f78' },
  light: { background: '#ffffff', foreground: '#24292f', cursor: '#0969da', selectionBackground: '#add6ff' },
};

void bus; void EVENTS; void CLOSE; void PING_MS; void RECONNECT_MAX_MS;
