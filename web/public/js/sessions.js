// OWNER: F1. Sessions tab: table, create/edit modal, lifecycle actions, logs modal.
// CROSS-PACKAGE CONTRACT (FROZEN):
//   * after every successful list()/poll/CRUD, emit
//     bus.emit(EVENTS.SESSIONS_CHANGED, { sessions }) with the raw SessionView[] from the API
//   * the row action "Open terminal" must emit
//     bus.emit(EVENTS.OPEN_TERMINAL, { session: name, shell: 'bash'|'claude' })
//     and then navigate to #/code (F2 opens the pane).
//   * getSessions() must return the last known SessionView[] (F2 uses it on first paint).
import { api } from './api.js';
import { bus, EVENTS } from './bus.js';
import {
  byId, toast, toastError, confirmDialog, escapeHtml, fmtDuration, statusBadgeClass,
  anyModalOpen, renderAlert,
} from './util.js';

/** Poll cadence (mirrors app.js SESSION_POLL_MS; kept local to avoid an import cycle). */
export const POLL_MS = 5000;
/** Backoff cadence after 3 consecutive failures. */
export const POLL_BACKOFF_MS = 30000;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** Fallback recipe names when the backend cannot answer GET /api/images/recipes. */
const FALLBACK_RECIPES = ['node', 'dotnet', 'php', 'python', 'go', 'base'];

/** @type {any[]} */
let sessions = [];
/** @type {any} */
let appCtx = null;
/** @type {any[]} */
let recipes = [];
/** @type {string[]} */
let imageRefs = [];
/** @type {string[]} */
let networks = [];
/** @type {any|null} session currently open in the modal (null = create) */
let editing = null;
/** @type {Set<string>} rows with a request in flight */
const busyRows = new Set();

let pollTimer = null;
let pollFailures = 0;
let initialised = false;
let logsState = { name: null, timer: null };

/** FROZEN: F2 calls this for its initial rail paint. @returns {any[]} SessionView[] */
export function getSessions() {
  return sessions;
}

// ---------------------------------------------------------------------------
// table
// ---------------------------------------------------------------------------

function imageLabel(session) {
  const image = session.image || {};
  if (image.type === 'recipe') {
    const recipe = recipes.find((r) => r.name === image.recipe);
    return recipe ? `${recipe.title} (${image.recipe})` : `recipe: ${image.recipe}`;
  }
  return image.ref || '-';
}

function workspaceLabel(session) {
  const ws = session.workspace || { type: 'volume' };
  if (ws.type === 'bind') return `bind ${ws.hostPath}`;
  if (ws.type === 'git') return `git ${ws.url}${ws.branch ? `#${ws.branch}` : ''}`;
  return `volume ${ws.volume || `porterclaude-ws-${session.name}`}`;
}

function portsLabel(session) {
  const runtime = Array.isArray(session.runtimePorts) && session.runtimePorts.length
    ? session.runtimePorts
    : session.ports || [];
  if (!runtime.length) return '<span class="text-secondary">-</span>';
  return runtime
    .map((p) => {
      const host = p.hostPort ? `${p.hostPort}&rarr;` : '';
      return `<span class="badge text-bg-light border me-1">${escapeHtml(host)}${escapeHtml(String(p.containerPort))}/${escapeHtml(p.protocol || 'tcp')}</span>`;
    })
    .join('');
}

function actionButton(name, action, icon, label, opts = {}) {
  const disabled = opts.disabled ? ' disabled' : '';
  const variant = opts.variant || 'outline-secondary';
  return (
    `<button type="button" class="btn btn-sm btn-${variant}" data-action="${action}" data-name="${escapeHtml(name)}"` +
    ` title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"${disabled}><i class="bi ${icon}"></i></button>`
  );
}

function rowActions(session) {
  const name = session.name;
  const running = session.status === 'running';
  const absent = session.status === 'absent';
  const orphan = !!session.orphan;
  const busy = busyRows.has(name);
  const parts = [];
  parts.push(actionButton(name, 'terminal', 'bi-terminal', 'Open terminal', { disabled: busy || !running, variant: 'outline-primary' }));
  if (running) {
    parts.push(actionButton(name, 'stop', 'bi-stop-circle', 'Stop', { disabled: busy }));
    parts.push(actionButton(name, 'restart', 'bi-arrow-clockwise', 'Restart', { disabled: busy }));
  } else {
    parts.push(actionButton(name, 'start', 'bi-play-circle', 'Start', { disabled: busy || orphan }));
  }
  parts.push(actionButton(name, 'recreate', 'bi-arrow-repeat', 'Recreate container', { disabled: busy || orphan }));
  parts.push(actionButton(name, 'edit', 'bi-pencil', 'Edit (recreates the container)', { disabled: busy || orphan }));
  parts.push(actionButton(name, 'logs', 'bi-file-text', 'Logs', { disabled: busy || absent }));
  parts.push(actionButton(name, 'destroy', 'bi-trash', 'Destroy', { disabled: busy, variant: 'outline-danger' }));
  const spinner = busy ? '<span class="spinner-border spinner-border-sm text-secondary ms-2" role="status" aria-hidden="true"></span>' : '';
  return `<div class="btn-group btn-group-sm pc-row-actions" role="group">${parts.join('')}</div>${spinner}`;
}

