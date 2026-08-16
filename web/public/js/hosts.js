// OWNER: F1 (v0.2, new). Settings -> Hosts: the host table, the host create/edit modal,
// the stored Portainer credentials and the "import endpoints -> one host each" flow.
// Not a top-level view; settings.js drives its lifecycle (like images.js).
//
// It is ALSO the host cache every other F1 module reads (sessions.js host filter + session
// dialog, images.js host selector, agents.js host selector).
//
// CONTRACT (FROZEN):
//   * loadHosts() emits bus.emit(EVENTS.HOSTS_CHANGED, { hosts, defaultHostId }) after every
//     successful GET /api/hosts and after every host CRUD call.
//   * getHosts() returns the last known HostView[] (never null; [] before the first load).
//   * hostLabel(id) never throws and never returns '' (unknown id renders as the id).
//   * GET /api/hosts is called WITHOUT probe on every refresh (it answers from a <=15s cache
//     and never blocks on a dead engine); probe=1 is only used by the explicit refresh button
//     and after a save.
//
// MODULE GRAPH: this module must NOT import sessions.js (HostView.sessionCount carries the
// only number it needs) and it deliberately does not import agents.js either - agents.js
// imports images.js, which imports THIS module, so that edge would close a cycle
// (docs/design/frontend.md section 12.2). The agent registry is instead kept locally: the
// panel reads GET /api/agents once and follows the `agents:changed` bus event afterwards.
import { api } from './api.js';
import { bus, EVENTS } from './bus.js';
import {
  byId, toast, toastError, confirmDialog, escapeHtml, fmtBytes, fmtDate, renderAlert,
} from './util.js';
// settings.js <-> hosts.js is an intentional back edge: the per-host "overrides" form is the
// SAME field list as Settings -> General. Only used inside functions, so module evaluation
// order does not matter (settings.js resolves its panels lazily for the same reason).
import { GENERAL_FIELDS, getSettings } from './settings.js';

/** @type {any[]} HostView[] */
let hosts = [];
/** @type {string|null} */
let defaultHostId = null;
/** @type {any[]} SanitizedPortainerCredential[] */
let credentials = [];
/** @type {any|null} the host open in #host-modal (null = create) */
let editingHost = null;
/** @type {any|null} the credential open in #credential-modal (null = create) */
let editingCredential = null;
/** @type {any|null} the credential whose endpoints #import-modal shows */
let importingCredential = null;
let initialised = false;

/** @type {any[]} AgentView[] - local copy of the registry (see the module-graph note above) */
let agentDefs = [];
/** hostId -> the last inline "Test" result rendered in the status cell */
const testResults = new Map();
/** true while #credential-modal was opened FROM the host modal ("+ Add credential...") */
let credentialFromHostForm = false;
/** the default socket path a fresh host starts with (mirrors SocketConnectionSchema) */
const DEFAULT_SOCKET_PATH = '/var/run/docker.sock';
/** Portainer endpoint types the server treats as docker (hosts/manager.ts import rules). */
const DOCKER_ENDPOINT_TYPES = [1, 2];

// ---------------------------------------------------------------------------
// cache (FROZEN accessors - implemented, do not change)
// ---------------------------------------------------------------------------

/** FROZEN. @returns {any[]} the last known HostView[] (never null) */
export function getHosts() {
  return hosts;
}

/** FROZEN. @param {string} id @returns {any|null} */
export function getHost(id) {
  if (!id) return null;
  return hosts.find((h) => h && h.id === id) || null;
}

/** FROZEN. Human label of a host id ("Prod (portainer)"); falls back to the raw id. */
export function hostLabel(id) {
  const host = getHost(id);
  return (host && host.name) || String(id || '');
}

/** FROZEN. @returns {string|null} the id of the default host, null on a fresh install */
export function getDefaultHostId() {
  return defaultHostId;
}

/** @returns {any[]} SanitizedPortainerCredential[] */
export function getCredentials() {
  return credentials;
}

/**
 * FROZEN. GET /api/hosts -> cache + HOSTS_CHANGED. `probe` refreshes every engine in
 * parallel (slow); the plain call answers from the server's <=15s probe cache.
 * @param {{probe?:boolean}} [opts]
 * @returns {Promise<any[]>}
 */
export async function loadHosts(opts = {}) {
  const res = await api.hosts.list({ probe: !!opts.probe });
  hosts = Array.isArray(res && res.hosts) ? res.hosts : [];
  defaultHostId = (res && res.defaultHostId) || null;
  bus.emit(EVENTS.HOSTS_CHANGED, { hosts, defaultHostId });
  return hosts;
}

/**
 * The host a panel should point at: the remembered one when it still exists, else the
 * default host, else the first host, else ''. Used by images.js / agents.js / sessions.js.
 * @param {string|null} remembered
 * @returns {string}
 */
export function resolveHostId(remembered) {
  if (remembered && getHost(remembered)) return remembered;
  if (defaultHostId && getHost(defaultHostId)) return defaultHostId;
  return hosts.length ? hosts[0].id : '';
}

/**
 * `<option>` markup for a host `<select>`. Implemented here so every panel renders the same
 * labels (name + "(default)" marker + an "unreachable" hint).
 * @param {string} selectedId
 * @param {{includeAll?:boolean, allLabel?:string}} [opts] includeAll adds a leading
 *        `<option value="">` (used by the two "filter by host" selects)
 * @returns {string}
 */
export function hostOptionsHtml(selectedId, opts = {}) {
  const parts = [];
  if (opts.includeAll) {
    parts.push(`<option value=""${selectedId ? '' : ' selected'}>${escapeHtml(opts.allLabel || 'All hosts')}</option>`);
  }
  for (const host of hosts) {
    const marks = [];
    if (host.id === defaultHostId) marks.push('default');
    if (host.status === 'unreachable') marks.push('unreachable');
    if (host.status === 'not_configured') marks.push('not configured');
    if (!host.supported) marks.push('unsupported');
    const suffix = marks.length ? ` (${marks.join(', ')})` : '';
    parts.push(
      `<option value="${escapeHtml(host.id)}"${host.id === selectedId ? ' selected' : ''}>` +
      `${escapeHtml(host.name)}${escapeHtml(suffix)}</option>`,
    );
  }
  return parts.join('');
}

/** Bootstrap badge class for a HostView.status. */
export function hostStatusBadgeClass(status) {
  switch (status) {
    case 'ok':
      return 'text-bg-success';
    case 'unreachable':
      return 'text-bg-danger';
    case 'not_configured':
      return 'text-bg-warning';
    default:
      return 'text-bg-secondary';
  }
}

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

/** Label of an agent id from the LOCAL registry copy; falls back to the id. */
function agentName(id) {
  const def = agentDefs.find((a) => a && a.id === id);
  return (def && def.name) || String(id || '');
}

