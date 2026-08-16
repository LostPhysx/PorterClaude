// OWNER: F2. One xterm.js terminal bound to one /api/terminals websocket.
// Wire protocol: docs/design/api.md "WebSocket: terminals" + server/src/terminals/protocol.ts.
// F1 must not edit this file.
//
// Globals provided by index.html classic scripts: Terminal, FitAddon, WebLinksAddon.
import { api, terminalWsUrl, TERMINAL_NAME_RE } from './api.js';
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
/** A socket that stayed open at least this long resets the backoff. */
export const STABLE_MS = 10000;

/** @typedef {'bash'|'claude'|'sh'} Shell */
/** @typedef {'connecting'|'open'|'closed'|'reconnecting'|'fatal'} PaneStatus */

const ANSI_DIM = '\x1b[2m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

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

/** Backoff with +-25% jitter so many panes do not reconnect in lockstep. */
function jitter(ms) {
  const spread = ms * 0.25;
  return Math.round(Math.max(250, ms - spread + Math.random() * spread * 2));
}

/**
 * A terminal pane: xterm instance + websocket + reconnect state machine.
 *
 * Lifecycle used by code.js:
 *   const pane = new TerminalPane({ session, shell, name });
 *   pane.attach(paneRootEl);    // creates the xterm + note strip, opens the socket
 *   pane.fit();                 // on GoldenLayout resize (debounced by code.js)
 *   pane.focus();
 *   pane.dispose();             // on pane close / layout destroy
 *
 * The pane owns its whole DOM subtree:
 *   <div class="pc-pane">            <- the element handed to attach()
 *     <div class="pc-pane-notes">    <- warning / reconnect / error strips
 *     <div class="pc-pane-term">     <- xterm mounts here
 */
export class TerminalPane {
  /**
   * @param {{session:string, shell:Shell, name:string,
   *          theme?:'dark'|'light',
   *          onStatus?:(status:PaneStatus, info?:object)=>void,
   *          onTitle?:(title:string)=>void,
   *          onRequestClose?:()=>void}} opts
   */
  constructor(opts) {
    this.session = opts.session;
    this.shell = opts.shell;
    this.name = opts.name;
    this.onStatus = opts.onStatus ?? (() => {});
    this.onTitle = opts.onTitle ?? (() => {});
    this.onRequestClose = opts.onRequestClose ?? (() => {});
    /** @type {PaneStatus} */
    this.status = 'closed';
    /** @type {WebSocket|null} */
    this.ws = null;
    /** @type {any} xterm Terminal */
    this.term = null;
    this.fitAddon = null;
    this.tmux = null;
    this.terminalId = null;
    this.reattached = false;
    this.disposed = false;
    this._retryDelay = RECONNECT_MIN_MS;
    this._theme = opts.theme === 'light' ? 'light' : 'dark';
    this._enc = new TextEncoder();
    /** @type {HTMLElement|null} */
    this.rootEl = null;
    /** @type {HTMLElement|null} */
    this.notesEl = null;
    /** @type {HTMLElement|null} */
    this.termEl = null;
    this._pingTimer = null;
    this._retryTimer = null;
    this._countdownTimer = null;
    this._fitFrame = null;
    this._openedAt = 0;
    this._lastError = null;
    this._awaitEnter = false;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create the xterm inside `el` and open the socket.
   * @param {HTMLElement} el the `.pc-pane` root
   */
  attach(el) {
    if (this.disposed || !el) return;
    this.rootEl = el;
    el.classList.add('pc-pane');

    this.notesEl = document.createElement('div');
    this.notesEl.className = 'pc-pane-notes';
    el.appendChild(this.notesEl);

    this.termEl = document.createElement('div');
    this.termEl.className = 'pc-pane-term';
    el.appendChild(this.termEl);

    this.term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: THEMES[this._theme],
    });

    try {
      this.fitAddon = new FitAddon.FitAddon();
      this.term.loadAddon(this.fitAddon);
    } catch (err) {
      console.error('[terminal] fit addon unavailable', err);
      this.fitAddon = null;
    }
    try {
      this.term.loadAddon(new WebLinksAddon.WebLinksAddon());
    } catch (err) {
      console.debug('[terminal] web-links addon unavailable', err);
    }

    this.term.open(this.termEl);