function pills(session) {
  const out = [];
  if (session.needsRecreate) {
    out.push('<span class="badge text-bg-warning ms-1" title="the stored config no longer matches the running container">config changed</span>');
  }
  if (session.orphan) {
    out.push('<span class="badge text-bg-info ms-1" title="container carries porterclaude labels but has no stored config">orphan</span>');
  }
  return out.join('');
}

/** Render one <tr> per session into #sessions-tbody. */
function render() {
  const tbody = byId('sessions-tbody');
  const empty = byId('sessions-empty');
  if (!tbody) return;
  if (!sessions.length) {
    tbody.innerHTML = '';
    if (empty) empty.classList.remove('d-none');
    return;
  }
  if (empty) empty.classList.add('d-none');

  tbody.innerHTML = sessions
    .map((s) => {
      const warnings = Array.isArray(s.warnings) ? s.warnings : [];
      const warnTitle = warnings.length ? ` title="${escapeHtml(warnings.join(' | '))}"` : '';
      const warnIcon = warnings.length
        ? ` <i class="bi bi-exclamation-triangle-fill text-warning"${warnTitle}></i>`
        : '';
      return (
        `<tr data-name="${escapeHtml(s.name)}"${busyRows.has(s.name) ? ' class="opacity-75"' : ''}>` +
        `<td><div class="fw-semibold">${escapeHtml(s.name)}${warnIcon}${pills(s)}</div>` +
        (s.displayName ? `<div class="small text-secondary">${escapeHtml(s.displayName)}</div>` : '') +
        '</td>' +
        `<td><div>${escapeHtml(imageLabel(s))}</div>` +
        (s.resolvedImage ? `<div class="small text-secondary font-monospace">${escapeHtml(s.resolvedImage)}</div>` : '') +
        '</td>' +
        `<td class="small">${escapeHtml(workspaceLabel(s))}</td>` +
        `<td><span class="badge ${statusBadgeClass(s.status)}">${escapeHtml(s.status)}</span></td>` +
        `<td>${portsLabel(s)}</td>` +
        `<td class="small">${escapeHtml(fmtDuration(s.uptimeSec))}</td>` +
        `<td class="text-end text-nowrap">${rowActions(s)}</td>` +
        '</tr>'
      );
    })
    .join('');
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

function publish() {
  bus.emit(EVENTS.SESSIONS_CHANGED, { sessions });
}

/** Load GET /api/sessions, store, render, emit SESSIONS_CHANGED. */
export async function reload() {
  const alertBox = byId('sessions-alert');
  try {
    const res = await api.sessions.list();
    sessions = Array.isArray(res && res.sessions) ? res.sessions : [];
    pollFailures = 0;
    renderAlert(alertBox, '');
    render();
    publish();
    return sessions;
  } catch (err) {
    pollFailures += 1;
    if (err && err.code === 'backend_not_configured') {
      sessions = [];
      render();
      publish();
      renderAlert(
        alertBox,
        'No Docker backend is configured yet. <a href="#/settings" class="alert-link">Open Settings</a> to connect Portainer or the local socket.',
        'warning',
      );
      return sessions;
    }
    if (err && err.status === 401) return sessions;
    renderAlert(alertBox, `Could not list sessions: ${escapeHtml((err && err.message) || 'unknown error')}`, 'danger');
    throw err;
  }
}

function scheduleNextPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const delay = pollFailures >= 3 ? POLL_BACKOFF_MS : POLL_MS;
  pollTimer = setTimeout(tick, delay);
}

async function tick() {
  if (document.visibilityState === 'hidden' || anyModalOpen()) {
    scheduleNextPoll();
    return;
  }
  try {
    await reload();
  } catch {
    /* reload() already surfaced it inline */
  }
  scheduleNextPoll();
}

function startPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(tick, POLL_MS);
}

// ---------------------------------------------------------------------------
// lookups used by the modal
// ---------------------------------------------------------------------------

async function loadRecipes() {
  try {
    const res = await api.images.recipes();
    recipes = Array.isArray(res && res.recipes) ? res.recipes : [];
  } catch {
    recipes = FALLBACK_RECIPES.map((name) => ({ name, title: name, built: null }));
  }
  return recipes;
}

