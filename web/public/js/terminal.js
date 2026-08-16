// OWNER: F2. One xterm.js terminal bound to one /api/terminals websocket.
// Wire protocol: docs/design/api.md "WebSocket: terminals" + server/src/terminals/protocol.ts.
// F1 must not edit this file.
//
// Globals provided by index.html classic scripts: Terminal, FitAddon, WebLinksAddon.
import { api, terminalWsUrl, formatShellParam, TERMINAL_NAME_RE, AGENT_ID_RE } from './api.js';
import { bus, EVENTS } from './bus.js';

/** Close codes (mirror of server/src/terminals/protocol.ts TERMINAL_CLOSE). FROZEN. */
export const CLOSE = Object.freeze({
  normal: 1000,
  /** client -> server: the user closed this pane, kill its tmux session (INT-06) */
  paneClosed: 4001,
  badRequest: 4400,
  unauthorized: 4401,
  sessionNotFound: 4404,
  sessionNotRunning: 4409,
  /** v0.2: the agent is unknown or not mounted into this session - TERMINAL, never retry */
  agentNotAvailable: 4410,
  /** v0.2: the session's host is gone / unsupported - TERMINAL, never retry */
  hostUnavailable: 4411,
  backendError: 4502,
  internal: 4500,
});

/**
 * Client -> server "the user closed this pane on purpose" (INT-06, api.md ClientMessage).
 * Closing a pane must also end the tmux session `pc_<name>` inside the container, otherwise
 * closed panes leave detached-but-alive shells (and their processes) behind. A reload or a
 * lost connection must NOT do this - that is exactly what tmux reattach is for - so it is
 * only ever sent from `dispose({ kill: true })`.
 *
 * Both carriers the server accepts are used, in order: the `kill` frame, then the
 * `CLOSE.paneClosed` close code as the fallback for a teardown that could not send a frame.
 */
export const KILL_MESSAGE = Object.freeze({ type: 'kill' });

/** Reconnect backoff per api.md: 1s -> 15s with jitter. */
export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 15000;
/** Client keepalive: send {type:'ping'} at this interval (server pings every 30s). */
export const PING_MS = 25000;
/** A socket that stayed open at least this long resets the backoff. */
export const STABLE_MS = 10000;

/**
 * Exec exit statuses that mean "the container went away under us" rather than "the shell
 * exited": 128+SIGKILL and 128+SIGTERM, i.e. what `docker stop` / `docker kill` produce.
 * For these the pane must offer "Start session" instead of claiming the shell exited
 * (INT-05; api.md "WebSocket: terminals").
 */
export const CONTAINER_SIGNAL_EXITS = Object.freeze([137, 143]);

/**
 * After such an exit (and after any close that leaves the pane on a dead shell) the pane
 * confirms the session state with GET /api/sessions/<name>. Stopping a container needs
 * ~170 ms to land, far longer than the exec takes to die, so a single read right after the
 * socket closed still answers "running" - poll for a short while instead (INT-05).
 */
export const SESSION_STATE_POLL_MS = 3000;
export const SESSION_STATE_POLL_INTERVAL_MS = 250;

/** @typedef {'bash'|'sh'|'agent'} Shell */
/** @typedef {'connecting'|'open'|'closed'|'reconnecting'|'fatal'} PaneStatus */

const ANSI_DIM = '\x1b[2m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

/**
 * The middle part of a pane name. FROZEN (v0.2): an AGENT pane uses the AGENT ID, so a
 * claude pane is still called `<session>-claude-<n>` - exactly the v0.1 name, which is what
 * lets an upgraded layout reattach to its existing tmux sessions.
 * @param {Shell} shell @param {string|null} [agentId]
 * @returns {string}
 */
export function terminalSlug(shell, agentId = null) {
  if (shell === 'agent') {
    if (!agentId || !AGENT_ID_RE.test(String(agentId))) throw new Error(`invalid agent id: ${agentId}`);
    return String(agentId);
  }
  return shell === 'sh' ? 'sh' : 'bash';
}

/**
 * Build the stable pane name that drives the tmux session (`pc_<name>`).
 * FROZEN: code.js persists this in the layout, so the algorithm must stay stable.
 * @param {string} session @param {string} slug terminalSlug(shell, agentId)
 * @param {number} n 1-based per session+slug
 * @returns {string} e.g. "web-claude-2"
 */