/** GET /api/agents once, then keep it fresh through the bus. Never throws. */
async function ensureAgentDefs(force = false) {
  if (agentDefs.length && !force) return agentDefs;
  try {
    const res = await api.agents.list();
    agentDefs = Array.isArray(res && res.agents) ? res.agents : [];
  } catch {
    /* the panel degrades to raw ids */
  }
  return agentDefs;
}

/** Bootstrap modal instance for an id, or null when bootstrap is missing. */
function modalFor(id) {
  const el = byId(id);
  if (!el || typeof bootstrap === 'undefined') return null;
  return bootstrap.Modal.getOrCreateInstance(el);
}

function setText(id, message) {
  const el = byId(id);
  if (el) el.textContent = message || '';
}

/** The docker info table shared by the connection test, the host info modal and import. */
function infoTableHtml(info) {
  if (!info) return '';
  const rows = [
    ['engine', info.name],
    ['server version', info.serverVersion],
    ['os', info.os],
    ['architecture', info.architecture],
    ['cpus', info.ncpu],
    ['memory', info.memTotalBytes ? fmtBytes(info.memTotalBytes) : null],
    ['containers', info.containers === undefined ? null : `${info.containers} (${info.containersRunning ?? 0} running)`],
    ['images', info.images],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
  return (
    '<table class="table table-sm mb-0"><tbody>' +
    rows
      .map(
        ([label, value]) =>
          `<tr><th scope="row" class="fw-normal text-secondary">${escapeHtml(label)}</th>` +
          `<td class="font-monospace small">${escapeHtml(String(value))}</td></tr>`,
      )
      .join('') +
    '</tbody></table>'
  );
}

/** Render a BackendTestResult into a container element. */
function renderTestResult(container, result) {
  if (!container) return;
  if (!result) {
    container.innerHTML = '';
    return;
  }
  if (result.ok) {
    const endpoints = Array.isArray(result.endpoints)
      ? `<div class="small text-secondary">${escapeHtml(String(result.endpoints.length))} endpoint(s) visible with this key.</div>`
      : '';
    container.innerHTML =
      '<div class="alert alert-success py-2 mb-0"><div class="fw-semibold mb-1">Connection works.</div>' +
      endpoints + infoTableHtml(result.info) + '</div>';
    return;
  }
  const err = result.error || {};
  container.innerHTML =
    '<div class="alert alert-danger py-2 mb-0">' +
    `<span class="fw-semibold">${escapeHtml(err.code || 'error')}</span>: ${escapeHtml(err.message || 'the connection failed')}` +
    '</div>';
}

/** Map a 422 envelope onto "<path>: <message>" lines. */
function issueLines(err) {
  const issues = Array.isArray(err && err.details) ? err.details : [];
  if (!issues.length) return (err && err.message) || 'validation failed';
  return issues
    .map((issue) => {
      const path = Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path || '');
      return `${path || 'body'}: ${issue.message || 'invalid'}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// host table (F1)
// ---------------------------------------------------------------------------

function rowActionButton(hostId, action, icon, label, variant = 'outline-secondary') {
  return (
    `<button type="button" class="btn btn-sm btn-${variant}" data-action="${action}" data-host="${escapeHtml(hostId)}"` +
    ` title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><i class="bi ${icon}"></i></button>`
  );
}

function hostStatusCell(host) {
  if (host.supported === false) {
    return (
      '<span class="badge text-bg-secondary" title="tcp and ssh connections are planned for v0.3">' +
      'not supported yet (v0.3)</span>'
    );
  }
  const status = String(host.status || 'unknown');
  const title = host.error ? ` title="${escapeHtml(host.error)}"` : '';
  const badge = `<span class="badge ${hostStatusBadgeClass(status)}"${title}>${escapeHtml(status)}</span>`;
  const error = host.error
    ? `<div class="small text-danger text-truncate" style="max-width:22rem"${title}>${escapeHtml(host.error)}</div>`
    : '';
  const probe = testResults.get(host.id);
  const probed = probe
    ? `<div class="small ${probe.ok ? 'text-success' : 'text-danger'}">${escapeHtml(probe.message)}</div>`
    : '';
  return badge + error + probed;
}

function hostAgentsCell(host) {
  const enabled = (host.agents && Array.isArray(host.agents.enabled) ? host.agents.enabled : []).filter(Boolean);
  if (!enabled.length) return '<span class="small text-secondary">none</span>';
  return enabled
    .map(
      (id) =>
        `<span class="badge text-bg-secondary pc-agent-chip" title="${escapeHtml(id)}">${escapeHtml(agentName(id))}</span>`,
    )
    .join('');
}

function hostRow(host) {
  const isDefault = !!host.isDefault || host.id === defaultHostId;
  const name =
    `<div class="fw-semibold">${escapeHtml(host.name || host.id)}` +
    (isDefault ? ' <span class="badge text-bg-primary">default</span>' : '') +
    '</div>' +
    `<div class="pc-host-id text-secondary">${escapeHtml(host.id)}</div>` +
    (host.notes ? `<div class="small text-secondary">${escapeHtml(host.notes)}</div>` : '');

  const connection =
    `<div>${escapeHtml(host.connectionLabel || (host.connection && host.connection.type) || '-')}</div>` +
    (host.credentialName
      ? `<div class="small text-secondary">credential: ${escapeHtml(host.credentialName)}</div>`
      : '');

  const actions =
    '<div class="btn-group btn-group-sm" role="group">' +
    rowActionButton(host.id, 'test', 'bi-plug', 'Test connection', 'outline-primary') +
    rowActionButton(host.id, 'info', 'bi-info-circle', 'Engine info') +
    (isDefault ? '' : rowActionButton(host.id, 'default', 'bi-star', 'Make default host')) +
    rowActionButton(host.id, 'edit', 'bi-pencil', 'Edit host') +
    rowActionButton(host.id, 'delete', 'bi-trash', 'Delete host', 'outline-danger') +
    '</div>';

  return (
    `<tr data-host="${escapeHtml(host.id)}">` +
    `<td>${name}</td>` +
    `<td class="small">${connection}</td>` +
    `<td>${hostStatusCell(host)}</td>` +
    `<td class="small">${escapeHtml(String(host.sessionCount ?? 0))}</td>` +
    `<td>${hostAgentsCell(host)}</td>` +
    `<td class="text-end text-nowrap">${actions}</td>` +
    '</tr>'
  );
}

/**
 * Render #hosts-tbody, one row per HostView (name + id + default badge + notes, the
 * connection label and its credential, the status badge with the error as a tooltip, the
 * session count, one chip per enabled agent, and the row actions). Everything that comes
 * from the API is escaped.
 */
export function renderHosts() {
  const tbody = byId('hosts-tbody');
  const empty = byId('hosts-empty');
  if (!tbody) return;
  if (!hosts.length) {
    tbody.innerHTML = '';
    if (empty) empty.classList.remove('d-none');
    return;
  }
  if (empty) empty.classList.add('d-none');
  tbody.innerHTML = hosts.map(hostRow).join('');
}

/**
 * GET /api/hosts (probe only when asked) + GET /api/credentials/portainer, then repaint the
 * panel. loadHosts() emits HOSTS_CHANGED, which is what refreshes the host selects of the
 * other panels. A failure renders an inline alert in #hosts-alert, never a toast loop.
 * @param {{probe?:boolean}} [opts]
 * @returns {Promise<void>}
 */
export async function reload(opts = {}) {
  const alertBox = byId('hosts-alert');
  void ensureAgentDefs();
  try {
    await loadHosts({ probe: !!opts.probe });
    renderAlert(alertBox, '');
  } catch (err) {
    if (err && err.status === 401) return;
    renderAlert(
      alertBox,
      `Could not load the hosts: ${escapeHtml((err && err.message) || 'unknown error')}`,
      'danger',
    );
  }
  renderHosts();
  await reloadCredentials();
}

// ---------------------------------------------------------------------------
// host modal (F1)
// ---------------------------------------------------------------------------

/** `My Docker box!` -> `my-docker-box` (mirrors slugifyHostId on the server). */
function slugifyHostId(input) {
  const slug = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(slug) ? slug : '';
}

function credentialOptionsHtml(selectedId) {
  const options = [`<option value=""${selectedId ? '' : ' selected'}>- pick a credential -</option>`];
  for (const cred of credentials) {
    options.push(
      `<option value="${escapeHtml(cred.id)}"${cred.id === selectedId ? ' selected' : ''}>` +
      `${escapeHtml(cred.name)} (${escapeHtml(cred.url)})</option>`,
    );
  }
  options.push('<option value="__new__">+ Add credential...</option>');
  return options.join('');
}

function overridesFieldsHtml(host) {
  const inherited = (getSettings() && getSettings().general) || {};
  const overrides = (host && host.overrides) || {};
  return GENERAL_FIELDS.map((field) => {
    const value = overrides[field.key];
    const placeholder = inherited[field.key];
    return (
      '<div class="col-md-6">' +
      `<label class="form-label small mb-1" for="hf-ov-${field.key}">${escapeHtml(field.label)}` +
      (field.legacy ? ' <span class="badge text-bg-secondary">legacy</span>' : '') +
      '</label>' +
      `<input class="form-control form-control-sm" id="hf-ov-${field.key}" data-override-key="${field.key}"` +
      ` value="${escapeHtml(value === null || value === undefined ? '' : String(value))}"` +
      ` placeholder="${escapeHtml(placeholder === null || placeholder === undefined ? '(inherit)' : String(placeholder))}">` +
      '</div>'
    );
  }).join('');
}

/**
 * What a NEW host starts with: the agents the current default host enables (a second host
 * usually wants the same set), else the first built-in of the registry. Deliberately not a
 * hard-coded agent id - the UI is agent-neutral (frontend.md section 12.6).
 * @returns {string[]}
 */
function defaultEnabledAgentIds() {
  const current = getHost(defaultHostId);
  const inherited = current && current.agents && Array.isArray(current.agents.enabled)
    ? current.agents.enabled
    : [];
  if (inherited.length) return inherited;
  const firstBuiltin = agentDefs.find((a) => a && a.builtin);
  return firstBuiltin ? [firstBuiltin.id] : [];
}

function agentCheckboxesHtml(host) {
  const enabled = new Set(
    host && host.agents && Array.isArray(host.agents.enabled)
      ? host.agents.enabled
      : defaultEnabledAgentIds(),
  );
  if (!agentDefs.length) {
    return '<div class="col-12 small text-secondary">The agent registry is not loaded yet - open Settings &rarr; Agents once.</div>';
  }
  return agentDefs
    .map(
      (agent) =>
        '<div class="col-md-4"><div class="form-check">' +
        `<input class="form-check-input" type="checkbox" data-host-agent="${escapeHtml(agent.id)}"` +
        ` id="hf-agent-${escapeHtml(agent.id)}"${enabled.has(agent.id) ? ' checked' : ''}>` +
        `<label class="form-check-label" for="hf-agent-${escapeHtml(agent.id)}">${escapeHtml(agent.name)}` +
        ` <span class="text-secondary font-monospace small">${escapeHtml(agent.id)}</span></label>` +
        '</div></div>',
    )
    .join('');
}

function hostFormHtml(host) {
  const isEdit = !!host;
  // A SECOND socket host is impossible (the server answers 409): while another host owns the
  // local socket the radio is disabled, and a new host starts on the portainer branch.
  const socketDisabled = hosts.some(
    (h) => h && h.connection && h.connection.type === 'socket' && (!host || h.id !== host.id),
  );
  const conn = (host && host.connection)
    || { type: socketDisabled ? 'portainer' : 'socket', socketPath: DEFAULT_SOCKET_PATH };
  const type = conn.type === 'portainer' ? 'portainer' : conn.type === 'tcp' || conn.type === 'ssh' ? conn.type : 'socket';
  const radio = (value, label, disabled, note) =>
    '<div class="form-check form-check-inline">' +
    `<input class="form-check-input" type="radio" name="hfType" id="hf-type-${value}" value="${value}"` +
    `${type === value ? ' checked' : ''}${disabled ? ' disabled' : ''}>` +
    `<label class="form-check-label" for="hf-type-${value}">${escapeHtml(label)}` +
    (note ? ` <span class="small text-secondary">${escapeHtml(note)}</span>` : '') +
    '</label></div>';

  return (
    '<div class="row g-3">' +
    '<div class="col-md-7"><label class="form-label" for="hf-name">Name</label>' +
    `<input class="form-control" id="hf-name" value="${escapeHtml((host && host.name) || '')}" placeholder="Prod (portainer)"></div>` +
    '<div class="col-md-5"><label class="form-label" for="hf-id">Id</label>' +
    `<input class="form-control font-monospace" id="hf-id" value="${escapeHtml((host && host.id) || '')}"` +
    `${isEdit ? ' readonly' : ''} placeholder="auto from the name">` +
    `<div class="form-text">${isEdit ? 'the id of a host is immutable' : 'lowercase letters, digits and dashes; blank = derived from the name'}</div></div>` +

    '<div class="col-12"><hr class="my-1"></div>' +
    '<div class="col-12"><label class="form-label d-block">Connection</label>' +
    radio('socket', 'Local docker socket', socketDisabled, socketDisabled ? '(another host already uses it)' : '') +
    radio('portainer', 'Portainer endpoint', false, '') +
    radio('tcp', 'Docker over TLS', true, '(planned for v0.3)') +
    radio('ssh', 'Docker over SSH', true, '(planned for v0.3)') +
    (socketDisabled
      ? '<div class="form-text">PorterClaude runs on exactly one machine, so exactly one host can use the local socket.</div>'
      : '') +
    '</div>' +

    `<div class="col-12${type === 'socket' ? '' : ' d-none'}" id="hf-socket-fields">` +
    '<label class="form-label" for="hf-socket-path">Socket path</label>' +
    `<input class="form-control font-monospace" id="hf-socket-path" value="${escapeHtml(conn.type === 'socket' ? conn.socketPath || DEFAULT_SOCKET_PATH : DEFAULT_SOCKET_PATH)}">` +
    '<div class="form-text">the docker socket mounted into the PorterClaude container</div></div>' +

    `<div class="col-12${type === 'portainer' ? '' : ' d-none'}" id="hf-portainer-fields"><div class="row g-2">` +
    '<div class="col-md-7"><label class="form-label" for="hf-credential">Portainer credential</label>' +
    `<select class="form-select" id="hf-credential">${credentialOptionsHtml(conn.type === 'portainer' ? conn.credentialId : '')}</select></div>` +
    '<div class="col-md-5"><label class="form-label" for="hf-endpoint">Endpoint</label>' +
    '<select class="form-select" id="hf-endpoint"><option value="">- pick a credential first -</option></select></div>' +
    '<div class="col-12"><div class="form-text">The API key stays in the credential; hosts only reference it.</div></div>' +
    '</div></div>' +

    '<div class="col-12"><hr class="my-1"></div>' +
    '<div class="col-12"><label class="form-label d-block">Coding agents enabled on this host</label>' +
    `<div class="row g-1" id="hf-agents">${agentCheckboxesHtml(host)}</div>` +
    '<div class="form-text">Enabling installs nothing: sync the tools volume of this host afterwards, then recreate the sessions that should mount the agent.</div></div>' +

    '<div class="col-12"><hr class="my-1"></div>' +
    '<div class="col-12"><label class="form-label d-block">Overrides</label>' +
    `<div class="row g-2" id="hf-overrides">${overridesFieldsHtml(host)}</div>` +
    '<div class="form-text">Blank inherits the value from Settings &rarr; General (shown as the placeholder).</div></div>' +

    '<div class="col-12"><hr class="my-1"></div>' +
    '<div class="col-md-8"><label class="form-label" for="hf-notes">Notes</label>' +
    `<input class="form-control" id="hf-notes" value="${escapeHtml((host && host.notes) || '')}" placeholder="optional"></div>` +
    '<div class="col-md-4 d-flex align-items-end"><div class="form-check">' +
    `<input class="form-check-input" type="checkbox" id="hf-default"${host && host.isDefault ? ' checked disabled' : ''}>` +
    '<label class="form-check-label" for="hf-default">Make this the default host</label></div></div>' +
    '</div>'
  );
}

/** Show/hide the socket vs portainer field groups from the radios. */
function syncHostFormType() {
  const portainer = !!(byId('hf-type-portainer') && byId('hf-type-portainer').checked);
  const socketFields = byId('hf-socket-fields');
  const portainerFields = byId('hf-portainer-fields');
  if (socketFields) socketFields.classList.toggle('d-none', portainer);
  if (portainerFields) portainerFields.classList.toggle('d-none', !portainer);
}

/**
 * Fill #hf-endpoint from GET /api/credentials/portainer/:id/endpoints.
 * @param {string} credentialId
 * @param {number|null} selectedId
 */
async function fillEndpointSelect(credentialId, selectedId = null) {
  const select = byId('hf-endpoint');
  if (!select) return;
  if (!credentialId) {
    select.innerHTML = '<option value="">- pick a credential first -</option>';
    return;
  }
  select.innerHTML = '<option value="">loading...</option>';
  try {
    const res = await api.credentials.portainer.endpoints(credentialId);
    const endpoints = Array.isArray(res && res.endpoints) ? res.endpoints : [];
    if (!endpoints.length) {
      select.innerHTML = '<option value="">- no endpoint visible with this key -</option>';
      return;
    }
    select.innerHTML = endpoints
      .map((ep) => {
        const docker = DOCKER_ENDPOINT_TYPES.includes(Number(ep.type));
        const suffix = docker ? '' : ' - not a docker endpoint';
        return (
          `<option value="${escapeHtml(String(ep.id))}"${Number(ep.id) === Number(selectedId) ? ' selected' : ''}` +
          `${docker ? '' : ' disabled'}>#${escapeHtml(String(ep.id))} ${escapeHtml(ep.name || '')}${escapeHtml(suffix)}</option>`
        );
      })
      .join('');
  } catch (err) {
    select.innerHTML = `<option value="">${escapeHtml((err && err.message) || 'endpoints unavailable')}</option>`;
  }
}