async function loadLookups() {
  await loadRecipes();
  try {
    const res = await api.images.list();
    const list = Array.isArray(res && res.images) ? res.images : [];
    imageRefs = [];
    for (const img of list) {
      // ImageSummary (backends/types.ts) exposes `tags`; repoTags/RepoTags kept as fallbacks.
      for (const tag of img.tags || img.repoTags || img.RepoTags || []) {
        if (tag && tag !== '<none>:<none>') imageRefs.push(tag);
      }
    }
  } catch {
    imageRefs = [];
  }
  try {
    const res = await api.docker.networks();
    const list = Array.isArray(res && res.networks) ? res.networks : [];
    networks = list.map((n) => n.name || n.Name).filter(Boolean);
  } catch {
    networks = [];
  }
}

// ---------------------------------------------------------------------------
// create/edit modal
// ---------------------------------------------------------------------------

function kvRow(key = '', value = '') {
  return (
    '<div class="row g-2 mb-2 pc-kv-row" data-row="env">' +
    `<div class="col-5"><input class="form-control form-control-sm" data-field="key" placeholder="KEY" value="${escapeHtml(key)}"></div>` +
    `<div class="col-6"><input class="form-control form-control-sm" data-field="value" placeholder="value" value="${escapeHtml(value)}"></div>` +
    '<div class="col-1 d-grid"><button type="button" class="btn btn-sm btn-outline-danger" data-remove-row aria-label="Remove"><i class="bi bi-x"></i></button></div>' +
    '</div>'
  );
}

function portRow(port = {}) {
  const proto = port.protocol === 'udp' ? 'udp' : 'tcp';
  return (
    '<div class="row g-2 mb-2 pc-kv-row" data-row="port">' +
    `<div class="col-4"><input type="number" min="1" max="65535" class="form-control form-control-sm" data-field="containerPort" placeholder="container port" value="${port.containerPort ? escapeHtml(String(port.containerPort)) : ''}"></div>` +
    `<div class="col-4"><input type="number" min="1" max="65535" class="form-control form-control-sm" data-field="hostPort" placeholder="host port (blank = random)" value="${port.hostPort ? escapeHtml(String(port.hostPort)) : ''}"></div>` +
    '<div class="col-3"><select class="form-select form-select-sm" data-field="protocol">' +
    `<option value="tcp"${proto === 'tcp' ? ' selected' : ''}>tcp</option><option value="udp"${proto === 'udp' ? ' selected' : ''}>udp</option>` +
    '</select></div>' +
    '<div class="col-1 d-grid"><button type="button" class="btn btn-sm btn-outline-danger" data-remove-row aria-label="Remove"><i class="bi bi-x"></i></button></div>' +
    '</div>'
  );
}

function mountRow(mount = {}) {
  const type = mount.type || 'volume';
  const opt = (v, label) => `<option value="${v}"${type === v ? ' selected' : ''}>${label}</option>`;
  return (
    '<div class="row g-2 mb-2 pc-kv-row" data-row="mount">' +
    `<div class="col-2"><select class="form-select form-select-sm" data-field="type">${opt('volume', 'volume')}${opt('bind', 'bind')}${opt('tmpfs', 'tmpfs')}</select></div>` +
    `<div class="col-4"><input class="form-control form-control-sm" data-field="source" placeholder="source" value="${escapeHtml(mount.source || '')}"></div>` +
    `<div class="col-4"><input class="form-control form-control-sm" data-field="target" placeholder="/target" value="${escapeHtml(mount.target || '')}"></div>` +
    '<div class="col-1 d-flex align-items-center"><div class="form-check mb-0">' +
    `<input class="form-check-input" type="checkbox" data-field="readOnly"${mount.readOnly ? ' checked' : ''} title="read only"></div></div>` +
    '<div class="col-1 d-grid"><button type="button" class="btn btn-sm btn-outline-danger" data-remove-row aria-label="Remove"><i class="bi bi-x"></i></button></div>' +
    '</div>'
  );
}

