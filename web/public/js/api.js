// OWNER: F1. CONTRACT: the method surface below is FROZEN and fully implemented by the
// planner - F1 does NOT rewrite it, F2 only calls it. Adding a helper is fine; renaming or
// changing a signature is a cross-package change (docs/design/frontend.md section 12).
//
// v0.2: every Docker-facing call is HOST SCOPED (`/api/hosts/:hostId/...`); the old
// `/api/settings/backend*` endpoints are gone. Containers stay flat - a container name is
// unique across hosts, which is also what lets the session websocket route container -> host.
// Every path/shape comes from docs/design/api.md (authoritative).
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

  /** v0.2: "this host has no usable connection yet" (was: no global backend). */
  get isBackendMissing() {
    return this.code === 'backend_not_configured';
  }

  /** v0.2: a reserved connection type (tcp/ssh) the server cannot talk to yet. */
  get isNotImplemented() {
    return this.code === 'not_implemented' || this.status === 501;
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
 * Paths whose 401 means "wrong credentials in this form", not "the login expired".
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
 * Same-origin, so the `pc_auth` cookie rides along automatically (no CORS options).
 * Resolves with the parsed JSON body, or `null` for 204/empty responses; rejects with an
 * ApiError. A 401 emits `auth:required` once before rejecting, except on endpoints where
 * 401 means "the credentials you just typed are wrong" rather than "your login is gone":
 * `/auth/*`, `/settings/password` (api.md: 401 = wrong currentPassword, the caller's own
 * cookie stays valid and is refreshed on success), and any call passing `noAuthEvent`.
 *
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {string} path path under /api, e.g. '/containers/web/start'
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

/**
 * Raw binary POST with upload progress. jQuery's $.ajax reports none, so this is a bare XHR;
 * the response envelope and the 401 handling match `request()` above.
 *
 * @param {string} path
 * @param {{query?:Record<string,unknown>, file:File|Blob, onProgress?:(fraction:number)=>void}} opts
 * @returns {Promise<any>}
 */
export function uploadBinary(path, opts) {
  const url = buildUrl(path, opts.query);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (opts.onProgress && xhr.upload) {
      xhr.upload.addEventListener('progress', (ev) => {
        if (ev.lengthComputable && ev.total > 0) opts.onProgress(ev.loaded / ev.total);
      });
    }
    xhr.addEventListener('error', () => reject(new ApiError('network', 0, 'Server unreachable')));
    xhr.addEventListener('abort', () => reject(new ApiError('network', 0, 'Upload cancelled')));
    xhr.addEventListener('load', () => {
      let parsed = null;
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        parsed = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed);
        return;
      }
      const err = errorFromXhr({ status: xhr.status, responseJSON: parsed, responseText: xhr.responseText }, 'error');
      if (err.status === 401) bus.emit(EVENTS.AUTH_REQUIRED, {});
      reject(err);
    });
    xhr.send(opts.file);
  });
}

const get = (p, query) => request('GET', p, { query });
const post = (p, body) => request('POST', p, { body });
const put = (p, body) => request('PUT', p, { body });
const del = (p, query) => request('DELETE', p, { query });

/** Path segment encoder used for every id/name that reaches a URL. */
const enc = encodeURIComponent;

/** `/hosts/<id>` prefix of every host-scoped route. FROZEN (api.md "Host-scoped URLs"). */
export function hostPath(hostId, suffix = '') {
  return `/hosts/${enc(String(hostId || ''))}${suffix}`;
}

