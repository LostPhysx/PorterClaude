// OWNER: F1. Settings tab shell: sub-tab switching plus the two panels that live in this
// file (General, Account). The other three panels are separate modules with the same
// lifecycle contract: hosts.js (Hosts + Portainer credentials), agents.js (Coding agents),
// images.js (recipe images, jobs, tools volume).
//
// v0.2: the "Docker backend" panel is GONE. `PUT /api/settings/backend`,
// `POST /api/settings/backend/test` and `POST /api/settings/backend/endpoints` do not exist
// any more - connections are hosts (`/api/hosts`) and credentials
// (`/api/credentials/portainer`). `GET /api/settings` no longer has a `backend` section; it
// carries `hosts: { count, defaultHostId, socketAvailable, socketHostId }` instead.
//
// CROSS-PACKAGE CONTRACT (FROZEN):
//   * after every successful GET/PUT of settings, emit
//     bus.emit(EVENTS.SETTINGS_CHANGED, { settings }) with the full SanitizedSettings object
//   * getSettings() returns the last known SanitizedSettings (or null) - F2 reads
//     `settings.ui.layout` from it on first paint.
import { api } from './api.js';
import { bus, EVENTS } from './bus.js';
import { byId, toast, toastError, escapeHtml } from './util.js';
import imagesPanel from './images.js';
import hostsPanel from './hosts.js';
import agentsPanel from './agents.js';

/** @type {any|null} */
let settings = null;
let initialised = false;
/** Sub-tab shown first. v0.2: hosts (a fresh install has to add one before anything works). */
let currentSubtab = 'hosts';

/** The sub-tabs of the Settings view, in display order. FROZEN (index.html data-subtab). */
export const SUBTABS = ['hosts', 'agents', 'general', 'images', 'account'];

/** FROZEN: F2 reads ui.layout / ui.theme from here. @returns {any|null} SanitizedSettings */
export function getSettings() {
  return settings;
}

/**
 * GeneralConfig keys in display order (mirrors server/src/config/fields.ts
 * GENERAL_FIELD_SCHEMAS). Exported because hosts.js renders the SAME list as the per-host
 * "overrides" form - a host may override any general field. FROZEN key list: adding a field
 * here without a server-side schema entry produces a 422.
 */
export const GENERAL_FIELDS = [
  { key: 'workspacesRoot', label: 'Workspaces root', help: 'host directory used for bind workspaces' },
  { key: 'volumePrefix', label: 'Volume prefix', help: 'every volume PorterClaude creates starts with this (porterclaude-ws-<session>, porterclaude-auth-<agent>, ...)' },
  { key: 'toolsVolume', label: 'Tools volume', help: 'read-only volume holding the coding agents; mounted into every session' },
  { key: 'defaultRecipe', label: 'Default recipe' },
  { key: 'containerPrefix', label: 'Container prefix', help: 'containers are named <prefix><session>' },
  { key: 'sessionNetwork', label: 'Session network', help: 'blank = the default bridge network', nullable: true },
  { key: 'imageNamespace', label: 'Image namespace', help: 'recipe images are tagged <namespace>/<recipe>:latest' },
  { key: 'containerHome', label: 'Container home' },
  { key: 'workspaceMount', label: 'Workspace mount' },
  { key: 'toolsMount', label: 'Tools mount' },
  { key: 'sharedClaudeVolume', label: 'Legacy .claude volume', help: 'v0.1 only: the tools sync imports it once into porterclaude-auth-claude', legacy: true },
  { key: 'sharedClaudeHomeVolume', label: 'Legacy .claude-home volume', help: 'v0.1 only: imported together with the volume above', legacy: true },
];

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
        `<label class="form-label" for="gen-${field.key}">${escapeHtml(field.label)}` +
        (field.legacy ? ' <span class="badge text-bg-secondary">legacy</span>' : '') +
        '</label>' +
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

/** The panel module behind each sub-tab (all implement { init, show, hide }). */
const PANELS = { hosts: hostsPanel, agents: agentsPanel, images: imagesPanel };

/**
 * Sub-tab switcher for #settings-subtabs / .pc-subview. Exactly one panel is "shown" at a
 * time: the others get hide() so their polls/job tails stop.
 * @param {'hosts'|'agents'|'general'|'images'|'account'} name
 */
export function showSubtab(name) {
  currentSubtab = SUBTABS.includes(name) ? name : 'hosts';
  document.querySelectorAll('#settings-subtabs [data-subtab]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-subtab') === currentSubtab);
  });
  document.querySelectorAll('.pc-subview[data-subtab]').forEach((pane) => {
    pane.classList.toggle('d-none', pane.getAttribute('data-subtab') !== currentSubtab);
  });
  for (const [key, panel] of Object.entries(PANELS)) {
    if (key === currentSubtab) panel.show();
    else panel.hide();
  }
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

/** GET /api/settings -> store + render + emit SETTINGS_CHANGED. */
export async function reload() {
  const res = await api.settings.get();
  settings = res;
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

    const generalForm = byId('general-form');
    if (generalForm) generalForm.addEventListener('submit', (e) => { void saveGeneral(e); });

    const passwordForm = byId('password-form');
    if (passwordForm) passwordForm.addEventListener('submit', (e) => { void changePassword(e); });

    for (const [key, panel] of Object.entries(PANELS)) {
      try {
        await panel.init(ctx);
      } catch (err) {
        console.error(`[settings] ${key} panel init failed`, err);
      }
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
    // re-run the panel lifecycle so the visible one refreshes on every entry
    setTimeout(() => showSubtab(currentSubtab), 0);
  },
  hide() {
    for (const panel of Object.values(PANELS)) panel.hide();
  },
  refresh() {
    void reload().catch(() => {});
  },
};

export default settingsView;
