// OWNER: F1. Settings tab: backend picker (portainer|socket), general config, account,
// plus the Images sub-panel which lives in ./images.js (same package, same owner).
// CROSS-PACKAGE CONTRACT (FROZEN):
//   * after every successful GET/PUT of settings, emit
//     bus.emit(EVENTS.SETTINGS_CHANGED, { settings }) with the full SanitizedSettings object
//   * getSettings() returns the last known SanitizedSettings (or null) - F2 reads
//     `settings.ui.layout` from it on first paint.
import { api } from './api.js';
import { bus, EVENTS } from './bus.js';
import { byId, toast, toastError, escapeHtml, fmtBytes } from './util.js';
import imagesPanel from './images.js';

/** @type {any|null} */
let settings = null;
let initialised = false;
let currentSubtab = 'backend';

/** FROZEN: F2 reads ui.layout / ui.theme from here. @returns {any|null} SanitizedSettings */
export function getSettings() {
  return settings;
}

/** GeneralConfig keys in display order (mirrors server/src/config/schema.ts). */
const GENERAL_FIELDS = [
  { key: 'workspacesRoot', label: 'Workspaces root', help: 'host directory used for bind workspaces' },
  { key: 'sharedClaudeVolume', label: 'Shared .claude volume', help: 'mounted at <container home>/.claude in every session' },
  { key: 'sharedClaudeHomeVolume', label: 'Shared .claude-home volume', help: 'holds ~/.claude.json (account + onboarding)' },
  { key: 'toolsVolume', label: 'Tools volume', help: 'read-only Claude Code binaries for custom images' },
  { key: 'defaultRecipe', label: 'Default recipe' },
  { key: 'containerPrefix', label: 'Container prefix', help: 'containers are named <prefix><session>' },
  { key: 'sessionNetwork', label: 'Session network', help: 'blank = the default bridge network', nullable: true },
  { key: 'imageNamespace', label: 'Image namespace', help: 'recipe images are tagged <namespace>/<recipe>:latest' },
  { key: 'containerHome', label: 'Container home' },
  { key: 'workspaceMount', label: 'Workspace mount' },
  { key: 'toolsMount', label: 'Tools mount' },
];

// ---------------------------------------------------------------------------
// backend panel
// ---------------------------------------------------------------------------

function backendKind() {
  const portainer = byId('backend-kind-portainer');
  return portainer && portainer.checked ? 'portainer' : 'socket';
}

function syncBackendFields() {
  const kind = backendKind();
  const socketFields = byId('backend-socket-fields');
  const portainerFields = byId('backend-portainer-fields');
  if (socketFields) socketFields.classList.toggle('d-none', kind !== 'socket');
  if (portainerFields) portainerFields.classList.toggle('d-none', kind !== 'portainer');
}

/** Read the backend form. The API key is omitted when the (always empty) field is blank. */
function readBackendForm() {
  const kind = backendKind();
  if (kind === 'socket') {
    const socketPath = String((byId('socket-path') || {}).value || '').trim() || '/var/run/docker.sock';
    return { kind: 'socket', socket: { socketPath } };
  }
  const url = String((byId('portainer-url') || {}).value || '').trim();
  const apiKey = String((byId('portainer-api-key') || {}).value || '');
  const endpointRaw = String((byId('portainer-endpoint') || {}).value || '');
  const insecureTls = !!(byId('portainer-insecure') && byId('portainer-insecure').checked);
  /** @type {any} */
  const portainer = { url, insecureTls };
  if (apiKey) portainer.apiKey = apiKey; // blank => keep the stored key (never send "")
  if (endpointRaw !== '') portainer.endpointId = Number(endpointRaw);
  return { kind: 'portainer', portainer };
}

function fillEndpointSelect(endpoints, selectedId) {
  const select = byId('portainer-endpoint');
  if (!select) return;
  const list = Array.isArray(endpoints) ? endpoints : [];
  const current = selectedId ?? (select.value !== '' ? Number(select.value) : null);
  if (!list.length) {
    select.innerHTML = current === null || current === undefined
      ? '<option value="">(test the connection to list endpoints)</option>'
      : `<option value="${escapeHtml(String(current))}" selected>endpoint #${escapeHtml(String(current))}</option>`;
    return;
  }
  select.innerHTML = list
    .map((e) => {
      const id = e.id ?? e.Id;
      const name = e.name ?? e.Name ?? `endpoint ${id}`;
      const sel = Number(id) === Number(current) ? ' selected' : '';
      return `<option value="${escapeHtml(String(id))}"${sel}>${escapeHtml(name)} (#${escapeHtml(String(id))})</option>`;
    })
    .join('');
}