/**
 * Build #host-form-body and show #host-modal. Field ids are FROZEN
 * (docs/design/frontend.md section 12.4).
 * @param {any|null} host HostView for edit, null for create
 */
export function openHostModal(host = null) {
  editingHost = host;
  const body = byId('host-form-body');
  const title = byId('host-modal-title');
  if (!body) return;
  if (title) title.textContent = host ? `Edit host ${host.name}` : 'Add host';
  setText('host-form-error', '');
  const result = byId('host-test-result');
  if (result) result.innerHTML = '';
  body.innerHTML = hostFormHtml(host);

  const nameEl = byId('hf-name');
  const idEl = byId('hf-id');
  if (nameEl && idEl && !host) {
    nameEl.addEventListener('input', () => {
      idEl.placeholder = slugifyHostId(nameEl.value) || 'auto from the name';
    });
  }
  body.querySelectorAll('input[name="hfType"]').forEach((el) => {
    el.addEventListener('change', () => syncHostFormType());
  });
  syncHostFormType();

  const credentialSelect = byId('hf-credential');
  if (credentialSelect) {
    let previous = credentialSelect.value;
    credentialSelect.addEventListener('change', () => {
      if (credentialSelect.value === '__new__') {
        credentialSelect.value = previous;
        credentialFromHostForm = true;
        openCredentialModal(null);
        return;
      }
      previous = credentialSelect.value;
      void fillEndpointSelect(credentialSelect.value, null);
    });
  }
  const conn = (host && host.connection) || {};
  if (conn.type === 'portainer') void fillEndpointSelect(conn.credentialId, conn.endpointId);

  // the registry may still be loading on a cold start - repaint the checkboxes when it lands
  if (!agentDefs.length) {
    void ensureAgentDefs().then(() => {
      const box = byId('hf-agents');
      if (box && editingHost === host) box.innerHTML = agentCheckboxesHtml(host);
    });
  }

  const modal = modalFor('host-modal');
  if (modal) modal.show();
}

