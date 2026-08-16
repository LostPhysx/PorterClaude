// OWNER: F1. CONTRACT: the method surface below is FROZEN - F2 calls api.sessions.list(),
// api.settings.get(), api.settings.putUi() and terminalWsUrl(). Do not rename/remove; adding
// is fine. Every path/shape comes from docs/design/api.md (authoritative).
//
// `request()` and the ApiError plumbing are implemented below; every endpoint helper is
// already wired and must keep working exactly as written.
import { bus, EVENTS } from './bus.js';

export const API_BASE = '/api';

/** Error thrown by every failed call. `code` is the api.md error code. */
export class ApiError extends Error {
  /**
   * @param {string} code   api.md error code, or 'network' / 'timeout' / 'parse_error'
   * @param {number} status HTTP status (0 when the request never completed)
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(code, status, message, details = null) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  get isAuth() {
    return this.status === 401 || this.code === 'unauthorized';
  }

  get isBackendMissing() {
    return this.code === 'backend_not_configured';
  }
}

/** Default per-request timeout (ms). Builds/pulls are polled, so nothing here is long. */
export const DEFAULT_TIMEOUT_MS = 30000;

/** Build '/api/<path>?<query>' dropping undefined/null/'' query values. */
function buildUrl(path, query) {
  let url = `${API_BASE}${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      qs.set(key, String(value));
    }
    const s = qs.toString();
    if (s) url += `${url.includes('?') ? '&' : '?'}${s}`;
  }
  return url;
}

/**
 * Paths whose 401 means "wrong credentials in this form", not "session expired".
 * A 401 from these must never tear the UI down into the login modal.
 */
const CREDENTIAL_CHECK_PATHS = ['/auth/', '/settings/password'];

function isCredentialCheckPath(path) {
  return CREDENTIAL_CHECK_PATHS.some((p) => path === p || path.startsWith(p));
}

/** Turn a failed jqXHR into an ApiError following the api.md envelope. */
function errorFromXhr(jqXHR, textStatus) {
  const status = jqXHR ? jqXHR.status || 0 : 0;
  let envelope = jqXHR && jqXHR.responseJSON ? jqXHR.responseJSON : null;
  if (!envelope && jqXHR && typeof jqXHR.responseText === 'string' && jqXHR.responseText) {
    try {
      envelope = JSON.parse(jqXHR.responseText);
    } catch {
      envelope = null;
    }
  }
  const err = envelope && envelope.error ? envelope.error : null;
  if (err && err.code) {
    return new ApiError(String(err.code), status, err.message || String(err.code), err.details ?? null);
  }
  if (textStatus === 'timeout') {
    return new ApiError('timeout', 0, 'The server took too long to answer');
  }
  if (status === 0) {
    return new ApiError('network', 0, 'Server unreachable');
  }
  if (textStatus === 'parsererror') {
    return new ApiError('parse_error', status, 'The server sent a malformed response');
  }
  return new ApiError('internal', status, (jqXHR && jqXHR.statusText) || 'Request failed');
}

/**
 * The single HTTP entry point. Everything else delegates here.
 *
 * Same-origin, so the `pc_session` cookie rides along automatically (no CORS options).
 * Resolves with the parsed JSON body, or `null` for 204/empty responses; rejects with an
 * ApiError. A 401 emits `auth:required` once before rejecting, except on endpoints where
 * 401 means "the credentials you just typed are wrong" rather than "your session is gone":
 * `/auth/*`, `/settings/password` (api.md: 401 = wrong currentPassword, the caller's own
 * cookie stays valid and is refreshed on success), and any call passing `noAuthEvent`.
 *
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {string} path path under /api, e.g. '/sessions/web/start'
 * @param {{ body?: unknown, query?: Record<string, unknown>, timeoutMs?: number,
 *           noAuthEvent?: boolean }} [opts]
 * @returns {Promise<any>}
 */
export function request(method, path, opts = {}) {
  const url = buildUrl(path, opts.query);
  const hasBody = opts.body !== undefined && opts.body !== null;
  return new Promise((resolve, reject) => {
    $.ajax({
      url,
      method,
      dataType: 'json',
      contentType: hasBody ? 'application/json' : false,
      data: hasBody ? JSON.stringify(opts.body) : undefined,
      timeout: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
    })
      .done((data, _textStatus, jqXHR) => {
        if (!jqXHR || jqXHR.status === 204 || jqXHR.status === 205 || data === undefined) {
          resolve(null);
          return;
        }
        resolve(data);
      })
      .fail((jqXHR, textStatus) => {
        const err = errorFromXhr(jqXHR, textStatus);
        if (err.status === 401 && !opts.noAuthEvent && !isCredentialCheckPath(path)) {
          bus.emit(EVENTS.AUTH_REQUIRED, {});
        }
        reject(err);
      });
  });
}

const get = (p, query) => request('GET', p, { query });
const post = (p, body) => request('POST', p, { body });
const put = (p, body) => request('PUT', p, { body });
const del = (p, query) => request('DELETE', p, { query });

export const api = {
  // ---- health / auth ----------------------------------------------------
  health: () => get('/health'),
  auth: {
    /** @returns {Promise<{authenticated:boolean, needsSetup:boolean}>} */
    session: () => get('/auth/session'),
    /** @returns {Promise<{authenticated:boolean}>} */
    login: (password) => post('/auth/login', { password }),
    logout: () => post('/auth/logout', {}),
  },

  // ---- settings ---------------------------------------------------------
  settings: {
    /** @returns {Promise<{backend:any, general:any, ui:{layout:any, theme:string}, auth:{passwordSet:boolean}}>} */
    get: () => get('/settings'),
    /** @param {{kind:'portainer'|'socket'|'none', portainer?:object, socket?:object}} input */
    putBackend: (input) => put('/settings/backend', input),
    /** @param {{kind:'portainer'|'socket', portainer?:object, socket?:object}} input */
    testBackend: (input) => post('/settings/backend/test', input),
    /** @param {{url?:string, apiKey?:string, insecureTls?:boolean}} [input] */
    endpoints: (input = {}) => post('/settings/backend/endpoints', input),
    putGeneral: (partial) => put('/settings/general', partial),
    /** @param {{layout?:unknown, theme?:'auto'|'light'|'dark'}} ui */
    putUi: (ui) => put('/settings/ui', ui),
    changePassword: (currentPassword, newPassword) =>
      // noAuthEvent: a 401 here means the typed currentPassword was wrong; the session cookie
      // is untouched, so this must not trigger the global re-login flow.
      request('POST', '/settings/password', {
        body: { currentPassword, newPassword },
        noAuthEvent: true,
      }),
    vendor: () => get('/settings/vendor'),
  },

  // ---- docker read-only helpers ----------------------------------------
  docker: {
    info: () => get('/docker/info'),
    /** @param {{all?:boolean, managed?:boolean}} [opts] */
    containers: (opts = {}) =>
      get('/docker/containers', { all: opts.all ? 1 : undefined, managed: opts.managed ? 1 : undefined }),
    volumes: () => get('/docker/volumes'),
    networks: () => get('/docker/networks'),
  },

  // ---- sessions ---------------------------------------------------------
  sessions: {
    /** @returns {Promise<{sessions: SessionView[]}>} */
    list: () => get('/sessions'),
    get: (name) => get(`/sessions/${encodeURIComponent(name)}`),
    create: (input) => post('/sessions', input),
    update: (name, input) => put(`/sessions/${encodeURIComponent(name)}`, input),
    /** @param {{removeVolumes?:boolean}} [opts] */
    remove: (name, opts = {}) =>
      del(`/sessions/${encodeURIComponent(name)}`, { removeVolumes: opts.removeVolumes ? 1 : undefined }),
    start: (name) => post(`/sessions/${encodeURIComponent(name)}/start`, {}),
    stop: (name) => post(`/sessions/${encodeURIComponent(name)}/stop`, {}),
    restart: (name) => post(`/sessions/${encodeURIComponent(name)}/restart`, {}),
    recreate: (name) => post(`/sessions/${encodeURIComponent(name)}/recreate`, {}),
    /** @param {{tail?:number, timestamps?:boolean}} [opts] */
    logs: (name, opts = {}) =>
      get(`/sessions/${encodeURIComponent(name)}/logs`, {
        tail: opts.tail, timestamps: opts.timestamps ? 1 : undefined,
      }),
    reconcile: () => post('/sessions/reconcile', {}),
  },

  // ---- images / recipes / jobs / tools ----------------------------------
  images: {
    list: () => get('/images'),
    recipes: () => get('/images/recipes'),
    /** @param {{noCache?:boolean, pull?:boolean}} [opts] */
    buildRecipe: (name, opts = {}) => post(`/images/recipes/${encodeURIComponent(name)}/build`, opts),
    jobs: () => get('/images/jobs'),
    /** @param {number} since append-only cursor (use the previous nextIndex) */
    job: (id, since = 0) => get(`/images/jobs/${encodeURIComponent(id)}`, { since }),
    cancelJob: (id) => post(`/images/jobs/${encodeURIComponent(id)}/cancel`, {}),
    tools: () => get('/images/tools'),
    syncTools: (force = false) => post('/images/tools/sync', { force }),
    validateCustom: (image) => post('/images/custom/validate', { image }),
    pull: (image) => post('/images/pull', { image }),
  },
};

// ---------------------------------------------------------------------------
// WebSocket helper (FROZEN, implemented - F2 uses this, do not change).
// ---------------------------------------------------------------------------

/** Pane names must match this so the derived tmux name `pc_<name>` is safe. */
export const TERMINAL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * Build the terminal websocket URL. The pc_session cookie rides along automatically
 * because this is same-origin.
 * @param {{session:string, shell:'bash'|'claude'|'sh', name:string, cols?:number, rows?:number}} opts
 * @returns {string}
 */
export function terminalWsUrl(opts) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams({ session: opts.session, shell: opts.shell, name: opts.name });
  if (opts.cols) qs.set('cols', String(opts.cols));
  if (opts.rows) qs.set('rows', String(opts.rows));
  return `${proto}//${window.location.host}${API_BASE}/terminals?${qs.toString()}`;
}

/** Re-exported so modules do not have to import bus.js just for the auth event. */
export { bus, EVENTS };