function sessionFormHtml(session) {
  const isEdit = !!session;
  const s = session || {};
  const image = s.image || { type: 'recipe', recipe: (recipes[0] && recipes[0].name) || 'node' };
  const ws = s.workspace || { type: 'volume' };
  const limits = s.limits || {};
  const recipeOptions = (recipes.length ? recipes : FALLBACK_RECIPES.map((n) => ({ name: n, title: n })))
    .map((r) => {
      const selected = image.type === 'recipe' && image.recipe === r.name ? ' selected' : '';
      const built = r.built === false ? ' (not built)' : '';
      return `<option value="${escapeHtml(r.name)}"${selected}>${escapeHtml(r.title || r.name)}${built}</option>`;
    })
    .join('');
  const imageList = imageRefs.map((ref) => `<option value="${escapeHtml(ref)}"></option>`).join('');
  const networkList = networks.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
  const envRows = Object.entries(s.env || {}).map(([k, v]) => kvRow(k, v)).join('');
  const portRows = (s.ports || []).map((p) => portRow(p)).join('');
  const mountRows = (s.extraMounts || []).map((m) => mountRow(m)).join('');

  return (
    '<div class="row g-3">' +
    `<div class="col-md-5"><label class="form-label" for="sf-name">Name</label>
       <input class="form-control" id="sf-name" value="${escapeHtml(s.name || '')}" ${isEdit ? 'readonly' : ''} placeholder="web" pattern="[a-z0-9][a-z0-9-]{0,30}">
       <div class="form-text">lowercase letters, digits and dashes${isEdit ? ' - immutable' : ''}</div></div>` +
    `<div class="col-md-7"><label class="form-label" for="sf-display">Display name</label>
       <input class="form-control" id="sf-display" value="${escapeHtml(s.displayName || '')}" placeholder="optional"></div>` +

    '<div class="col-12"><hr class="my-1"></div>' +
    '<div class="col-12"><label class="form-label d-block">Image</label>' +
    '<div class="form-check form-check-inline">' +
    `<input class="form-check-input" type="radio" name="sfImageType" id="sf-image-recipe" value="recipe"${image.type !== 'custom' ? ' checked' : ''}>` +
    '<label class="form-check-label" for="sf-image-recipe">Recipe</label></div>' +
    '<div class="form-check form-check-inline">' +
    `<input class="form-check-input" type="radio" name="sfImageType" id="sf-image-custom" value="custom"${image.type === 'custom' ? ' checked' : ''}>` +
    '<label class="form-check-label" for="sf-image-custom">Custom image</label></div></div>' +
    `<div class="col-12${image.type === 'custom' ? ' d-none' : ''}" id="sf-recipe-fields">
       <select class="form-select" id="sf-recipe" aria-label="Recipe">${recipeOptions}</select></div>` +
    `<div class="col-12${image.type === 'custom' ? '' : ' d-none'}" id="sf-custom-fields">
       <div class="input-group">
         <input class="form-control" id="sf-custom-ref" list="sf-image-list" placeholder="nginx:1.27" value="${escapeHtml(image.ref || '')}">
         <button class="btn btn-outline-secondary" type="button" id="btn-validate-image">Validate</button>
       </div>
       <datalist id="sf-image-list">${imageList}</datalist>
       <div id="sf-validate-result" class="small mt-2"></div></div>` +

    '<div class="col-12"><hr class="my-1"></div>' +
    '<div class="col-12"><label class="form-label d-block">Workspace</label>' +
    ['volume', 'bind', 'git']
      .map(
        (t) =>
          '<div class="form-check form-check-inline">' +
          `<input class="form-check-input" type="radio" name="sfWsType" id="sf-ws-${t}" value="${t}"${ws.type === t ? ' checked' : ''}>` +
          `<label class="form-check-label" for="sf-ws-${t}">${t === 'volume' ? 'New volume' : t === 'bind' ? 'Host path' : 'Git clone'}</label></div>`,
      )
      .join('') +
    '</div>' +
    `<div class="col-12${ws.type === 'volume' ? '' : ' d-none'}" id="sf-ws-volume-fields">
       <input class="form-control" id="sf-ws-volume-name" placeholder="volume name (blank = porterclaude-ws-&lt;name&gt;)" value="${escapeHtml(ws.type === 'volume' ? ws.volume || '' : '')}"></div>` +
    `<div class="col-12${ws.type === 'bind' ? '' : ' d-none'}" id="sf-ws-bind-fields">
       <input class="form-control" id="sf-ws-hostpath" placeholder="/srv/projects/web" value="${escapeHtml(ws.type === 'bind' ? ws.hostPath || '' : '')}">
       <div class="form-text">path on the Docker host</div></div>` +
    `<div class="col-12${ws.type === 'git' ? '' : ' d-none'}" id="sf-ws-git-fields"><div class="row g-2">
       <div class="col-md-8"><input class="form-control" id="sf-ws-giturl" placeholder="https://github.com/me/repo.git" value="${escapeHtml(ws.type === 'git' ? ws.url || '' : '')}"></div>
       <div class="col-md-4"><input class="form-control" id="sf-ws-branch" placeholder="branch (optional)" value="${escapeHtml(ws.type === 'git' ? ws.branch || '' : '')}"></div>
     </div></div>` +

    '<div class="col-12"><hr class="my-1"></div>' +
    `<div class="col-12"><label class="form-label d-block">Environment</label>
       <div id="sf-env-rows">${envRows}</div>
       <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-add-env"><i class="bi bi-plus-lg me-1"></i>Add variable</button></div>` +
    `<div class="col-12"><label class="form-label d-block">Ports</label>
       <div id="sf-port-rows">${portRows}</div>
       <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-add-port"><i class="bi bi-plus-lg me-1"></i>Add port</button></div>` +
    `<div class="col-12"><label class="form-label d-block">Extra mounts</label>
       <div id="sf-mount-rows">${mountRows}</div>
       <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-add-mount"><i class="bi bi-plus-lg me-1"></i>Add mount</button></div>` +

    '<div class="col-12"><hr class="my-1"></div>' +
    `<div class="col-md-3"><label class="form-label" for="sf-cpus">CPUs</label>
       <input type="number" step="0.1" min="0" class="form-control" id="sf-cpus" value="${limits.cpus ? escapeHtml(String(limits.cpus)) : ''}" placeholder="unlimited"></div>` +
    `<div class="col-md-3"><label class="form-label" for="sf-memory">Memory (MB)</label>
       <input type="number" min="1" class="form-control" id="sf-memory" value="${limits.memoryMb ? escapeHtml(String(limits.memoryMb)) : ''}" placeholder="unlimited"></div>` +
    `<div class="col-md-3"><label class="form-label" for="sf-network">Network</label>
       <input class="form-control" id="sf-network" list="sf-network-list" value="${escapeHtml(s.network || '')}" placeholder="default bridge">
       <datalist id="sf-network-list">${networkList}</datalist></div>` +
    `<div class="col-md-3"><label class="form-label" for="sf-user">User</label>
       <input class="form-control" id="sf-user" value="${escapeHtml(s.user || '')}" placeholder="image default"></div>` +
    '<div class="col-12 d-flex gap-4">' +
    '<div class="form-check"><input class="form-check-input" type="checkbox" id="sf-share-history"' +
    `${s.shareHistory === false ? '' : ' checked'}>` +
    '<label class="form-check-label" for="sf-share-history">Share Claude conversation history</label></div>' +
    '<div class="form-check"><input class="form-check-input" type="checkbox" id="sf-autostart"' +
    `${s.autoStart === false ? '' : ' checked'}>` +
    '<label class="form-check-label" for="sf-autostart">Start automatically</label></div>' +
    '</div>' +
    (isEdit
      ? '<div class="col-12"><div class="alert alert-warning py-2 small mb-0">Saving recreates the container. The workspace and named volumes survive.</div></div>'
      : '') +
    '</div>'
  );
}