/**
 * Serialise #host-form into a HostInput / HostUpdateInput.
 * Throws an Error with a human message for client-side problems.
 * @returns {any}
 */
export function readHostForm() {
  const value = (id) => {
    const el = byId(id);
    return el ? String(el.value || '').trim() : '';
  };
  const name = value('hf-name');
  if (!name) throw new Error('Give the host a name.');

  /** @type {any} */
  const input = { name };
  if (!editingHost) {
    const id = value('hf-id');
    if (id) {
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
        throw new Error('The id must be lowercase letters, digits and dashes (max 32 chars).');
      }
      input.id = id;
    }
  }

  const portainer = !!(byId('hf-type-portainer') && byId('hf-type-portainer').checked);
  if (portainer) {
    const credentialId = value('hf-credential');
    if (!credentialId || credentialId === '__new__') throw new Error('Pick a Portainer credential.');
    const endpointId = value('hf-endpoint');
    if (endpointId === '') throw new Error('Pick a Portainer endpoint.');
    input.connection = { type: 'portainer', credentialId, endpointId: Number(endpointId) };
  } else {
    const socketPath = value('hf-socket-path') || DEFAULT_SOCKET_PATH;
    input.connection = { type: 'socket', socketPath };
  }

  /** @type {any} */
  const overrides = {};
  document.querySelectorAll('#hf-overrides [data-override-key]').forEach((el) => {
    const key = el.getAttribute('data-override-key');
    const raw = String(el.value || '').trim();
    if (key && raw !== '') overrides[key] = raw;
  });
  input.overrides = overrides;

  /** @type {string[]} */
  const agents = [];
  document.querySelectorAll('#hf-agents [data-host-agent]').forEach((el) => {
    if (el.checked) agents.push(el.getAttribute('data-host-agent'));
  });
  input.agents = agents;

  input.notes = value('hf-notes') || null;
  const makeDefault = byId('hf-default');
  if (makeDefault && makeDefault.checked && !(editingHost && editingHost.isDefault)) input.makeDefault = true;
  return input;
}