export function makeTerminalName(session, slug, n) {
  const name = `${session}-${slug}-${n}`.toLowerCase();
  if (!TERMINAL_NAME_RE.test(name)) throw new Error(`invalid terminal name: ${name}`);
  return name;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
   * @param {{session:string, shell:Shell, agentId?:string|null, name:string,
   *          theme?:'dark'|'light',
   *          onStatus?:(status:PaneStatus, info?:object)=>void,
   *          onTitle?:(title:string)=>void,
   *          onRequestClose?:()=>void,
   *          onOpenBash?:()=>void}} opts
   *        v0.2: `agentId` is REQUIRED when `shell === 'agent'`; `onOpenBash` is the action
   *        the pane offers after close 4410 (agent_not_available).
   */
  constructor(opts) {
    this.session = opts.session;
    this.shell = opts.shell;
    /** @type {string|null} set exactly when shell === 'agent' (v0.2) */
    this.agentId = opts.agentId ?? null;
    /** @type {string|null} the host the server resolved this session to (from `ready`) */
    this.hostId = null;
    this.name = opts.name;
    this.onStatus = opts.onStatus ?? (() => {});
    this.onTitle = opts.onTitle ?? (() => {});
    this.onRequestClose = opts.onRequestClose ?? (() => {});
    this.onOpenBash = opts.onOpenBash ?? (() => {});
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
    /** exec status of the last `exit` frame, rendered when the socket closes */
    this._exitCode = null;
    /** that status when it looks like a container stop (137/143): no exit banner is shown */
    this._signalExit = null;
    /** the "[process exited ...]" line on screen, so a later "not running" answer replaces it */
    this._exitBanner = null;
    /** wipe the (now meaningless) scrollback on the next `ready`: the container restarted */
    this._resetOnReady = false;
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
    this._exitCode = null;
    this._signalExit = null;
    this._exitBanner = null;
    this._setStatus('connecting');
    this._clearNote('conn');

    const { cols, rows } = this._size();
    let ws;
    try {
      ws = new WebSocket(terminalWsUrl({
        session: this.session,
        // v0.2 wire value: 'bash' | 'sh' | 'agent:<agentId>' (api.js formatShellParam)
        shell: formatShellParam(this.shell, this.agentId),
        name: this.name,
        cols,
        rows,
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
        // v0.2: the server reports which HOST it routed the session to and which AGENT it
        // actually started - both are what the pane hands back through onStatus.
        this.hostId = typeof msg.hostId === 'string' ? msg.hostId : null;
        if (typeof msg.agentId === 'string') this.agentId = msg.agentId;
        this.tmux = msg.tmux !== false;
        this.reattached = msg.reattached === true;
        this._retryDelay = RECONNECT_MIN_MS;
        this._clearNote('conn');
        // a reconnect / "Start session" succeeded: nothing from the dead shell is current
        this._exitCode = null;
        this._signalExit = null;
        this._exitBanner = null;
        // The container was stopped and started again while this pane was open: everything
        // on screen belongs to a dead shell (and would keep showing a stale exit banner),
        // so start from a clean buffer. INT-05.
        if (this._resetOnReady) {
          this._resetOnReady = false;
          try { this.term?.reset(); } catch (err) { console.debug('[terminal] reset failed', err); }
        }
        this._setStatus('open', {
          tmux: this.tmux,
          reattached: this.reattached,
          hostId: this.hostId,
          agentId: this.agentId,
        });
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
      case 'exit': {
        const code = msg.code === null || msg.code === undefined ? null : Number(msg.code);
        this._exitCode = code;
        // 137/143 = 128+SIGKILL/SIGTERM: the container was stopped under this shell, the user
        // did not type `exit`. No exit banner is ever printed for those - the close handler
        // shows the "session is not running" note with its Start action instead (INT-05).
        this._signalExit = code !== null && CONTAINER_SIGNAL_EXITS.includes(code) ? code : null;
        break;
      }
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

  /**
   * Idempotent teardown: timers, socket, xterm, DOM.
   *
   * `kill: true` additionally asks the server to end the tmux session inside the container
   * (INT-06). Pass it ONLY for an explicit pane close by the user - a reload, a layout
   * restore or an auth-loss teardown must leave the shell running so reconnecting with the
   * same pane name reattaches. Nothing can be killed when the socket is not open (the pane
   * was already disconnected); tmux then keeps the shell, as it does today.
   * @param {{kill?:boolean}} [opts]
   */
  dispose(opts = {}) {
    if (this.disposed) return;
    const kill = opts.kill === true;
    this.disposed = true;
    this._stopPing();
    this._clearRetryTimer();
    if (this._fitFrame) { this._fitFrame = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
      // The text frame is queued before the close frame, so a server that understands it
      // sees the kill request first; the close code repeats the intent for a server that
      // only looks at that.
      if (kill && ws.readyState === 1) {
        try { ws.send(JSON.stringify(KILL_MESSAGE)); } catch { /* ignore */ }
      }
      try {
        ws.close(kill ? CLOSE.paneClosed : CLOSE.normal, kill ? 'pane closed by user' : 'pane closed');
      } catch { /* ignore */ }
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
      this._clearNote('conn');
      if (this._signalExit !== null) {
        // The exec died with its container (137/143), so never claim the shell exited: show
        // the "not running / Start session" note right away and confirm it in the background
        // (INT-05). The server closes 4409 for this; 1000 is the racing case.
        this._showNotRunningNote();
        void this._confirmSignalExit();
        return;
      }
      this._writeBanner(
        `[process exited${this._exitCode === null ? '' : ` (${this._exitCode})`}] press Enter to restart`,
      );
      void this._noteIfSessionStopped();
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

    // v0.2 TERMINAL conditions - never auto-reconnect (api.md "WebSocket: terminals").
    if (code === CLOSE.agentNotAvailable) {
      this._setStatus('fatal');
      // TODO(F2): wording - `the agent "<label>" is not available in this session` plus
      // "enable it on the host (Settings, Agents), sync the tools volume and recreate the
      // session". Keep the two actions below.
      this._renderNote('conn', {
        variant: 'danger',
        text: detail || `agent "${this.agentId || '?'}" is not available in this session`,
        actions: [
          { label: 'Open bash instead', onClick: () => this.onOpenBash() },
          { label: 'Close pane', onClick: () => this.onRequestClose() },
        ],
      });
      return;
    }

    if (code === CLOSE.hostUnavailable) {
      this._setStatus('fatal');
      // TODO(F2): wording - "the host of this session is unavailable" + the host id when the
      // `ready` frame had already delivered one. No retry, no api call.
      this._renderNote('conn', {
        variant: 'danger',
        text: detail || 'the host of this session is unavailable',
        actions: [{ label: 'Close pane', onClick: () => this.onRequestClose() }],
      });
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
      this._signalExit = null;
      this._resetOnReady = true;
      // a "[process exited]" line printed a moment ago was wrong: overwrite it
      this._replaceBanner(detail || `session "${this.session}" is not running`);
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

  /**
   * Defence in depth for "the session was stopped while this pane was open": the server
   * closes 4409 in that case, but a racing stop (or an older server) can still close 1000,
   * which alone would only say "[process exited]". Confirm the session state and, when it is
   * not running, show the same note the 4409 path shows - replacing the exit line. INT-05.
   */
  async _noteIfSessionStopped() {
    const stopped = await this._sessionStopped();
    // only decorate the close we are still sitting in
    if (this.disposed || this.ws || !this._awaitEnter) return;
    if (stopped !== true) return;
    this._showNotRunningNote();
  }

  /**
   * The exec ended 137/143 and the "not running" note is already on screen: make sure that
   * was true. If the container is up after all (something SIGKILLed the shell itself) the
   * note would be a lie - drop it and reconnect, tmux still has the pane. INT-05.
   */
  async _confirmSignalExit() {
    const stopped = await this._sessionStopped();
    if (this.disposed || this.ws || !this._awaitEnter) return;
    if (stopped !== false) return; // not running, or no answer: keep the note
    this._resetOnReady = false;
    this._clearNote('conn');
    this._scheduleReconnect('the shell was terminated');
  }

  /**
   * Poll GET /api/sessions/<name> until it reports a non-running state, for at most
   * SESSION_STATE_POLL_MS. The first answer after a stop is regularly a stale "running".
   * @returns {Promise<boolean|null>} true = not running, false = running, null = cannot tell
   */
  async _sessionStopped() {
    const deadline = Date.now() + SESSION_STATE_POLL_MS;
    for (;;) {
      let status = null;
      try {
        const res = await api.sessions.get(this.session);
        const view = (res && res.session) || null;
        status = view && typeof view.status === 'string' ? view.status : null;
      } catch {
        return null; // offline / 401 / gone: cannot tell
      }
      if (this.disposed || !status) return null;
      if (status !== 'running') return true;
      if (Date.now() >= deadline) return false;
      await sleep(SESSION_STATE_POLL_INTERVAL_MS);
      if (this.disposed) return null;
    }
  }

  /** The pane's "session ... is not running / Start session" state (INT-05). */
  _showNotRunningNote() {
    this._signalExit = null;
    // the container is down: whatever is on screen died with it
    this._resetOnReady = true;
    const text = `session "${this.session}" is not running`;
    this._replaceBanner(text);
    this._renderNote('conn', {
      variant: 'warning',
      text,
      actions: [{ label: 'Start session', onClick: () => this._startSession() }],
    });
  }

  /** Write an exit banner and remember it, so a later "not running" answer can replace it. */
  _writeBanner(text) {
    this._exitBanner = text;
    this._writeDim(text);
  }

  /**
   * Replace the exit banner written a moment ago - nothing else can have been written after
   * it, the socket is closed - with `text`. No-op when no banner is on screen.
   * @param {string} text
   */
  _replaceBanner(text) {
    if (!this._exitBanner) return;
    this._exitBanner = null;
    // cursor up, column 0, erase the line, then the correction
    this.term?.write(`\x1b[A\r\x1b[2K${ANSI_DIM}${text}${ANSI_RESET}\r\n`);
  }

  /** Ask the API to start the session, then reconnect immediately on success. */
  async _startSession() {
    this._renderNote('conn', { variant: 'warning', text: `starting session "${this.session}"…` });
    this._signalExit = null;
    this._exitBanner = null;
    this._resetOnReady = true;
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