function setFormError(message) {
  const el = byId('session-form-error');
  if (el) el.textContent = message || '';
}

function clearFieldErrors() {
  const body = byId('session-form-body');
  if (!body) return;
  body.querySelectorAll('.is-invalid').forEach((el) => el.classList.remove('is-invalid'));
}

/** zod issue path -> input id in the session form. */
const FIELD_IDS = {
  name: 'sf-name',
  displayName: 'sf-display',
  image: 'sf-custom-ref',
  workspace: 'sf-ws-hostpath',
  network: 'sf-network',
  user: 'sf-user',
  'limits.cpus': 'sf-cpus',
  'limits.memoryMb': 'sf-memory',
};

function applyValidationError(err) {
  clearFieldErrors();
  const issues = Array.isArray(err && err.details) ? err.details : [];
  let mapped = 0;
  for (const issue of issues) {
    const path = Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path || '');
    const id = FIELD_IDS[path] || FIELD_IDS[path.split('.')[0]];
    const el = id ? byId(id) : null;
    if (el) {
      el.classList.add('is-invalid');
      mapped += 1;
    }
  }
  const first = issues[0];
  const detail = first ? `${Array.isArray(first.path) ? first.path.join('.') : ''}: ${first.message}` : '';
  setFormError(mapped ? detail : `${err.message}${detail ? ` (${detail})` : ''}`);
}