function renderTestResult(html, variant = 'secondary') {
  const box = byId('backend-test-result');
  if (!box) return;
  box.innerHTML = html ? `<div class="alert alert-${variant} py-2 small mb-0">${html}</div>` : '';
}

function infoTable(info) {
  const rows = [
    ['Host', info.name],
    ['Docker', info.serverVersion],
    ['OS', info.os],
    ['Architecture', info.architecture],
    ['CPUs', info.ncpu],
    ['Memory', info.memTotalBytes ? fmtBytes(info.memTotalBytes) : '-'],
    ['Containers', `${info.containersRunning ?? '?'} running / ${info.containers ?? '?'} total`],
    ['Images', info.images],
  ];
  return (
    '<table class="table table-sm mb-0"><tbody>' +
    rows
      .map(([k, v]) => `<tr><th class="fw-normal text-secondary" style="width:10rem">${escapeHtml(k)}</th><td>${escapeHtml(v === undefined || v === null ? '-' : String(v))}</td></tr>`)
      .join('') +
    '</tbody></table>'
  );
}

/**
 * Portainer cannot answer GET /info without an endpoint id, and a first-time setup has
 * none stored yet, so before testing/saving we fetch the endpoint list with the current
 * form values (POST /api/settings/backend/endpoints - it never saves anything) and select
 * the first one. Returns a payload that carries the selected endpointId, if any.
 * @param {any} payload from readBackendForm()
 */
async function ensureEndpointSelected(payload) {
  if (payload.kind !== 'portainer') return payload;
  if (payload.portainer.endpointId !== undefined && payload.portainer.endpointId !== null) return payload;
  /** @type {any} */
  const probe = { url: payload.portainer.url, insecureTls: !!payload.portainer.insecureTls };
  if (payload.portainer.apiKey) probe.apiKey = payload.portainer.apiKey;
  try {
    const res = await api.settings.endpoints(probe);
    const endpoints = (res && res.endpoints) || [];
    if (!endpoints.length) return payload;
    fillEndpointSelect(endpoints, endpoints[0].id ?? endpoints[0].Id);
  } catch {
    return payload; // the test call below will report the real error
  }
  return readBackendForm();
}