export const api = {
  // ---- health / auth ----------------------------------------------------
  /** @returns {Promise<{status:'ok', version:string, uptimeSec:number,
   *                     hosts:{count:number, configured:boolean, defaultHostId:string|null}}>} */
  health: () => get('/health'),
  auth: {
    /** @returns {Promise<{authenticated:boolean, needsSetup:boolean}>} */
    me: () => get('/auth/me'),
    /** @returns {Promise<{authenticated:boolean}>} */
    login: (password) => post('/auth/login', { password }),
    logout: () => post('/auth/logout', {}),
  },

  // ---- settings (v0.2: NO `backend` section any more) --------------------
  settings: {
    /** @returns {Promise<{general:any, ui:{layout:any, theme:string}, auth:{passwordSet:boolean},
     *   hosts:{count:number, defaultHostId:string|null, socketAvailable:boolean, socketHostId:string|null}}>} */
    get: () => get('/settings'),
    putGeneral: (partial) => put('/settings/general', partial),
    /** @param {{layout?:unknown, theme?:'auto'|'light'|'dark'}} ui */
    putUi: (ui) => put('/settings/ui', ui),
    changePassword: (currentPassword, newPassword) =>
      // noAuthEvent: a 401 here means the typed currentPassword was wrong; the auth cookie
      // is untouched, so this must not trigger the global re-login flow.
      request('POST', '/settings/password', {
        body: { currentPassword, newPassword },
        noAuthEvent: true,
      }),
    vendor: () => get('/settings/vendor'),
  },

  // ---- hosts (v0.2) ------------------------------------------------------
  hosts: {
    /** @param {{probe?:boolean}} [opts] probe=1 refreshes every host in parallel
     *  @returns {Promise<{hosts:any[], defaultHostId:string|null}>} */
    list: (opts = {}) => get('/hosts', { probe: opts.probe ? 1 : undefined }),
    /** always probes @returns {Promise<{host:any}>} */
    get: (hostId) => get(hostPath(hostId)),
    /** @param {any} input HostInput @returns {Promise<{host:any}>} */
    create: (input) => post('/hosts', input),
    /** @param {any} input HostUpdateInput (partial; `id` is immutable) */
    update: (hostId, input) => put(hostPath(hostId), input),
    /** @param {{force?:boolean}} [opts] force=1 deletes a host that still has containers */
    remove: (hostId, opts = {}) => del(hostPath(hostId), { force: opts.force ? 1 : undefined }),
    /** Probe UNSAVED form values. @param {any} connection @param {string} [apiKey]
     *  @returns {Promise<{ok:boolean, info?:any, endpoints?:any[], error?:{code:string,message:string}}>} */
    test: (connection, apiKey) => post('/hosts/test', apiKey ? { connection, apiKey } : { connection }),
    /** Probe a STORED host (always 200 + BackendTestResult). */
    testStored: (hostId) => post(hostPath(hostId, '/test'), {}),
    /** @returns {Promise<{host:any, defaultHostId:string}>} */
    makeDefault: (hostId) => post(hostPath(hostId, '/default'), {}),
    /** @returns {Promise<{info:any}>} */
    info: (hostId) => get(hostPath(hostId, '/info')),
    /** @returns {Promise<{agents:any[], enabled:string[]}>} HostAgentView[] */
    agents: (hostId) => get(hostPath(hostId, '/agents')),
    /** @param {string[]} enabled agent ids @returns {Promise<{agents:any[], enabled:string[]}>} */
    setAgents: (hostId, enabled) => put(hostPath(hostId, '/agents'), { enabled }),
  },

  // ---- stored credentials (v0.2) ----------------------------------------
  credentials: {
    portainer: {
      /** @returns {Promise<{credentials:any[]}>} SanitizedPortainerCredential[] */
      list: () => get('/credentials/portainer'),
      /** @param {{name:string, url:string, apiKey:string, insecureTls?:boolean}} input */
      create: (input) => post('/credentials/portainer', input),
      /** partial; OMIT `apiKey` to keep the stored one (never send "") */
      update: (id, input) => put(`/credentials/portainer/${enc(id)}`, input),
      remove: (id) => del(`/credentials/portainer/${enc(id)}`),
      /** unsaved probe @param {{url:string, apiKey:string, insecureTls?:boolean}} input */
      test: (input) => post('/credentials/portainer/test', input),
      /** probe a stored credential, optionally overriding fields from the form */
      testStored: (id, input = {}) => post(`/credentials/portainer/${enc(id)}/test`, input),
      /** @returns {Promise<{endpoints:{id:number,name:string,type:number,status:number,url?:string}[]}>} */
      endpoints: (id) => get(`/credentials/portainer/${enc(id)}/endpoints`),
      /** one host per endpoint
       *  @param {{endpointIds?:number[], nameTemplate?:string, update?:boolean}} [input]
       *  @returns {Promise<{result:{created:string[], updated:string[], skipped:any[], hosts:any[]}}>} */
      importEndpoints: (id, input = {}) => post(`/credentials/portainer/${enc(id)}/import`, input),
    },
  },

  // ---- agent definitions (v0.2) -----------------------------------------
  agents: {
    /** @returns {Promise<{agents:any[]}>} AgentView[] (built-in + custom) */
    list: () => get('/agents'),
    get: (id) => get(`/agents/${enc(id)}`),
    /** @param {any} definition AgentDefinition (custom only) */
    create: (definition) => post('/agents', definition),
    update: (id, definition) => put(`/agents/${enc(id)}`, definition),
    /** @param {{force?:boolean}} [opts] force=1 also strips it from hosts/containers */
    remove: (id, opts = {}) => del(`/agents/${enc(id)}`, { force: opts.force ? 1 : undefined }),
  },

  // ---- profiles (v0.4) ---------------------------------------------------
  profiles: {
    /** @returns {Promise<{profiles:any[]}>} SanitizedProfile[] (no secret value, ever) */
    list: () => get('/profiles'),
    /** @returns {Promise<{profile:any}>} */
    get: (id) => get(`/profiles/${enc(id)}`),
    /** @param {any} input ProfileInput @returns {Promise<{profile:any}>} */
    create: (input) => post('/profiles', input),
    /** ProfileInput. `agents.<id>.envSecrets`: OMIT a key to keep the stored secret, send
     *  null to clear it, send a plaintext string to replace it. */
    update: (id, input) => put(`/profiles/${enc(id)}`, input),
    /** v0.4 (#4): run the verify probe of this profile INSIDE a running container and
     *  return the report (CLI version, plugin-command capabilities, managed settings key
     *  NAMES, desired vs installed plugins, warnings and the raw probe transcripts).
     *  404 = unknown profile/container, 409 = container not running or the agent is not
     *  mounted there, 422 = no `container` in the body.
     *  @param {string} id profile id @param {string} container container name
     *  @returns {Promise<{report:any}>} */
    verify: (id, container) => post(`/profiles/${enc(id)}/verify`, { container }),
    /** @param {{force?:boolean, removeVolumes?:boolean}} [opts] force=1 strips the profile
     *  from the containers that still use it (409 without it); removeVolumes=1 additionally
     *  deletes the profile's PRIVATE login volumes (named/default sets are never touched). */
    remove: (id, opts = {}) =>
      del(`/profiles/${enc(id)}`, {
        force: opts.force ? 1 : undefined,
        removeVolumes: opts.removeVolumes ? 1 : undefined,
      }),
  },

  // ---- docker read-only helpers (host scoped) ---------------------------
  docker: {
    info: (hostId) => get(hostPath(hostId, '/docker/info')),
    /** @param {{all?:boolean, managed?:boolean}} [opts] */
    containers: (hostId, opts = {}) =>
      get(hostPath(hostId, '/docker/containers'), {
        all: opts.all ? 1 : undefined,
        managed: opts.managed ? 1 : undefined,
      }),
    volumes: (hostId) => get(hostPath(hostId, '/docker/volumes')),
    networks: (hostId) => get(hostPath(hostId, '/docker/networks')),
  },

  // ---- images / recipes / jobs / tools (host scoped) ---------------------
  images: {
    list: (hostId) => get(hostPath(hostId, '/images')),
    recipes: (hostId) => get(hostPath(hostId, '/images/recipes')),
    /** @param {{noCache?:boolean, pull?:boolean}} [opts] */
    buildRecipe: (hostId, name, opts = {}) =>
      post(hostPath(hostId, `/images/recipes/${enc(name)}/build`), opts),
    jobs: (hostId) => get(hostPath(hostId, '/images/jobs')),
    /** @param {number} since append-only cursor (use the previous nextIndex) */
    job: (hostId, id, since = 0) => get(hostPath(hostId, `/images/jobs/${enc(id)}`), { since }),
    cancelJob: (hostId, id) => post(hostPath(hostId, `/images/jobs/${enc(id)}/cancel`), {}),
    /** @returns {Promise<{status:any}>} ToolsStatus incl. `agents: AgentToolStatus[]` */
    tools: (hostId) => get(hostPath(hostId, '/images/tools')),
    /** installs every agent enabled on this host into its tools volume */
    syncTools: (hostId, force = false) => post(hostPath(hostId, '/images/tools/sync'), { force }),
    validateCustom: (hostId, image) => post(hostPath(hostId, '/images/custom/validate'), { image }),
    pull: (hostId, image) => post(hostPath(hostId, '/images/pull'), { image }),
  },

  // ---- containers (FLAT: names are unique across hosts) ------------------
  containers: {
    /** @param {{hostId?:string}} [opts] optional server-side filter
     *  @returns {Promise<{containers: any[]}>} ContainerView[] (with hostId/hostName/resolvedAgents) */
    list: (opts = {}) => get('/containers', { hostId: opts.hostId }),
    get: (name) => get(`/containers/${enc(name)}`),
    /** @param {any} input ContainerInput (+ `hostId` on create, `agents`) */
    create: (input) => post('/containers', input),
    /** `hostId` must not change - the server answers 422 */
    update: (name, input) => put(`/containers/${enc(name)}`, input),
    /** @param {{removeVolumes?:boolean}} [opts] never removes an agent auth volume */
    remove: (name, opts = {}) =>
      del(`/containers/${enc(name)}`, { removeVolumes: opts.removeVolumes ? 1 : undefined }),
    start: (name) => post(`/containers/${enc(name)}/start`, {}),
    stop: (name) => post(`/containers/${enc(name)}/stop`, {}),
    restart: (name) => post(`/containers/${enc(name)}/restart`, {}),
    recreate: (name) => post(`/containers/${enc(name)}/recreate`, {}),
    /** @param {{tail?:number, timestamps?:boolean}} [opts] */
    logs: (name, opts = {}) =>
      get(`/containers/${enc(name)}/logs`, {
        tail: opts.tail, timestamps: opts.timestamps ? 1 : undefined,
      }),
    reconcile: () => post('/containers/reconcile', {}),

    /** v0.3.1: browse / download / upload the container's workspace mount. */
    files: {
      /** @param {string} [path] absolute inside the container, or relative to the workspace
       *  @returns {Promise<{listing:{path:string, root:string, parent:string|null, entries:any[]}}>} */
      list: (name, path) => get(`/containers/${enc(name)}/files`, { path }),
      /** URL for an <a download>: the auth cookie rides along with the navigation. */
      downloadUrl: (name, path) =>
        `${API_BASE}/containers/${enc(name)}/files/download?path=${enc(path || '')}`,
      /**
       * One file into the directory `dir`. The body is the raw File (Content-Length is what
       * the server turns into the tar header), so there is no multipart parser on the server.
       * @param {{dir?:string, file:File, onProgress?:(fraction:number)=>void}} opts
       * @returns {Promise<{file:{path:string,size:number}}>}
       */
      upload: (name, opts) =>
        uploadBinary(`/containers/${enc(name)}/files/upload`, {
          query: { path: opts.dir, name: opts.file.name },
          file: opts.file,
          onProgress: opts.onProgress,
        }),
    },
  },
};