/** Serialise #session-form into a SessionInput object; throws on client-side validation. */
export function readSessionForm() {
  const value = (id) => {
    const el = byId(id);
    return el ? String(el.value || '').trim() : '';
  };
  const checked = (id) => {
    const el = byId(id);
    return !!(el && el.checked);
  };

  const name = value('sf-name');
  if (!NAME_RE.test(name)) {
    const el = byId('sf-name');
    if (el) el.classList.add('is-invalid');
    throw new Error('Name must be lowercase letters, digits and dashes (max 31 chars).');
  }

  /** @type {any} */
  const input = { name };
  const displayName = value('sf-display');
  if (displayName) input.displayName = displayName;

  const imageType = checked('sf-image-custom') ? 'custom' : 'recipe';
  if (imageType === 'custom') {
    const ref = value('sf-custom-ref');
    if (!ref) throw new Error('Enter a custom image reference.');
    input.image = { type: 'custom', ref };
  } else {
    const recipe = value('sf-recipe');
    if (!recipe) throw new Error('Pick a recipe.');
    input.image = { type: 'recipe', recipe };
  }

  const wsType = ['volume', 'bind', 'git'].find((t) => checked(`sf-ws-${t}`)) || 'volume';
  if (wsType === 'bind') {
    const hostPath = value('sf-ws-hostpath');
    if (!hostPath) throw new Error('Enter the host path for the workspace.');
    input.workspace = { type: 'bind', hostPath };
  } else if (wsType === 'git') {
    const url = value('sf-ws-giturl');
    if (!url) throw new Error('Enter the git URL for the workspace.');
    input.workspace = { type: 'git', url };
    const branch = value('sf-ws-branch');
    if (branch) input.workspace.branch = branch;
  } else {
    input.workspace = { type: 'volume' };
    const volume = value('sf-ws-volume-name');
    if (volume) input.workspace.volume = volume;
  }

  /** @type {Record<string,string>} */
  const env = {};
  document.querySelectorAll('#sf-env-rows [data-row="env"]').forEach((row) => {
    const key = String(row.querySelector('[data-field="key"]').value || '').trim();
    const val = String(row.querySelector('[data-field="value"]').value || '');
    if (key) env[key] = val;
  });
  input.env = env;

  /** @type {any[]} */
  const ports = [];
  document.querySelectorAll('#sf-port-rows [data-row="port"]').forEach((row) => {
    const containerPort = Number(row.querySelector('[data-field="containerPort"]').value);
    const hostRaw = String(row.querySelector('[data-field="hostPort"]').value || '').trim();
    const protocol = row.querySelector('[data-field="protocol"]').value === 'udp' ? 'udp' : 'tcp';
    if (!containerPort) return;
    /** @type {any} */
    const port = { containerPort, protocol };
    if (hostRaw !== '') port.hostPort = Number(hostRaw);
    ports.push(port);
  });
  input.ports = ports;

  /** @type {any[]} */
  const extraMounts = [];
  document.querySelectorAll('#sf-mount-rows [data-row="mount"]').forEach((row) => {
    const type = row.querySelector('[data-field="type"]').value;
    const source = String(row.querySelector('[data-field="source"]').value || '').trim();
    const target = String(row.querySelector('[data-field="target"]').value || '').trim();
    const readOnly = !!row.querySelector('[data-field="readOnly"]').checked;
    if (!source || !target) return;
    if (!target.startsWith('/')) throw new Error(`Mount target "${target}" must be an absolute path.`);
    extraMounts.push({ type, source, target, readOnly });
  });
  input.extraMounts = extraMounts;

  /** @type {any} */
  const limits = {};
  const cpus = value('sf-cpus');
  if (cpus) limits.cpus = Number(cpus);
  const memoryMb = value('sf-memory');
  if (memoryMb) limits.memoryMb = Number(memoryMb);
  input.limits = limits;

  input.shareHistory = checked('sf-share-history');
  input.autoStart = checked('sf-autostart');
  input.network = value('sf-network') || null;
  input.user = value('sf-user') || null;
  return input;
}

async function validateCustomImage() {
  const el = byId('sf-custom-ref');
  const out = byId('sf-validate-result');
  if (!el || !out) return;
  const ref = String(el.value || '').trim();
  if (!ref) {
    out.innerHTML = '<span class="text-secondary">Enter an image reference first.</span>';
    return;
  }
  out.innerHTML = '<span class="text-secondary"><span class="spinner-border spinner-border-sm me-1"></span>checking…</span>';
  try {
    const res = await api.images.validateCustom(ref);
    const r = (res && res.result) || {};
    const warnings = (r.warnings || []).map((w) => `<li>${escapeHtml(w)}</li>`).join('');
    if (r.ok) {
      out.innerHTML =
        `<div class="text-success">Image is usable${r.pulled ? ' (pulled just now)' : ''}.</div>` +
        `<div class="text-secondary">arch ${escapeHtml(r.architecture || '?')} · user ${escapeHtml(r.user || 'root')}</div>` +
        (warnings ? `<ul class="text-warning mb-0 ps-3">${warnings}</ul>` : '');
    } else {
      out.innerHTML = `<div class="text-danger">${escapeHtml(r.error || 'image cannot be used')}</div>` +
        (warnings ? `<ul class="text-warning mb-0 ps-3">${warnings}</ul>` : '');
    }
  } catch (err) {
    out.innerHTML = `<span class="text-danger">${escapeHtml((err && err.message) || 'validation failed')}</span>`;
  }
}

function wireSessionForm() {
  const body = byId('session-form-body');
  if (!body) return;

  const toggle = (id, on) => {
    const el = byId(id);
    if (el) el.classList.toggle('d-none', !on);
  };
  const syncImage = () => {
    const custom = !!(byId('sf-image-custom') && byId('sf-image-custom').checked);
    toggle('sf-recipe-fields', !custom);
    toggle('sf-custom-fields', custom);
  };
  const syncWorkspace = () => {
    for (const t of ['volume', 'bind', 'git']) {
      const on = !!(byId(`sf-ws-${t}`) && byId(`sf-ws-${t}`).checked);
      toggle(`sf-ws-${t}-fields`, on);
    }
  };
  body.querySelectorAll('input[name="sfImageType"]').forEach((el) => el.addEventListener('change', syncImage));
  body.querySelectorAll('input[name="sfWsType"]').forEach((el) => el.addEventListener('change', syncWorkspace));
  syncImage();
  syncWorkspace();

  const addTo = (containerId, html) => {
    const container = byId(containerId);
    if (container) container.insertAdjacentHTML('beforeend', html);
  };
  const addEnv = byId('btn-add-env');
  if (addEnv) addEnv.addEventListener('click', () => addTo('sf-env-rows', kvRow()));
  const addPort = byId('btn-add-port');
  if (addPort) addPort.addEventListener('click', () => addTo('sf-port-rows', portRow()));
  const addMount = byId('btn-add-mount');
  if (addMount) addMount.addEventListener('click', () => addTo('sf-mount-rows', mountRow()));

  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-row]');
    if (btn) {
      const row = btn.closest('.pc-kv-row');
      if (row) row.remove();
    }
  });

  const validate = byId('btn-validate-image');
  if (validate) validate.addEventListener('click', () => { void validateCustomImage(); });
}