/**
 * POST /api/hosts/test with the CURRENT form values - nothing is saved, and a stored
 * credential's api key is never re-sent (the server uses the stored one).
 * @returns {Promise<void>}
 */
export async function testHostForm() {
  const out = byId('host-test-result');
  const btn = byId('btn-host-test');
  let input;
  try {
    input = readHostForm();
  } catch (err) {
    setText('host-form-error', (err && err.message) || 'Invalid form');
    return;
  }
  setText('host-form-error', '');
  if (out) out.innerHTML = '<div class="small text-secondary"><span class="spinner-border spinner-border-sm me-1"></span>probing the engine...</div>';
  if (btn) btn.disabled = true;
  try {
    const result = await api.hosts.test(input.connection);
    renderTestResult(out, result);
  } catch (err) {
    renderTestResult(out, { ok: false, error: { code: (err && err.code) || 'error', message: (err && err.message) || 'the test failed' } });
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * POST /api/hosts (create) or PUT /api/hosts/:id (edit), then close the modal, refresh with
 * a probe and toast. 409/422 render inline in #host-form-error.
 * @param {Event} [event]
 * @returns {Promise<void>}
 */
export async function saveHost(event) {
  if (event) event.preventDefault();
  const btn = byId('btn-host-save');
  setText('host-form-error', '');
  let input;
  try {
    input = readHostForm();
  } catch (err) {
    setText('host-form-error', (err && err.message) || 'Invalid form');
    return;
  }
  if (btn) btn.disabled = true;
  try {
    if (editingHost) {
      const { id: _ignored, ...update } = input;
      void _ignored;
      await api.hosts.update(editingHost.id, update);
    } else {
      await api.hosts.create(input);
    }
    const modal = modalFor('host-modal');
    if (modal) modal.hide();
    toast(`Host ${input.name} ${editingHost ? 'updated' : 'added'}`, { variant: 'success' });
    editingHost = null;
    await reload({ probe: true });
  } catch (err) {
    if (err && err.code === 'validation_error') {
      setText('host-form-error', issueLines(err));
    } else if (err && err.status === 409) {
      setText('host-form-error', (err && err.message) || 'That host conflicts with an existing one.');
    } else {
      setText('host-form-error', (err && err.message) || 'Could not save the host');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * confirmDialog -> DELETE /api/hosts/:id. A 409 means sessions still reference the host:
 * ask a second time and retry with `?force=1`.
 * @param {any} host HostView
 * @returns {Promise<void>}
 */
export async function deleteHost(host) {
  if (!host) return;
  const ok = await confirmDialog({
    title: `Delete host ${host.name}?`,
    body:
      `PorterClaude stops managing <code>${escapeHtml(host.id)}</code>. ` +
      'Containers, volumes and images on that engine are never touched.',
    confirmLabel: 'Delete host',
  });
  if (!ok) return;
  try {
    await api.hosts.remove(host.id);
    toast(`Host ${host.name} deleted`, { variant: 'success' });
    await reload();
    return;
  } catch (err) {
    if (!err || err.status !== 409) {
      toastError(err, 'Could not delete the host');
      return;
    }
  }
  const count = Number(host.sessionCount || 0);
  const forced = await confirmDialog({
    title: 'Delete it anyway?',
    body:
      `${escapeHtml(String(count))} session(s) still point at this host. Deleting it leaves them ` +
      'read-only until a host with that id exists again. Containers, volumes and images on that ' +
      'engine are never touched.',
    confirmLabel: 'Delete anyway',
  });
  if (!forced) return;
  try {
    await api.hosts.remove(host.id, { force: true });
    toast(`Host ${host.name} deleted - its sessions are read-only now`, { variant: 'warning' });
    await reload();
  } catch (err) {
    toastError(err, 'Could not delete the host');
  }
}

/**
 * POST /api/hosts/:id/default.
 * @param {string} hostId
 * @returns {Promise<void>}
 */
export async function makeDefault(hostId) {
  try {
    await api.hosts.makeDefault(hostId);
    toast(`${hostLabel(hostId)} is now the default host`, { variant: 'success' });
    await reload();
  } catch (err) {
    toastError(err, 'Could not change the default host');
  }
}

/**
 * POST /api/hosts/:id/test -> an inline result in the host row (never a modal).
 * @param {any} host HostView
 * @returns {Promise<void>}
 */
export async function testHost(host) {
  if (!host) return;
  testResults.set(host.id, { ok: true, message: 'probing...' });
  renderHosts();
  try {
    const result = await api.hosts.testStored(host.id);
    if (result && result.ok) {
      const info = result.info || {};
      testResults.set(host.id, {
        ok: true,
        message: `ok - ${info.serverVersion ? `docker ${info.serverVersion}` : 'engine reachable'}`,
      });
    } else {
      const err = (result && result.error) || {};
      testResults.set(host.id, { ok: false, message: `${err.code || 'error'}: ${err.message || 'unreachable'}` });
    }
  } catch (err) {
    testResults.set(host.id, { ok: false, message: (err && err.message) || 'the test failed' });
  }
  renderHosts();
}

/**
 * GET /api/hosts/:id/info -> #host-info-modal (engine info + the effective settings of the
 * host and its overrides). An unreachable host shows the error instead of the table.
 * @param {any} host HostView
 * @returns {Promise<void>}
 */
export async function showHostInfo(host) {
  if (!host) return;
  const title = byId('host-info-title');
  const body = byId('host-info-body');
  if (title) title.textContent = `${host.name} (${host.id})`;
  if (body) body.innerHTML = '<div class="small text-secondary"><span class="spinner-border spinner-border-sm me-1"></span>loading...</div>';
  const modal = modalFor('host-info-modal');
  if (modal) modal.show();
  if (!body) return;

  const settings = (host.settings || {});
  const overrides = (host.overrides || {});
  const settingsRows = GENERAL_FIELDS.map((field) => {
    const value = settings[field.key];
    const overridden = Object.prototype.hasOwnProperty.call(overrides, field.key);
    return (
      `<tr><th scope="row" class="fw-normal text-secondary">${escapeHtml(field.label)}</th>` +
      `<td class="font-monospace small">${escapeHtml(value === null || value === undefined ? '-' : String(value))}` +
      (overridden ? ' <span class="badge text-bg-info">override</span>' : '') +
      '</td></tr>'
    );
  }).join('');

  const meta =
    '<dl class="row small mb-3">' +
    `<dt class="col-sm-3">Connection</dt><dd class="col-sm-9">${escapeHtml(host.connectionLabel || '-')}</dd>` +
    (host.credentialName ? `<dt class="col-sm-3">Credential</dt><dd class="col-sm-9">${escapeHtml(host.credentialName)}</dd>` : '') +
    `<dt class="col-sm-3">Sessions</dt><dd class="col-sm-9">${escapeHtml(String(host.sessionCount ?? 0))}</dd>` +
    `<dt class="col-sm-3">Agents</dt><dd class="col-sm-9">${hostAgentsCell(host)}</dd>` +
    `<dt class="col-sm-3">Created</dt><dd class="col-sm-9">${escapeHtml(fmtDate(host.createdAt))}</dd>` +
    '</dl>';

  let infoHtml = '';
  try {
    const res = await api.hosts.info(host.id);
    infoHtml = infoTableHtml((res && res.info) || null) || '<div class="small text-secondary">no engine info</div>';
  } catch (err) {
    infoHtml = `<div class="alert alert-warning py-2 small mb-0">${escapeHtml((err && err.message) || 'the engine did not answer')}</div>`;
  }
  body.innerHTML =
    meta +
    '<h6>Engine</h6>' + infoHtml +
    '<h6 class="mt-3">Effective settings</h6>' +
    `<table class="table table-sm mb-0"><tbody>${settingsRows}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// portainer credentials (F1)
// ---------------------------------------------------------------------------

function credentialCard(cred) {
  const key = cred.apiKeySet
    ? `<span class="badge text-bg-success">stored ...${escapeHtml(cred.apiKeyHint || '')}</span>`
    : '<span class="badge text-bg-warning">no key stored</span>';
  const insecure = cred.insecureTls
    ? ' <span class="badge text-bg-warning" title="self-signed certificates are accepted">insecure TLS</span>'
    : '';
  const usedBy = Array.isArray(cred.hostIds) && cred.hostIds.length
    ? `<div class="small text-secondary">hosts: ${cred.hostIds.map((id) => escapeHtml(hostLabel(id))).join(', ')}</div>`
    : '<div class="small text-secondary">no host uses it yet</div>';
  const action = (name, icon, label, variant = 'outline-secondary') =>
    `<button type="button" class="btn btn-sm btn-${variant}" data-action="${name}" data-credential="${escapeHtml(cred.id)}"` +
    ` title="${escapeHtml(label)}"><i class="bi ${icon} me-1"></i>${escapeHtml(label)}</button>`;
  return (
    '<div class="col-12 col-lg-6"><div class="card pc-credential-card h-100"><div class="card-body">' +
    `<div class="d-flex align-items-start gap-2"><h6 class="card-title mb-1 me-auto">${escapeHtml(cred.name)}</h6>${key}${insecure}</div>` +
    `<div class="pc-cred-url text-secondary">${escapeHtml(cred.url)}</div>` +
    usedBy +
    '<div class="d-flex flex-wrap gap-1 mt-2">' +
    action('cred-test', 'bi-plug', 'Test') +
    action('cred-import', 'bi-download', 'Import endpoints', 'outline-primary') +
    action('cred-edit', 'bi-pencil', 'Edit') +
    action('cred-delete', 'bi-trash', 'Delete', 'outline-danger') +
    '</div></div></div></div>'
  );
}

/**
 * GET /api/credentials/portainer -> #credentials-list. THE API KEY IS WRITE-ONLY: it is
 * never rendered, never logged and never stored in localStorage - only `apiKeyHint` is.
 * @returns {Promise<void>}
 */
export async function reloadCredentials() {
  const list = byId('credentials-list');
  try {
    const res = await api.credentials.portainer.list();
    credentials = Array.isArray(res && res.credentials) ? res.credentials : [];
  } catch (err) {
    credentials = [];
    if (list && (!err || err.status !== 401)) {
      list.innerHTML = `<div class="col-12 small text-secondary">Could not load the credentials: ${escapeHtml((err && err.message) || 'unknown error')}</div>`;
    }
    return;
  }
  if (!list) return;
  list.innerHTML = credentials.length
    ? credentials.map(credentialCard).join('')
    : '<div class="col-12 small text-secondary">No Portainer credential stored yet.</div>';
}

/**
 * Open #credential-modal. Edit fills name/url/insecure, leaves #cf-apikey EMPTY and shows
 * the stored hint next to the label.
 * @param {any|null} credential
 */
export function openCredentialModal(credential = null) {
  editingCredential = credential;
  const title = byId('credential-modal-title');
  if (title) title.textContent = credential ? `Edit ${credential.name}` : 'Add Portainer credential';
  const name = byId('cf-name');
  const url = byId('cf-url');
  const apiKey = byId('cf-apikey');
  const insecure = byId('cf-insecure');
  const hint = byId('cf-key-hint');
  if (name) name.value = credential ? credential.name || '' : '';
  if (url) url.value = credential ? credential.url || '' : '';
  // never prefilled: the key is write-only (api.md "Portainer credentials")
  if (apiKey) {
    apiKey.value = '';
    apiKey.placeholder = credential && credential.apiKeySet ? 'leave blank to keep the stored key' : 'required';
  }
  if (insecure) insecure.checked = !!(credential && credential.insecureTls);
  if (hint) {
    hint.textContent = credential && credential.apiKeySet ? `(stored ...${credential.apiKeyHint || ''})` : '';
  }
  setText('credential-form-error', '');
  const result = byId('credential-test-result');
  if (result) result.innerHTML = '';
  const modal = modalFor('credential-modal');
  if (modal) modal.show();
}

/** The typed credential fields; `apiKey` is omitted when the field is empty. */
function readCredentialForm() {
  const value = (id) => {
    const el = byId(id);
    return el ? String(el.value || '').trim() : '';
  };
  /** @type {any} */
  const input = { name: value('cf-name'), url: value('cf-url') };
  const insecure = byId('cf-insecure');
  input.insecureTls = !!(insecure && insecure.checked);
  const apiKey = byId('cf-apikey');
  const typed = apiKey ? String(apiKey.value || '') : '';
  // an empty field means "keep the stored key": the property is OMITTED, never sent as ''
  if (typed) input.apiKey = typed;
  return input;
}

/**
 * POST /api/credentials/portainer/test (create) or POST …/:id/test (edit, sending only what
 * was typed) -> #credential-test-result.
 * @returns {Promise<void>}
 */
export async function testCredentialForm() {
  const out = byId('credential-test-result');
  const btn = byId('btn-credential-test');
  const input = readCredentialForm();
  setText('credential-form-error', '');
  if (!editingCredential && !input.apiKey) {
    setText('credential-form-error', 'Enter the API key first.');
    return;
  }
  if (!input.url) {
    setText('credential-form-error', 'Enter the Portainer URL first.');
    return;
  }
  if (out) out.innerHTML = '<div class="small text-secondary"><span class="spinner-border spinner-border-sm me-1"></span>talking to Portainer...</div>';
  if (btn) btn.disabled = true;
  try {
    const result = editingCredential
      ? await api.credentials.portainer.testStored(editingCredential.id, input)
      : await api.credentials.portainer.test(input);
    renderTestResult(out, result);
  } catch (err) {
    renderTestResult(out, { ok: false, error: { code: (err && err.code) || 'error', message: (err && err.message) || 'the test failed' } });
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * POST/PUT /api/credentials/portainer[/:id] -> close, reload the list and offer the natural
 * next step ("Import endpoints").
 * @param {Event} [event]
 * @returns {Promise<void>}
 */
export async function saveCredential(event) {
  if (event) event.preventDefault();
  const btn = byId('btn-credential-save');
  const input = readCredentialForm();
  setText('credential-form-error', '');
  if (!input.name) {
    setText('credential-form-error', 'Give the credential a name.');
    return;
  }
  if (!input.url) {
    setText('credential-form-error', 'Enter the Portainer URL.');
    return;
  }
  if (!editingCredential && !input.apiKey) {
    setText('credential-form-error', 'The API key is required when a credential is created.');
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const res = editingCredential
      ? await api.credentials.portainer.update(editingCredential.id, input)
      : await api.credentials.portainer.create(input);
    const saved = (res && res.credential) || null;
    const wasCreate = !editingCredential;
    editingCredential = null;
    const modal = modalFor('credential-modal');
    if (modal) modal.hide();
    await reloadCredentials();
    if (credentialFromHostForm && saved) {
      // the host modal is still open behind this one: point it at the new credential
      credentialFromHostForm = false;
      const select = byId('hf-credential');
      if (select) {
        select.innerHTML = credentialOptionsHtml(saved.id);
        select.value = saved.id;
        void fillEndpointSelect(saved.id, null);
      }
    }
    toast(
      wasCreate
        ? `Credential ${input.name} stored - use "Import endpoints" to create one host per endpoint.`
        : `Credential ${input.name} updated`,
      { variant: 'success' },
    );
  } catch (err) {
    if (err && err.code === 'validation_error') setText('credential-form-error', issueLines(err));
    else setText('credential-form-error', (err && err.message) || 'Could not save the credential');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * confirmDialog -> DELETE /api/credentials/portainer/:id. A 409 (a host still references it)
 * is reported as-is: deleting those hosts first is a deliberate step.
 * @param {any} credential
 * @returns {Promise<void>}
 */
export async function deleteCredential(credential) {
  if (!credential) return;
  const ok = await confirmDialog({
    title: `Delete ${credential.name}?`,
    body: 'The stored API key is removed. Hosts that use this credential must be deleted first.',
    confirmLabel: 'Delete credential',
  });
  if (!ok) return;
  try {
    await api.credentials.portainer.remove(credential.id);
    toast(`Credential ${credential.name} deleted`, { variant: 'success' });
    await reloadCredentials();
  } catch (err) {
    toastError(err, 'Could not delete the credential');
  }
}

/**
 * GET /api/credentials/portainer/:id/endpoints -> #import-endpoints (one checkbox each) and
 * show #import-modal.
 * @param {any} credential
 * @returns {Promise<void>}
 */
export async function openImportModal(credential) {
  importingCredential = credential;
  const nameEl = byId('import-credential-name');
  if (nameEl) nameEl.textContent = credential ? credential.name : '';
  const list = byId('import-endpoints');
  const result = byId('import-result');
  if (result) result.innerHTML = '';
  if (list) list.innerHTML = '<div class="small text-secondary"><span class="spinner-border spinner-border-sm me-1"></span>loading endpoints...</div>';
  const modal = modalFor('import-modal');
  if (modal) modal.show();
  if (!list || !credential) return;
  try {
    const res = await api.credentials.portainer.endpoints(credential.id);
    const endpoints = Array.isArray(res && res.endpoints) ? res.endpoints : [];
    if (!endpoints.length) {
      list.innerHTML = '<div class="small text-secondary">This key cannot see any endpoint.</div>';
      return;
    }
    list.innerHTML = endpoints
      .map((ep) => {
        const docker = DOCKER_ENDPOINT_TYPES.includes(Number(ep.type));
        const id = `import-ep-${escapeHtml(String(ep.id))}`;
        return (
          '<div class="form-check">' +
          `<input class="form-check-input" type="checkbox" id="${id}" data-endpoint="${escapeHtml(String(ep.id))}"` +
          `${docker ? ' checked' : ' disabled'}>` +
          `<label class="form-check-label" for="${id}">${escapeHtml(ep.name || '(unnamed)')}` +
          ` <span class="text-secondary font-monospace small">#${escapeHtml(String(ep.id))}</span> ` +
          (docker
            ? '<span class="badge text-bg-secondary">docker</span>'
            : '<span class="badge text-bg-warning">not a docker endpoint</span>') +
          (ep.url ? ` <span class="small text-secondary">${escapeHtml(ep.url)}</span>` : '') +
          '</label></div>'
        );
      })
      .join('');
  } catch (err) {
    list.innerHTML = `<div class="alert alert-warning py-2 small mb-0">${escapeHtml((err && err.message) || 'could not list the endpoints')}</div>`;
  }
}

/**
 * POST /api/credentials/portainer/:id/import -> the summary stays in the modal while the
 * host table refreshes behind it.
 * @returns {Promise<void>}
 */
export async function runImport() {
  if (!importingCredential) return;
  const btn = byId('btn-import-run');
  const out = byId('import-result');
  /** @type {number[]} */
  const endpointIds = [];
  document.querySelectorAll('#import-endpoints [data-endpoint]').forEach((el) => {
    if (el.checked) endpointIds.push(Number(el.getAttribute('data-endpoint')));
  });
  if (!endpointIds.length) {
    if (out) out.innerHTML = '<div class="alert alert-warning py-2 small mb-0">Pick at least one endpoint.</div>';
    return;
  }
  const templateEl = byId('import-name-template');
  const updateEl = byId('import-update');
  const input = {
    endpointIds,
    nameTemplate: templateEl ? String(templateEl.value || '{name}').trim() || '{name}' : '{name}',
    update: !!(updateEl && updateEl.checked),
  };
  if (btn) btn.disabled = true;
  if (out) out.innerHTML = '<div class="small text-secondary"><span class="spinner-border spinner-border-sm me-1"></span>importing...</div>';
  try {
    const res = await api.credentials.portainer.importEndpoints(importingCredential.id, input);
    const result = (res && res.result) || {};
    const created = Array.isArray(result.created) ? result.created : [];
    const updated = Array.isArray(result.updated) ? result.updated : [];
    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    const skippedHtml = skipped.length
      ? '<ul class="small mb-0 ps-3">' +
        skipped
          .map(
            (s) =>
              `<li>#${escapeHtml(String(s.endpointId))} ${escapeHtml(s.name || '')}: ${escapeHtml(s.reason || 'skipped')}</li>`,
          )
          .join('') +
        '</ul>'
      : '';
    if (out) {
      out.innerHTML =
        `<div class="alert alert-${created.length || updated.length ? 'success' : 'warning'} py-2 mb-0">` +
        `<div class="fw-semibold">${escapeHtml(String(created.length))} created, ${escapeHtml(String(updated.length))} updated, ${escapeHtml(String(skipped.length))} skipped</div>` +
        (created.length ? `<div class="small">created: ${created.map((id) => escapeHtml(id)).join(', ')}</div>` : '') +
        (updated.length ? `<div class="small">updated: ${updated.map((id) => escapeHtml(id)).join(', ')}</div>` : '') +
        skippedHtml +
        '</div>';
    }
    await reload();
  } catch (err) {
    if (out) {
      out.innerHTML = `<div class="alert alert-danger py-2 mb-0">${escapeHtml((err && err.message) || 'the import failed')}</div>`;
    }
    toastError(err, 'Could not import the endpoints');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// panel lifecycle
// ---------------------------------------------------------------------------

function onHostsTableClick(event) {
  const btn = event.target.closest('button[data-action][data-host]');
  if (!btn || btn.disabled) return;
  const host = getHost(btn.getAttribute('data-host'));
  if (!host) return;
  switch (btn.getAttribute('data-action')) {
    case 'test':
      void testHost(host);
      break;
    case 'info':
      void showHostInfo(host);
      break;
    case 'default':
      void makeDefault(host.id);
      break;
    case 'edit':
      openHostModal(host);
      break;
    case 'delete':
      void deleteHost(host);
      break;
    default:
      break;
  }
}

function onCredentialsClick(event) {
  const btn = event.target.closest('button[data-action][data-credential]');
  if (!btn || btn.disabled) return;
  const cred = credentials.find((c) => c && c.id === btn.getAttribute('data-credential'));
  if (!cred) return;
  switch (btn.getAttribute('data-action')) {
    case 'cred-test':
      openCredentialModal(cred);
      void testCredentialForm();
      break;
    case 'cred-import':
      void openImportModal(cred);
      break;
    case 'cred-edit':
      openCredentialModal(cred);
      break;
    case 'cred-delete':
      void deleteCredential(cred);
      break;
    default:
      break;
  }
}

const hostsPanel = {
  /** @param {any} ctx AppContext */
  async init(ctx) {
    void ctx;
    if (initialised) return;
    initialised = true;

    const newBtn = byId('btn-host-new');
    if (newBtn) newBtn.addEventListener('click', () => openHostModal(null));
    const refresh = byId('btn-hosts-refresh');
    if (refresh) refresh.addEventListener('click', () => { void reload({ probe: true }); });
    const newCred = byId('btn-credential-new');
    if (newCred) {
      newCred.addEventListener('click', () => {
        credentialFromHostForm = false;
        openCredentialModal(null);
      });
    }
    const importRun = byId('btn-import-run');
    if (importRun) importRun.addEventListener('click', () => { void runImport(); });
    const hostTest = byId('btn-host-test');
    if (hostTest) hostTest.addEventListener('click', () => { void testHostForm(); });
    const credTest = byId('btn-credential-test');
    if (credTest) credTest.addEventListener('click', () => { void testCredentialForm(); });

    const hostForm = byId('host-form');
    if (hostForm) hostForm.addEventListener('submit', (e) => { void saveHost(e); });
    const credForm = byId('credential-form');
    if (credForm) credForm.addEventListener('submit', (e) => { void saveCredential(e); });

    const tbody = byId('hosts-tbody');
    if (tbody) tbody.addEventListener('click', onHostsTableClick);
    const credList = byId('credentials-list');
    if (credList) credList.addEventListener('click', onCredentialsClick);

    const hostModal = byId('host-modal');
    if (hostModal) hostModal.addEventListener('hidden.bs.modal', () => { editingHost = null; });
    const credModal = byId('credential-modal');
    if (credModal) {
      credModal.addEventListener('hidden.bs.modal', () => {
        editingCredential = null;
        credentialFromHostForm = false;
        const key = byId('cf-apikey');
        if (key) key.value = ''; // the typed key never survives the dialog
      });
    }
    const importModal = byId('import-modal');
    if (importModal) importModal.addEventListener('hidden.bs.modal', () => { importingCredential = null; });

    // the agent registry is followed through the bus (no import: see the module-graph note)
    bus.on(EVENTS.AGENTS_CHANGED, ({ agents }) => {
      agentDefs = Array.isArray(agents) ? agents : [];
      renderHosts();
    });

    renderHosts();
  },
  /** Panel entry: refresh from the server's probe cache (never a blocking probe). */
  show() {
    void reload();
  },
  hide() {},
};

export default hostsPanel;
