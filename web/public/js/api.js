// OWNER: F1. CONTRACT: the method surface below is FROZEN - F2 calls api.sessions.list(),
// api.settings.get(), api.settings.putUi() and terminalWsUrl(). Do not rename/remove; adding
// is fine. Every path/shape comes from docs/design/api.md (authoritative).
//
// Only `request()` and `ApiError` plumbing are TODO(F1); every endpoint helper below is
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

/**
 * The single HTTP entry point. Everything else delegates here.
 *
 * TODO(F1):
 *  - use jQuery `$.ajax({ url, method, contentType:'application/json', dataType:'json',
 *    data: body ? JSON.stringify(body) : undefined, timeout })`; same-origin so the
 *    `pc_session` cookie is sent automatically (do NOT set withCredentials/CORS headers).
 *  - resolve with the parsed JSON body; resolve with `null` for 204/empty bodies.
 *  - on failure build an ApiError from the `{error:{code,message,details}}` envelope;
 *    fall back to ('network', 0, ...) when there is no JSON body (jqXHR.status === 0)
 *    and ('internal', status, statusText) otherwise.
 *  - on 401 for anything other than `/auth/*`: emit `bus.emit(EVENTS.AUTH_REQUIRED)`
 *    exactly once per failed request, then still reject with the ApiError.
 *  - `query`: append with URLSearchParams, dropping undefined/null/'' values.
 *
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {string} path path under /api, e.g. '/sessions/web/start'
 * @param {{ body?: unknown, query?: Record<string, unknown>, timeoutMs?: number }} [opts]
 * @returns {Promise<any>}
 */
export function request(method, path, opts = {}) {
  void method; void path; void opts;
  throw new Error('TODO(F1): implement request()');
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
      post('/settings/password', { currentPassword, newPassword }),
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