/**
 * Build/populate #session-form-body and show the modal.
 * @param {any|null} session existing SessionView for edit, null for create
 */
export function openSessionModal(session = null) {
  editing = session;
  const body = byId('session-form-body');
  const title = byId('session-modal-title');
  const modalEl = byId('session-modal');
  if (!body || !modalEl || typeof bootstrap === 'undefined') return;
  if (title) title.textContent = session ? `Edit session ${session.name}` : 'New session';
  setFormError('');
  body.innerHTML = sessionFormHtml(session);
  wireSessionForm();
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
  void loadLookups().then(() => {
    // refresh the pickers once the lookups arrive, keeping what the user typed
    if (editing !== session) return;
    const recipeSelect = byId('sf-recipe');
    if (recipeSelect && recipes.length) {
      const current = recipeSelect.value;
      recipeSelect.innerHTML = recipes
        .map((r) => `<option value="${escapeHtml(r.name)}"${r.name === current ? ' selected' : ''}>${escapeHtml(r.title || r.name)}${r.built === false ? ' (not built)' : ''}</option>`)
        .join('');
    }
    const imageList = byId('sf-image-list');
    if (imageList) imageList.innerHTML = imageRefs.map((ref) => `<option value="${escapeHtml(ref)}"></option>`).join('');
    const networkList = byId('sf-network-list');
    if (networkList) networkList.innerHTML = networks.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
  });
}