/** Test the CURRENT form values (never saves anything). */
async function testBackend() {
  const btn = byId('btn-backend-test');
  let payload = readBackendForm();
  if (payload.kind === 'portainer' && !payload.portainer.url) {
    renderTestResult('Enter the Portainer URL first.', 'warning');
    return;
  }
  if (btn) btn.disabled = true;
  renderTestResult('<span class="spinner-border spinner-border-sm me-2"></span>testing…', 'secondary');
  try {
    payload = await ensureEndpointSelected(payload);
    const res = await api.settings.testBackend(payload);
    const endpoints = (res && res.endpoints) || [];
    if (payload.kind === 'portainer' && endpoints.length) {
      fillEndpointSelect(endpoints, payload.portainer.endpointId ?? null);
    }
    if (res && res.ok) {
      renderTestResult(
        `<div class="fw-semibold mb-2">Connection OK${endpoints.length ? ` · ${endpoints.length} endpoint(s)` : ''}</div>${infoTable(res.info || {})}`,
        'success',
      );
      return;
    }
    const err = (res && res.error) || {};
    renderTestResult(`<strong>${escapeHtml(err.code || 'backend_error')}</strong>: ${escapeHtml(err.message || 'connection failed')}`, 'danger');
  } catch (err) {
    renderTestResult(escapeHtml((err && err.message) || 'connection failed'), 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveBackend(event) {
  if (event) event.preventDefault();
  const btn = byId('btn-backend-save');
  let payload = readBackendForm();
  if (payload.kind === 'portainer' && !payload.portainer.url) {
    renderTestResult('Enter the Portainer URL first.', 'warning');
    return;
  }
  if (btn) btn.disabled = true;
  try {
    payload = await ensureEndpointSelected(payload);
    if (payload.kind === 'portainer' && payload.portainer.endpointId === undefined) {
      renderTestResult('Pick a Portainer endpoint (use "Test connection" to load the list).', 'warning');
      return;
    }
    await api.settings.putBackend(payload);
    const keyInput = byId('portainer-api-key');
    if (keyInput) keyInput.value = '';
    toast('Docker backend saved', { variant: 'success' });
    await reload();
  } catch (err) {
    toastError(err, 'Could not save the backend');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function refreshEndpoints() {
  try {
    const payload = {};
    const url = String((byId('portainer-url') || {}).value || '').trim();
    const apiKey = String((byId('portainer-api-key') || {}).value || '');
    if (url) payload.url = url;
    if (apiKey) payload.apiKey = apiKey;
    const insecure = byId('portainer-insecure');
    if (insecure) payload.insecureTls = !!insecure.checked;
    const res = await api.settings.endpoints(payload);
    fillEndpointSelect((res && res.endpoints) || [], settings && settings.backend ? settings.backend.portainer.endpointId : null);
  } catch {
    /* the endpoint list is a convenience; the user can still type/test */
  }
}

/** Paint the backend panel from the last loaded settings (the key field stays empty). */
function renderBackend() {
  if (!settings) return;
  const backend = settings.backend || {};
  const kind = backend.kind === 'portainer' ? 'portainer' : 'socket';
  const socketRadio = byId('backend-kind-socket');
  const portainerRadio = byId('backend-kind-portainer');
  if (socketRadio) socketRadio.checked = kind === 'socket';
  if (portainerRadio) portainerRadio.checked = kind === 'portainer';

  const socketPath = byId('socket-path');
  if (socketPath) socketPath.value = (backend.socket && backend.socket.socketPath) || '/var/run/docker.sock';

  const hint = byId('socket-available-hint');
  if (hint) {
    hint.textContent = backend.socketAvailable ? 'local docker socket detected' : 'no local docker socket detected';
    hint.className = `small ms-2 ${backend.socketAvailable ? 'text-success' : 'text-secondary'}`;
  }

  const p = backend.portainer || {};
  const url = byId('portainer-url');
  if (url) url.value = p.url || '';
  const key = byId('portainer-api-key');
  if (key) key.value = '';
  const keyHint = byId('portainer-key-hint');
  if (keyHint) keyHint.textContent = p.apiKeySet ? `stored ${p.apiKeyHint || '…'}` : '(not set)';
  const insecure = byId('portainer-insecure');
  if (insecure) insecure.checked = !!p.insecureTls;
  fillEndpointSelect([], p.endpointId ?? null);
  // a stored Portainer backend can list its endpoints without a fresh key
  if (kind === 'portainer' && p.url && p.apiKeySet) void refreshEndpoints();

  syncBackendFields();
}

// ---------------------------------------------------------------------------
// general panel
// ---------------------------------------------------------------------------

/** Build #general-form inputs for every GeneralConfig key. */
function renderGeneral() {
  const form = byId('general-form');
  if (!form || !settings) return;
  const general = settings.general || {};
  form.innerHTML =
    GENERAL_FIELDS.map((field) => {
      const value = general[field.key];
      return (
        '<div class="col-md-6">' +
        `<label class="form-label" for="gen-${field.key}">${escapeHtml(field.label)}</label>` +
        `<input class="form-control" id="gen-${field.key}" data-general-key="${field.key}" value="${escapeHtml(value === null || value === undefined ? '' : String(value))}"` +
        `${field.nullable ? ' placeholder="(none)"' : ''}>` +
        (field.help ? `<div class="form-text">${escapeHtml(field.help)}</div>` : '') +
        '</div>'
      );
    }).join('') +
    '<div class="col-12 d-flex gap-2">' +
    '<button class="btn btn-primary" type="submit" id="btn-general-save"><i class="bi bi-save me-1"></i>Save</button>' +
    '<button class="btn btn-outline-secondary" type="button" id="btn-general-reset">Reset</button>' +
    '</div>';

  const reset = byId('btn-general-reset');
  if (reset) reset.addEventListener('click', () => renderGeneral());
}

function readGeneralForm() {
  /** @type {any} */
  const out = {};
  for (const field of GENERAL_FIELDS) {
    const el = byId(`gen-${field.key}`);
    if (!el) continue;
    const value = String(el.value || '').trim();
    out[field.key] = value === '' && field.nullable ? null : value;
  }
  return out;
}

async function saveGeneral(event) {
  if (event) event.preventDefault();
  const btn = byId('btn-general-save');
  if (btn) btn.disabled = true;
  try {
    await api.settings.putGeneral(readGeneralForm());
    toast('General settings saved', { variant: 'success' });
    await reload();
  } catch (err) {
    toastError(err, 'Could not save the general settings');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// account panel
// ---------------------------------------------------------------------------

/** Sync the account panel with the loaded settings (app.js owns the theme change handler). */
function renderAccount() {
  if (!settings) return;
  const theme = byId('theme-select');
  if (theme && settings.ui && settings.ui.theme) theme.value = settings.ui.theme;
}

/** Inline error under #password-form; pass null to clear it. */
function setPasswordError(message) {
  const el = byId('password-error');
  if (!el) return;
  if (!message) {
    el.textContent = '';
    el.classList.add('d-none');
    return;
  }
  el.className = 'col-12 alert alert-danger py-2 mb-0';
  el.textContent = message;
}

async function changePassword(event) {
  if (event) event.preventDefault();
  const currentEl = byId('current-password');
  const newEl = byId('new-password');
  const current = currentEl ? currentEl.value : '';
  const next = newEl ? newEl.value : '';
  setPasswordError(null);
  if (!current || !next) {
    setPasswordError('Fill both password fields');
    return;
  }
  if (next.length < 8) {
    setPasswordError('The new password must be at least 8 characters');
    return;
  }
  try {
    await api.settings.changePassword(current, next);
    if (currentEl) currentEl.value = '';
    if (newEl) newEl.value = '';
    setPasswordError(null);
    toast('Password changed - other sessions were signed out', { variant: 'success' });
  } catch (err) {
    const unauthorized = !!err && (err.status === 401 || err.code === 'unauthorized');
    if (!unauthorized) {
      setPasswordError((err && err.message) || 'Could not change the password');
      return;
    }
    // 401 here means the typed *current password* was wrong - the session cookie is
    // untouched (api.md), so api.js keeps this path out of the AUTH_REQUIRED flow and we
    // report inline. Only if the cookie really did expire do we hand over to the re-login.
    let stillSignedIn = true;
    try {
      const sess = await api.auth.session();
      stillSignedIn = !!(sess && sess.authenticated);
    } catch {
      stillSignedIn = true; // network hiccup: assume the session is fine, stay put
    }
    if (!stillSignedIn) {
      setPasswordError('Your session expired - sign in again');
      bus.emit(EVENTS.AUTH_REQUIRED, {});
      return;
    }
    setPasswordError('The current password is incorrect');
    if (currentEl) {
      currentEl.value = '';
      currentEl.focus();
    }
  }
}

// ---------------------------------------------------------------------------
// sub-tabs
// ---------------------------------------------------------------------------

/** Sub-tab switcher for #settings-subtabs / .pc-subview. */
function showSubtab(name) {
  currentSubtab = name;
  document.querySelectorAll('#settings-subtabs [data-subtab]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-subtab') === name);
  });
  document.querySelectorAll('.pc-subview[data-subtab]').forEach((pane) => {
    pane.classList.toggle('d-none', pane.getAttribute('data-subtab') !== name);
  });
  if (name === 'images') imagesPanel.show();
  else imagesPanel.hide();
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

/** GET /api/settings -> store + render + emit SETTINGS_CHANGED. */
export async function reload() {
  const res = await api.settings.get();
  settings = res;
  renderBackend();
  renderGeneral();
  renderAccount();
  bus.emit(EVENTS.SETTINGS_CHANGED, { settings });
  return settings;
}

/** @type {import('./app.js').ViewModule} */
const settingsView = {
  async init(ctx) {
    if (initialised) return;
    initialised = true;

    document.querySelectorAll('#settings-subtabs [data-subtab]').forEach((btn) => {
      btn.addEventListener('click', () => showSubtab(btn.getAttribute('data-subtab')));
    });

    for (const id of ['backend-kind-socket', 'backend-kind-portainer']) {
      const el = byId(id);
      if (el) el.addEventListener('change', syncBackendFields);
    }
    const test = byId('btn-backend-test');
    if (test) test.addEventListener('click', () => { void testBackend(); });
    const backendForm = byId('backend-form');
    if (backendForm) backendForm.addEventListener('submit', (e) => { void saveBackend(e); });
    const urlInput = byId('portainer-url');
    if (urlInput) {
      urlInput.addEventListener('blur', () => {
        if (backendKind() === 'portainer' && urlInput.value) void refreshEndpoints();
      });
    }

    const generalForm = byId('general-form');
    if (generalForm) generalForm.addEventListener('submit', (e) => { void saveGeneral(e); });

    const passwordForm = byId('password-form');
    if (passwordForm) passwordForm.addEventListener('submit', (e) => { void changePassword(e); });

    try {
      await imagesPanel.init(ctx);
    } catch (err) {
      console.error('[settings] images panel init failed', err);
    }

    showSubtab(currentSubtab);
    try {
      await reload();
    } catch (err) {
      if (!err || err.status !== 401) console.error('[settings] initial load failed', err);
    }
  },
  show() {
    reload().catch((err) => {
      if (err && err.status !== 401) toastError(err, 'Could not load the settings');
    });
    if (currentSubtab === 'images') setTimeout(() => imagesPanel.show(), 0);
  },
  hide() {
    imagesPanel.hide();
  },
  refresh() {
    void reload().catch(() => {});
  },
};

export default settingsView;