// ---------------------------------------------------------------------------
// WebSocket helper (FROZEN, implemented - F2 uses this, do not change).
// ---------------------------------------------------------------------------

/** Session (pane) names must match this so the derived tmux name `pc_<name>` is safe. */
export const SESSION_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Agent ids are slugs (server/src/agents/model.ts AGENT_ID_RE). */
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Build the wire value of the `shell` query parameter (server/src/sessions/protocol.ts
 * `parseSessionShell`). FROZEN.
 *   ('bash')              -> 'bash'
 *   ('sh')                -> 'sh'
 *   ('agent', 'claude')   -> 'agent:claude'
 * The legacy v0.1 value 'claude' is still accepted by the server but the UI never sends it.
 * @param {'bash'|'sh'|'agent'} shell
 * @param {string|null} [agentId]
 * @returns {string}
 */
export function formatShellParam(shell, agentId = null) {
  if (shell === 'agent') {
    if (!agentId || !AGENT_ID_RE.test(String(agentId))) throw new Error(`invalid agent id: ${agentId}`);
    return `agent:${agentId}`;
  }
  return shell === 'sh' ? 'sh' : 'bash';
}

/**
 * Inverse of {@link formatShellParam}: parse a persisted/legacy wire value. FROZEN.
 * Returns null when the value is not understood.
 * @param {string} raw
 * @returns {{shell:'bash'|'sh'|'agent', agentId:string|null}|null}
 */