async function saveSession(event) {
  if (event) event.preventDefault();
  const button = byId('btn-session-save');
  setFormError('');
  clearFieldErrors();
  let input;
  try {
    input = readSessionForm();
  } catch (err) {
    setFormError((err && err.message) || 'Invalid form');
    return;
  }
  if (editing) {
    const ok = await confirmDialog({
      title: 'Recreate the container?',
      body: `Saving <code>${escapeHtml(editing.name)}</code> recreates its container with the new configuration. The workspace and named volumes survive.`,
      confirmLabel: 'Save and recreate',
      variant: 'primary',
    });
    if (!ok) return;
  }
  if (button) button.disabled = true;
  try {
    if (editing) await api.sessions.update(editing.name, input);
    else await api.sessions.create(input);
    const modalEl = byId('session-modal');
    if (modalEl && typeof bootstrap !== 'undefined') bootstrap.Modal.getOrCreateInstance(modalEl).hide();
    toast(`Session ${input.name} ${editing ? 'updated' : 'created'}`, { variant: 'success' });
    editing = null;
    await reload();
  } catch (err) {
    if (err && err.code === 'validation_error') applyValidationError(err);
    else setFormError((err && err.message) || 'Save failed');
  } finally {
    if (button) button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// logs modal
// ---------------------------------------------------------------------------

async function loadLogs() {
  const bodyEl = byId('logs-body');
  const tailEl = byId('logs-tail');
  if (!bodyEl || !logsState.name) return;
  const tail = tailEl ? Number(tailEl.value) || 200 : 200;
  try {
    const res = await api.sessions.logs(logsState.name, { tail });
    bodyEl.textContent = (res && res.logs) || '(no output)';
    bodyEl.scrollTop = bodyEl.scrollHeight;
  } catch (err) {
    bodyEl.textContent = `failed to load logs: ${(err && err.message) || 'unknown error'}`;
  }
}

/** Open #logs-modal for a session. */
export function openLogs(name) {
  const modalEl = byId('logs-modal');
  if (!modalEl || typeof bootstrap === 'undefined') return;
  logsState.name = name;
  const title = byId('logs-modal-title');
  if (title) title.textContent = `Logs · ${name}`;
  const bodyEl = byId('logs-body');
  if (bodyEl) bodyEl.textContent = 'loading…';
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
  void loadLogs();
}

// ---------------------------------------------------------------------------
// row actions
// ---------------------------------------------------------------------------

async function withBusy(name, fn) {
  busyRows.add(name);
  render();
  try {
    await fn();
  } finally {
    busyRows.delete(name);
    render();
  }
}

async function destroySession(session) {
  const name = session.name;
  const first = await confirmDialog({
    title: `Destroy ${name}?`,
    body:
      `This removes the container <code>${escapeHtml(session.containerName || `pc-${name}`)}</code> and the stored definition.` +
      '<div class="form-check mt-3"><input class="form-check-input" type="checkbox" id="confirm-remove-volumes">' +
      '<label class="form-check-label" for="confirm-remove-volumes">also delete the workspace and history volumes</label></div>',
    confirmLabel: 'Destroy',
  });
  if (!first) return;
  const removeVolumes = !!(byId('confirm-remove-volumes') && byId('confirm-remove-volumes').checked);
  if (removeVolumes) {
    const second = await confirmDialog({
      title: 'Delete the volumes too?',
      body: `<strong>porterclaude-ws-${escapeHtml(name)}</strong> and its history volume will be deleted permanently. The shared Claude login volume is never touched.`,
      confirmLabel: 'Delete everything',
    });
    if (!second) return;
  }
  await withBusy(name, async () => {
    try {
      await api.sessions.remove(name, { removeVolumes });
      toast(`Session ${name} destroyed`, { variant: 'success' });
      await reload();
    } catch (err) {
      toastError(err, 'Could not destroy the session');
    }
  });
}

async function runAction(action, name) {
  const session = sessions.find((s) => s.name === name);
  if (!session) return;
  switch (action) {
    case 'terminal':
      bus.emit(EVENTS.OPEN_TERMINAL, { session: name, shell: 'bash' });
      if (appCtx && appCtx.navigate) appCtx.navigate('code');
      return;
    case 'edit':
      openSessionModal(session);
      return;
    case 'logs':
      openLogs(name);
      return;
    case 'destroy':
      await destroySession(session);
      return;
    case 'recreate': {
      const ok = await confirmDialog({
        title: `Recreate ${name}?`,
        body: 'The container is removed and recreated from the stored configuration. Volumes and the workspace survive.',
        confirmLabel: 'Recreate',
        variant: 'primary',
      });
      if (!ok) return;
      break;
    }
    default:
      break;
  }
  await withBusy(name, async () => {
    try {
      if (action === 'start') await api.sessions.start(name);
      else if (action === 'stop') await api.sessions.stop(name);
      else if (action === 'restart') await api.sessions.restart(name);
      else if (action === 'recreate') await api.sessions.recreate(name);
      await reload();
    } catch (err) {
      toastError(err, `Could not ${action} ${name}`);
    }
  });
}

async function reconcile() {
  const btn = byId('btn-reconcile');
  if (btn) btn.disabled = true;
  try {
    const res = await api.sessions.reconcile();
    const report = (res && res.report) || {};
    toast(
      `Reconciled: ${report.known ?? 0} known, ${report.running ?? 0} running, ` +
        `${(report.orphans || []).length} orphan(s), ${(report.missing || []).length} missing`,
      { variant: 'info', title: 'Reconcile' },
    );
    await reload();
  } catch (err) {
    toastError(err, 'Reconcile failed');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// view module
// ---------------------------------------------------------------------------

/** @type {import('./app.js').ViewModule} */
const sessionsView = {
  async init(ctx) {
    if (initialised) return;
    initialised = true;
    appCtx = ctx;

    const tbody = byId('sessions-tbody');
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn || btn.disabled) return;
        void runAction(btn.getAttribute('data-action'), btn.getAttribute('data-name'));
      });
    }

    const newBtn = byId('btn-session-new');
    if (newBtn) {
      newBtn.addEventListener('click', () => {
        void loadLookups().finally(() => openSessionModal(null));
      });
    }
    const refreshBtn = byId('btn-sessions-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => { void reload().catch(() => {}); });
    const reconcileBtn = byId('btn-reconcile');
    if (reconcileBtn) reconcileBtn.addEventListener('click', () => { void reconcile(); });

    const form = byId('session-form');
    if (form) form.addEventListener('submit', (e) => { void saveSession(e); });

    const logsRefresh = byId('btn-logs-refresh');
    if (logsRefresh) logsRefresh.addEventListener('click', () => { void loadLogs(); });
    const logsTail = byId('logs-tail');
    if (logsTail) logsTail.addEventListener('change', () => { void loadLogs(); });
    const logsModal = byId('logs-modal');
    if (logsModal) {
      logsModal.addEventListener('hidden.bs.modal', () => {
        logsState.name = null;
        if (logsState.timer) clearTimeout(logsState.timer);
        logsState.timer = null;
      });
    }
    const sessionModal = byId('session-modal');
    if (sessionModal) sessionModal.addEventListener('hidden.bs.modal', () => { editing = null; });

    bus.on(EVENTS.AUTH_LOST, () => {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
    });
    bus.on(EVENTS.AUTH_READY, () => {
      startPolling();
      void reload().catch(() => {});
    });

    await reload().catch(() => {});
    void loadRecipes();
    startPolling();
  },
  show() {
    void reload().catch(() => {});
  },
  hide() {
    /* keep the poll alive: F2's rail depends on SESSIONS_CHANGED */
  },
  refresh() {
    void reload().catch(() => {});
  },
};

export default sessionsView;