    this.term.onData((data) => this._onData(data));
    this.term.onResize(({ cols, rows }) => {
      this.sendJson({ type: 'resize', cols, rows });
    });
    this.term.onTitleChange((title) => {
      if (title) this.onTitle(title);
    });

    this._fitSoon();
    this.connect();
  }

  /** (Re)open the websocket. Safe to call at any time; a live socket is kept. */
  connect() {
    if (this.disposed) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this._clearRetryTimer();
    this._awaitEnter = false;
    this._lastError = null;
    this._setStatus('connecting');
    this._clearNote('conn');

    const { cols, rows } = this._size();
    let ws;
    try {
      ws = new WebSocket(terminalWsUrl({
        session: this.session, shell: this.shell, name: this.name, cols, rows,
      }));
    } catch (err) {
      console.error('[terminal] cannot open websocket', err);
      this._scheduleReconnect('Could not open the connection');
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this._openedAt = 0;

    ws.onopen = () => {
      if (this.disposed || this.ws !== ws) { try { ws.close(CLOSE.normal); } catch { /* ignore */ } return; }
      this._openedAt = Date.now();
      this._startPing();
    };
    ws.onmessage = (ev) => {
      if (this.disposed || this.ws !== ws) return;
      try {
        if (typeof ev.data === 'string') {
          let msg = null;
          try { msg = JSON.parse(ev.data); } catch { msg = null; }
          if (msg && typeof msg === 'object') this.handleServerMessage(msg);
          return;
        }
        if (ev.data instanceof ArrayBuffer) {
          this.term?.write(new Uint8Array(ev.data));
        }
      } catch (err) {
        console.error('[terminal] message handling failed', err);
      }
    };
    ws.onerror = () => { /* the close event carries the reason */ };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._stopPing();
      if (this.disposed) return;
      try {
        this._onClose(ev);
      } catch (err) {
        console.error('[terminal] close handling failed', err);
      }
    };
  }

  /**
   * Handle one JSON ServerMessage (ready|info|error|exit|pong).
   * @param {{type:string, [k:string]:any}} msg
   */
  handleServerMessage(msg) {
    switch (msg.type) {
      case 'ready': {
        this.terminalId = msg.terminalId ?? null;
        this.tmux = msg.tmux !== false;
        this.reattached = msg.reattached === true;
        this._retryDelay = RECONNECT_MIN_MS;
        this._clearNote('conn');
        this._setStatus('open', { tmux: this.tmux, reattached: this.reattached });
        if (this.tmux === false) {
          this._renderNote('tmux', {
            variant: 'warning',
            text: 'no tmux in this image — reloading the page kills this shell',
          });
        } else {
          this._clearNote('tmux');
        }
        if (this.reattached) this._writeDim(`reattached to tmux session pc_${this.name}`);
        // The fit addon has real numbers by now: tell the server our true size.
        this.fit();
        const { cols, rows } = this._size();
        this.sendJson({ type: 'resize', cols, rows });
        break;
      }
      case 'info':
        if (msg.message) this._writeDim(String(msg.message));
        break;
      case 'error':
        this._lastError = String(msg.message || msg.code || 'terminal error');
        this.term?.writeln(`\r\n${ANSI_RED}${this._lastError}${ANSI_RESET}`);
        break;
      case 'exit':
        this._writeDim(`[process exited${msg.code === null || msg.code === undefined ? '' : ` (${msg.code})`}]`);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  /**
   * Send a JSON ClientMessage as a TEXT frame (binary frames are raw stdin).
   * @param {{type:string, [k:string]:any}} msg
   */
  sendJson(msg) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      console.debug('[terminal] send failed', err);
      return false;
    }
  }

  /** Send SIGINT through the control channel. */
  interrupt() {
    return this.sendJson({ type: 'signal', signal: 'SIGINT' });
  }

  /** FitAddon.fit(), guarded against zero-size (hidden) containers. */
  fit() {
    if (this.disposed || !this.term || !this.fitAddon) return;
    const el = this.termEl;
    if (!el || el.clientWidth < 24 || el.clientHeight < 24) return;
    try {
      this.fitAddon.fit();
    } catch (err) {
      console.debug('[terminal] fit failed', err);
    }
  }

  focus() {
    this.term?.focus();
  }

  /** Repaint colours after a theme switch. @param {'dark'|'light'} theme */
  setTheme(theme) {
    this._theme = theme === 'light' ? 'light' : 'dark';
    if (!this.term) return;
    try {
      this.term.options.theme = THEMES[this._theme];
    } catch (err) {
      console.debug('[terminal] theme switch failed', err);
    }
  }

  /** Idempotent teardown: timers, socket, xterm, DOM. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._stopPing();
    this._clearRetryTimer();
    if (this._fitFrame) { this._fitFrame = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
      try { ws.close(CLOSE.normal, 'pane closed'); } catch { /* ignore */ }
    }
    const term = this.term;
    this.term = null;
    this.fitAddon = null;
    if (term) {
      try { term.dispose(); } catch (err) { console.debug('[terminal] dispose failed', err); }
    }
    if (this.notesEl) { this.notesEl.remove(); this.notesEl = null; }
    if (this.termEl) { this.termEl.remove(); this.termEl = null; }
    this.rootEl = null;
    this.status = 'closed';
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** @param {string} data keystrokes from xterm */
  _onData(data) {
    if (this.disposed) return;
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(this._enc.encode(data));
      } catch (err) {
        console.debug('[terminal] stdin send failed', err);
      }
      return;
    }
    // Socket closed normally: Enter restarts it (same name => tmux reattach).
    if (this._awaitEnter && (data === '\r' || data === '\n')) {
      this._awaitEnter = false;
      this.term?.writeln('');
      this.connect();
    }
  }

  /** @param {{code:number, reason?:string}} ev */
  _onClose(ev) {
    const code = ev.code || 0;
    const stable = this._openedAt > 0 && Date.now() - this._openedAt > STABLE_MS;
    if (stable) this._retryDelay = RECONNECT_MIN_MS;
    const detail = this._lastError || (ev.reason ? String(ev.reason) : '');

    if (code === CLOSE.normal || code === 1005) {
      this._setStatus('closed');
      this._awaitEnter = true;
      this._writeDim('[process exited] press Enter to restart');
      this._clearNote('conn');
      return;
    }

    if (code === CLOSE.unauthorized) {
      this._setStatus('fatal');
      this._renderNote('conn', {
        variant: 'danger',
        text: 'your session expired — sign in again',
      });
      bus.emit(EVENTS.AUTH_REQUIRED, {});
      return;
    }

    if (code === CLOSE.sessionNotFound) {
      // The container/session is gone for good: do not retry forever (frontend.md 5.6).
      this._setStatus('fatal');
      this._renderNote('conn', {
        variant: 'danger',
        text: detail || `session "${this.session}" no longer exists`,
        actions: [
          { label: 'Retry', onClick: () => this.connect() },
          { label: 'Close pane', onClick: () => this.onRequestClose() },
        ],
      });
      return;
    }

    if (code === CLOSE.sessionNotRunning) {
      this._scheduleReconnect(detail || `session "${this.session}" is not running`, [
        { label: 'Start session', onClick: () => this._startSession() },
      ]);
      return;
    }

    // A socket that never opened means the handshake itself failed. The browser reports a
    // refused upgrade as 1006 (it never sees the HTTP 401), so ask the server who we are
    // before assuming this is a transient outage - otherwise an expired cookie would make
    // every pane retry forever without ever showing the login modal.
    if (!this._openedAt) {
      void this._checkAuthThenReconnect(detail || `connection lost (code ${code})`);
      return;
    }

    // 4400 / 4502 / 4500 / 1006 / anything else -> backoff and keep trying.
    this._scheduleReconnect(detail || `connection lost (code ${code})`);
  }

  /**
   * Distinguish "the upgrade was refused because we are logged out" from "the server is
   * unreachable". GET /api/auth/session is public, so it never triggers an auth loop.
   * @param {string} reason
   */
  async _checkAuthThenReconnect(reason) {
    let loggedOut = false;
    try {
      const res = await api.auth.session();
      loggedOut = !!res && res.authenticated === false;
    } catch {
      loggedOut = false; // server unreachable -> treat as a transient failure
    }
    if (this.disposed) return;
    if (loggedOut) {
      this._setStatus('fatal');
      this._renderNote('conn', { variant: 'danger', text: 'your session expired - sign in again' });
      bus.emit(EVENTS.AUTH_REQUIRED, {});
      return;
    }
    this._scheduleReconnect(reason);
  }

  /** Ask the API to start the session, then reconnect immediately on success. */
  async _startSession() {
    this._renderNote('conn', { variant: 'warning', text: `starting session "${this.session}"…` });
    try {
      await api.sessions.start(this.session);
      this._retryDelay = RECONNECT_MIN_MS;
      this._clearRetryTimer();
      this.connect();
    } catch (err) {
      this._scheduleReconnect((err && err.message) || 'could not start the session', [
        { label: 'Start session', onClick: () => this._startSession() },
      ]);
    }
  }

  /**
   * Retry with exponential backoff + jitter and show the countdown in the pane.
   * @param {string} reason @param {{label:string, onClick:()=>void}[]} [extraActions]
   */
  _scheduleReconnect(reason, extraActions = []) {
    if (this.disposed) return;
    this._clearRetryTimer();
    this._setStatus('reconnecting');
    const delay = jitter(this._retryDelay);
    this._retryDelay = Math.min(RECONNECT_MAX_MS, this._retryDelay * 2);
    let remaining = Math.ceil(delay / 1000);

    const paint = () => {
      this._renderNote('conn', {
        variant: 'warning',
        text: `${reason} — reconnecting in ${remaining}s`,
        actions: [{ label: 'Retry now', onClick: () => this.connect() }, ...extraActions],
      });
    };
    paint();
    this._countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(this._countdownTimer);
        this._countdownTimer = null;
        return;
      }
      paint();
    }, 1000);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.connect();
    }, delay);
  }

  _clearRetryTimer() {
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this._countdownTimer) { clearInterval(this._countdownTimer); this._countdownTimer = null; }
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      this.sendJson({ type: 'ping' });
    }, PING_MS);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  /** @returns {{cols:number, rows:number}} */
  _size() {
    const cols = this.term?.cols;
    const rows = this.term?.rows;
    return {
      cols: Number.isFinite(cols) && cols > 0 ? cols : 80,
      rows: Number.isFinite(rows) && rows > 0 ? rows : 24,
    };
  }

  /** @param {PaneStatus} status @param {object} [info] */
  _setStatus(status, info) {
    this.status = status;
    try {
      this.onStatus(status, info);
    } catch (err) {
      console.error('[terminal] onStatus handler threw', err);
    }
  }

  _writeDim(text) {
    this.term?.writeln(`${ANSI_DIM}${text}${ANSI_RESET}`);
  }

  _fitSoon() {
    if (this.disposed) return;
    if (this._fitFrame) return;
    this._fitFrame = requestAnimationFrame(() => {
      this._fitFrame = null;
      this.fit();
    });
  }

  /**
   * Create/update one note strip. Text is set with textContent (never innerHTML).
   * @param {string} id @param {{variant?:'info'|'warning'|'danger', text:string,
   *        actions?:{label:string,onClick:()=>void}[]}} opts
   */
  _renderNote(id, opts) {
    if (!this.notesEl) return;
    let el = this.notesEl.querySelector(`[data-note="${id}"]`);
    const isNew = !el;
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('data-note', id);
      this.notesEl.appendChild(el);
    }
    el.className = `pc-pane-note pc-pane-note-${opts.variant || 'info'}`;
    el.textContent = '';
    const span = document.createElement('span');
    span.className = 'pc-pane-note-text';
    span.textContent = opts.text;
    el.appendChild(span);
    for (const action of opts.actions || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pc-pane-note-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        try { action.onClick(); } catch (err) { console.error('[terminal] note action threw', err); }
      });
      el.appendChild(btn);
    }
    if (isNew) this._fitSoon();
  }

  _clearNote(id) {
    if (!this.notesEl) return;
    const el = this.notesEl.querySelector(`[data-note="${id}"]`);
    if (el) {
      el.remove();
      this._fitSoon();
    }
  }
}

/** xterm colour themes; keys match <html data-bs-theme>. */
export const THEMES = {
  dark: {
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#58a6ff',
    cursorAccent: '#0d1117',
    selectionBackground: '#264f78',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  },
  light: {
    background: '#ffffff',
    foreground: '#24292f',
    cursor: '#0969da',
    cursorAccent: '#ffffff',
    selectionBackground: '#add6ff',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#4d2d00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f',
  },
};