export function parseShellParam(raw) {
  const value = String(raw || '');
  if (value === 'bash' || value === 'sh') return { shell: value, agentId: null };
  if (value === 'claude') return { shell: 'agent', agentId: 'claude' }; // v0.1 layout blobs
  const match = /^agent:([a-z0-9][a-z0-9-]{0,31})$/.exec(value);
  return match ? { shell: 'agent', agentId: match[1] } : null;
}

/**
 * Build the session websocket URL. The pc_auth cookie rides along automatically because
 * this is same-origin. There is NO host parameter: the server resolves
 * container -> host (api.md "WebSocket: sessions").
 * @param {{container:string, shell:string, session:string, cols?:number, rows?:number}} opts
 *        `container` is the container the shell runs in, `session` the pane/tmux name;
 *        `shell` is the WIRE value: 'bash' | 'sh' | 'agent:<agentId>' (formatShellParam)
 * @returns {string}
 */
export function sessionWsUrl(opts) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams({
    container: opts.container, session: opts.session, shell: opts.shell,
  });
  if (opts.cols) qs.set('cols', String(opts.cols));
  if (opts.rows) qs.set('rows', String(opts.rows));
  return `${proto}//${window.location.host}${API_BASE}/sessions?${qs.toString()}`;
}

/** Re-exported so modules do not have to import bus.js just for the auth event. */
export { bus, EVENTS };
