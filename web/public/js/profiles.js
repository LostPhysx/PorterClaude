// OWNER: F1 (v0.4, new - issues #2/#3). Settings -> Profiles panel plus the PROFILE CACHE
// every other module reads.
//
// A profile is a named per-container configuration set: per agent it picks the LOGIN SET the
// container mounts (the shared auth volume carrying the login, the history and the installed
// plugins) and overlays env, write-only secret env, a free-form settings.json object,
// marketplaces and plugins. The headline feature is the login set: the FIRST container of a
// set runs `/login` once, every later container using that set is already logged in.
//
// CROSS-PACKAGE CONTRACT:
//   * getProfiles() returns the last known SanitizedProfile[] (never null; [] before the
//     first load) - containers.js uses it for the row badge and the dialog's picker.
//   * loadProfiles() does GET /api/profiles, refreshes the cache and repaints the panel.
//   * profileOptionsHtml(selected) builds the <option> list of the container dialog.
//
// SECRETS ARE WRITE-ONLY (the Portainer-credential convention, hosts.js readCredentialForm):
// the API never returns a value, only `{ set, hint }`. The form therefore SENDS a secret key
// only when the user typed a new value, OMITS it to keep the stored one and sends `null` to
// clear it.
import { api } from './api.js';
import { byId, toast, toastError, confirmDialog, escapeHtml, fmtDate } from './util.js';

/** The agent a profile always has a section for; other ids appear when the profile has them. */
export const DEFAULT_PROFILE_AGENT = 'claude';

/** Human labels of the agents the profile form knows about (agents.js owns the registry). */
const AGENT_LABELS = Object.freeze({ claude: 'Claude Code' });

/** The secret env keys a profile always gets a field for, stored or not. */
const PINNED_SECRET_KEYS = Object.freeze({ claude: ['ANTHROPIC_API_KEY'] });

/** profile ids and login set names are slugs (server/src/profiles/model.ts). */
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const LOGIN_SET_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Settings keys the server composes itself - a profile overlay setting them is a 422. */
export const SERVER_OWNED_SETTINGS_KEYS = Object.freeze([
  'env', 'enabledPlugins', 'extraKnownMarketplaces',
]);

/** @type {any[]} SanitizedProfile[] from GET /api/profiles */
let profiles = [];
/** @type {any|null} the profile open in #profile-modal (null = create) */
let editing = null;
/** @type {any|null} the profile open in #profile-verify-modal (#4) */
let verifying = null;
let initialised = false;

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

/** @returns {any[]} the last known SanitizedProfile[] (never null) */
export function getProfiles() {
  return profiles;
}

/** @param {string} id @returns {any|null} */
export function getProfile(id) {
  if (!id) return null;
  return profiles.find((p) => p && p.id === id) || null;
}

/** Human label of a profile id; falls back to the raw id. */
export function profileLabel(id) {
  const profile = getProfile(id);
  return (profile && profile.name) || String(id || '');
}

/** "Claude Code" for a known agent id, the raw id otherwise. */
function agentLabelFor(agentId) {
  return AGENT_LABELS[String(agentId || '')] || String(agentId || '');
}

/**
 * The <option> list of the container dialog's profile picker. The empty option is the v0.3
 * behaviour: no profile = the host-wide shared login volume.
 * @param {string|null} [selected]
 * @returns {string}
 */
export function profileOptionsHtml(selected = null) {
  const want = String(selected || '');
  const options = profiles
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}"${p.id === want ? ' selected' : ''}>` +
        `${escapeHtml(p.name || p.id)} (${escapeHtml(p.id)})</option>`,
    )
    .join('');
  const none = `<option value=""${want ? '' : ' selected'}>None &mdash; shared login volume</option>`;
  // a profile deleted while the dialog was open stays visible instead of silently
  // retargeting the container to "None"
  const unknown = want && !getProfile(want)
    ? `<option value="${escapeHtml(want)}" selected>${escapeHtml(want)} (deleted)</option>`
    : '';
  return none + unknown + options;
}

/**
 * GET /api/profiles -> cache + repaint. A 401 is left to the login flow; any other failure
 * empties the cache and renders the reason into the panel.
 * @returns {Promise<any[]>}
 */
export async function loadProfiles() {
  const list = byId('profiles-list');
  try {
    const res = await api.profiles.list();
    profiles = Array.isArray(res && res.profiles) ? res.profiles : [];
  } catch (err) {
    profiles = [];
    if (list && (!err || err.status !== 401)) {
      list.innerHTML =
        '<div class="col-12 small text-secondary">Could not load the profiles: ' +
        `${escapeHtml((err && err.message) || 'unknown error')}</div>`;
    }
    return profiles;
  }
  renderProfiles();
  return profiles;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/** "host-wide login" / "shared set team" / "private login set" for one agent config. */
export function loginSetLabel(cfg) {
  const set = cfg ? cfg.loginSet : null;
  if (set === 'default') return 'host-wide login';
  if (!set) return 'private login set';
  return `shared set ${set}`;
}

/** One line per agent the profile configures. */
function agentSummaryHtml(profile) {
  const entries = Object.entries((profile && profile.agents) || {});
  if (!entries.length) {
    return '<div class="small text-secondary mt-1">no agent configured - containers of this profile keep the host defaults</div>';
  }
  return entries
    .map(([agentId, cfg]) => {
      const bits = [];
      const envCount = Object.keys((cfg && cfg.env) || {}).length;
      const secretCount = Object.values((cfg && cfg.envSecrets) || {}).filter((s) => s && s.set).length;
      const settingsCount = Object.keys((cfg && cfg.settings) || {}).length;
      const pluginCount = Array.isArray(cfg && cfg.plugins) ? cfg.plugins.length : 0;
      if (envCount) bits.push(`${envCount} env`);
      if (secretCount) bits.push(`${secretCount} secret${secretCount === 1 ? '' : 's'}`);
      if (settingsCount) bits.push(`${settingsCount} setting${settingsCount === 1 ? '' : 's'}`);
      if (pluginCount) bits.push(`${pluginCount} plugin${pluginCount === 1 ? '' : 's'}`);
      return (
        '<div class="small mt-1">' +
        `<span class="fw-semibold">${escapeHtml(agentLabelFor(agentId))}</span> ` +
        '<span class="badge text-bg-secondary pc-agent-chip">' +
        `<i class="bi bi-key me-1"></i>${escapeHtml(loginSetLabel(cfg))}</span>` +
        (bits.length ? `<span class="text-secondary">${escapeHtml(bits.join(' · '))}</span>` : '') +
        '</div>'
      );
    })
    .join('');
}

/** The containers currently pinned to this profile (SanitizedProfile.inUse). */
function inUseHtml(profile) {
  const inUse = Array.isArray(profile && profile.inUse) ? profile.inUse : [];
  if (!inUse.length) return '<span class="badge text-bg-secondary">unused</span>';
  return (
    `<span class="badge text-bg-info" title="${escapeHtml(inUse.join(', '))}">` +
    `in use by ${inUse.length} container${inUse.length === 1 ? '' : 's'}</span> ` +
    inUse
      .map((name) => `<span class="badge text-bg-secondary pc-agent-chip">${escapeHtml(name)}</span>`)
      .join('')
  );
}

function profileCard(profile) {
  const id = String(profile.id);
  const action = (attr, icon, label, variant = 'outline-secondary') =>
    `<button type="button" class="btn btn-sm btn-${variant}" ${attr}="${escapeHtml(id)}">` +
    `<i class="bi ${icon} me-1"></i>${label}</button>`;
  return (
    // the card wrapper carries data-profile-id (DOM contract, like the agent cards)
    `<div class="col-12 col-lg-6"><div class="card pc-agent-card h-100" data-profile-id="${escapeHtml(id)}"><div class="card-body">` +
    '<div class="d-flex align-items-start gap-2 mb-1">' +
    '<i class="bi bi-person-badge"></i>' +
    `<h6 class="card-title mb-0 me-auto">${escapeHtml(profile.name || id)}` +
    ` <span class="text-secondary font-monospace small">${escapeHtml(id)}</span></h6>` +
    '</div>' +
    (profile.description ? `<div class="small text-secondary">${escapeHtml(profile.description)}</div>` : '') +
    agentSummaryHtml(profile) +
    `<div class="mt-2">${inUseHtml(profile)}</div>` +
    `<div class="small text-secondary mt-1">updated ${escapeHtml(fmtDate(profile.updatedAt))}</div>` +
    '<div class="d-flex flex-wrap gap-1 mt-2">' +
    action('data-profile-edit', 'bi-pencil', 'Edit') +
    action('data-profile-verify', 'bi-clipboard-check', 'Verify') +
    action('data-profile-delete', 'bi-trash', 'Delete', 'outline-danger') +
    '</div></div></div></div>'
  );
}

/** Repaint #profiles-list from the cache. */
export function renderProfiles() {
  const list = byId('profiles-list');
  if (!list) return;
  list.innerHTML = profiles.length
    ? [...profiles]
        .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)))
        .map(profileCard)
        .join('')
    : '<div class="col-12 small text-secondary">No profile yet. A container without a profile ' +
      'shares the host-wide login volume, exactly like before.</div>';
}

// ---------------------------------------------------------------------------
// create/edit modal
// ---------------------------------------------------------------------------

/** The agent ids the form renders a section for: always `claude`, plus whatever is stored. */
function formAgentIds(profile) {
  const ids = [DEFAULT_PROFILE_AGENT];
  for (const id of Object.keys((profile && profile.agents) || {})) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 'default' | 'shared' | 'private' from a stored loginSet value. */
function loginModeOf(loginSet) {
  if (loginSet === 'default') return 'default';
  return loginSet ? 'shared' : 'private';
}

function envRow(key = '', value = '') {
  return (
    '<div class="row g-2 mb-2 pc-kv-row" data-row="env">' +
    `<div class="col-5"><input class="form-control form-control-sm" data-field="key" placeholder="ANTHROPIC_BASE_URL" value="${escapeHtml(key)}"></div>` +
    `<div class="col-6"><input class="form-control form-control-sm" data-field="value" placeholder="value" value="${escapeHtml(value)}"></div>` +
    '<div class="col-1 d-grid"><button type="button" class="btn btn-sm btn-outline-danger" data-remove-row aria-label="Remove"><i class="bi bi-x"></i></button></div>' +
    '</div>'
  );
}

/**
 * One write-only secret row. A `pinned` row (ANTHROPIC_API_KEY) carries its key in
 * `data-key` and can be neither renamed nor removed; every other row has a key input.
 * @param {string} key
 * @param {{set?:boolean, hint?:string}|null} stored the SanitizedSecretEnv of that key
 * @param {boolean} [pinned]
 */
function secretRow(key = '', stored = null, pinned = false) {
  const isSet = !!(stored && stored.set);
  // never prefilled: the value is write-only (hosts.js openCredentialModal shows the same
  // "(stored ...xxxx)" hint next to the label instead)
  const hint = isSet
    ? `<span class="small text-secondary ms-1">(stored ...${escapeHtml(stored.hint || '')})</span>`
    : '';
  const placeholder = isSet ? 'leave blank to keep the stored value' : 'not set';
  const keyCell = pinned
    ? `<div class="col-5 d-flex align-items-center"><code class="small">${escapeHtml(key)}</code>${hint}</div>`
    : `<div class="col-5"><input class="form-control form-control-sm" data-field="key" placeholder="MY_API_KEY" value="${escapeHtml(key)}">${hint}</div>`;
  const removeCell = pinned
    ? '<div class="col-1"></div>'
    : '<div class="col-1 d-grid"><button type="button" class="btn btn-sm btn-outline-danger" data-remove-row aria-label="Remove"><i class="bi bi-x"></i></button></div>';
  return (
    '<div class="row g-2 mb-2 pc-kv-row" data-row="secret"' +
    ` data-stored="${isSet ? '1' : '0'}"${pinned ? ` data-key="${escapeHtml(key)}"` : ''}>` +
    keyCell +
    `<div class="col-6"><input type="password" autocomplete="off" class="form-control form-control-sm" data-field="value" placeholder="${escapeHtml(placeholder)}"></div>` +
    removeCell +
    '</div>'
  );
}

function marketplaceRow(market = {}) {
  return (
    '<div class="row g-2 mb-2 pc-kv-row" data-row="marketplace">' +
    `<div class="col-5"><input class="form-control form-control-sm" data-field="name" placeholder="name" value="${escapeHtml(market.name || '')}"></div>` +
    `<div class="col-6"><input class="form-control form-control-sm" data-field="source" placeholder="owner/repo or a git URL" value="${escapeHtml(market.source || '')}"></div>` +
    '<div class="col-1 d-grid"><button type="button" class="btn btn-sm btn-outline-danger" data-remove-row aria-label="Remove"><i class="bi bi-x"></i></button></div>' +
    '</div>'
  );
}

function pluginRow(plugin = {}) {
  return (
    '<div class="row g-2 mb-2 pc-kv-row" data-row="plugin">' +
    `<div class="col-11"><input class="form-control form-control-sm" data-field="ref" placeholder="my-plugin@my-marketplace" value="${escapeHtml(plugin.ref || '')}"></div>` +
    '<div class="col-1 d-grid"><button type="button" class="btn btn-sm btn-outline-danger" data-remove-row aria-label="Remove"><i class="bi bi-x"></i></button></div>' +
    '</div>'
  );
}

/** The login-set control of one agent: the three modes plus the name of a shared set. */
function loginSetFieldHtml(agentId, cfg) {
  const a = escapeHtml(agentId);
  const mode = loginModeOf(cfg ? cfg.loginSet : null);
  const name = mode === 'shared' ? String((cfg && cfg.loginSet) || '') : '';
  const option = (value, label) =>
    `<option value="${value}"${mode === value ? ' selected' : ''}>${label}</option>`;
  return (
    '<div class="col-md-6">' +
    `<label class="form-label" for="pf-${a}-login-mode">Login set</label>` +
    `<select class="form-select form-select-sm" id="pf-${a}-login-mode" data-login-mode="${a}">` +
    option('default', 'Host-wide login (the volume every container shared before)') +
    option('shared', 'Named shared set') +
    option('private', 'Private to this profile') +
    '</select>' +
    '<div class="form-text">' +
    'The login set is the volume carrying the agent login, its history and its installed ' +
    'plugins. The <strong>first</strong> container of a new set runs <code>/login</code> once; ' +
    'every later container with the same set is already logged in.' +
    '</div></div>' +
    `<div class="col-md-6${mode === 'shared' ? '' : ' d-none'}" id="pf-${a}-login-name-wrap">` +
    `<label class="form-label" for="pf-${a}-login-name">Shared set name</label>` +
    `<input class="form-control form-control-sm" id="pf-${a}-login-name" placeholder="team" value="${escapeHtml(name)}">` +
    '<div class="form-text">lowercase letters, digits and dashes. Every profile naming the ' +
    'same set shares one login.</div>' +
    '</div>'
  );
}

/** The whole per-agent section: login set, env, secrets, settings, marketplaces, plugins. */
function agentSectionHtml(agentId, cfg) {
  const a = escapeHtml(agentId);
  const config = cfg || {};
  const envRows = Object.entries(config.env || {}).map(([k, v]) => envRow(k, v)).join('');
  const storedSecrets = config.envSecrets || {};
  const pinned = PINNED_SECRET_KEYS[agentId] || [];
  const secretRows =
    pinned.map((key) => secretRow(key, storedSecrets[key] || null, true)).join('') +
    Object.keys(storedSecrets)
      .filter((key) => !pinned.includes(key))
      .map((key) => secretRow(key, storedSecrets[key], false))
      .join('');
  const settings = config.settings && typeof config.settings === 'object' ? config.settings : {};
  const marketRows = (config.marketplaces || []).map((m) => marketplaceRow(m)).join('');
  const pluginRows = (config.plugins || []).map((p) => pluginRow(p)).join('');

  return (
    `<div class="col-12" data-agent-section="${a}">` +
    '<hr class="my-1">' +
    `<h6 class="mt-2"><i class="bi bi-stars me-1"></i>${escapeHtml(agentLabelFor(agentId))} ` +
    `<span class="text-secondary font-monospace small">${a}</span></h6>` +
    '<div class="row g-3">' +

    loginSetFieldHtml(agentId, config) +

    '<div class="col-12"><label class="form-label d-block">Environment</label>' +
    `<div id="pf-${a}-env-rows">${envRows}</div>` +
    `<button type="button" class="btn btn-sm btn-outline-secondary" data-add-env="${a}"><i class="bi bi-plus-lg me-1"></i>Add variable</button>` +
    '<div class="form-text">Plain values merged into the agent’s managed settings ' +
    '(<code>ANTHROPIC_BASE_URL</code>, model slugs, …). Keys and tokens belong below.</div></div>' +

    '<div class="col-12"><label class="form-label d-block">Secret environment</label>' +
    `<div id="pf-${a}-secret-rows">${secretRows}</div>` +
    `<button type="button" class="btn btn-sm btn-outline-secondary" data-add-secret="${a}"><i class="bi bi-plus-lg me-1"></i>Add secret</button>` +
    '<div class="form-text">Write-only: a stored value is never sent back, only its last four ' +
    'characters. Leave a field blank to keep what is stored, remove the row to clear it. ' +
    'An Anthropic login stays interactive &mdash; a key is only needed for another provider.</div></div>' +

    `<div class="col-12"><label class="form-label" for="pf-${a}-settings">settings.json overlay</label>` +
    `<textarea class="form-control font-monospace" id="pf-${a}-settings" rows="8" spellcheck="false">${escapeHtml(JSON.stringify(settings, null, 2))}</textarea>` +
    '<div class="form-text">A JSON object merged verbatim into the agent settings. ' +
    SERVER_OWNED_SETTINGS_KEYS.map((k) => `<code>${escapeHtml(k)}</code>`).join(', ') +
    ' are composed by the server and are rejected here (422).</div></div>' +

    '<div class="col-12"><label class="form-label d-block">Plugin marketplaces</label>' +
    `<div id="pf-${a}-marketplace-rows">${marketRows}</div>` +
    `<button type="button" class="btn btn-sm btn-outline-secondary" data-add-marketplace="${a}"><i class="bi bi-plus-lg me-1"></i>Add marketplace</button>` +
    '<div class="form-text">A name plus its source (<code>owner/repo</code> or a git URL); ' +
    'plugin refs resolve against these.</div></div>' +

    '<div class="col-12"><label class="form-label d-block">Plugins</label>' +
    `<div id="pf-${a}-plugin-rows">${pluginRows}</div>` +
    `<button type="button" class="btn btn-sm btn-outline-secondary" data-add-plugin="${a}"><i class="bi bi-plus-lg me-1"></i>Add plugin</button>` +
    '<div class="form-text">One ref per row: <code>name</code> or <code>name@marketplace</code>. ' +
    'Plugins are installed into the login set volume.</div></div>' +

    '</div></div>'
  );
}

function profileFormHtml(profile) {
  const isEdit = !!profile;
  const p = profile || {};
  return (
    '<div class="row g-3">' +
    `<div class="col-md-6"><label class="form-label" for="pf-name">Name</label>
       <input class="form-control" id="pf-name" value="${escapeHtml(p.name || '')}" placeholder="Team login"></div>` +
    `<div class="col-md-6"><label class="form-label" for="pf-id">Id</label>
       <input class="form-control" id="pf-id" value="${escapeHtml(p.id || '')}" ${isEdit ? 'readonly' : ''} placeholder="team" pattern="[a-z0-9][a-z0-9-]{0,31}">
       <div class="form-text">lowercase letters, digits and dashes${isEdit ? ' - immutable' : ' (blank = derived from the name)'}</div></div>` +
    `<div class="col-12"><label class="form-label" for="pf-description">Description</label>
       <input class="form-control" id="pf-description" value="${escapeHtml(p.description || '')}" placeholder="optional"></div>` +
    formAgentIds(profile)
      .map((agentId) => agentSectionHtml(agentId, (p.agents || {})[agentId] || null))
      .join('') +
    (isEdit
      ? '<div class="col-12"><div class="alert alert-warning py-2 small mb-0">Containers using this ' +
        'profile pick the change up when they are recreated - the Containers tab flags them as ' +
        '"config changed".</div></div>'
      : '') +
    '</div>'
  );
}

/** Inline error under the form (never a toast: a parse error is a form error). */
function setFormError(message) {
  const el = byId('profile-form-error');
  if (!el) return;
  el.textContent = message || '';
  el.style.whiteSpace = 'pre-line';
}

/** Slug derived from the typed name, used when the id field is left blank on create. */
export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/**
 * Serialise one agent section into a ProfileInput agent config. Throws on client-side
 * validation; the message lands in #profile-form-error.
 * @param {string} agentId
 * @returns {any}
 */
function readAgentSection(agentId) {
  const label = agentLabelFor(agentId);
  const modeEl = byId(`pf-${agentId}-login-mode`);
  const mode = modeEl ? String(modeEl.value || 'default') : 'default';
  /** @type {string|null} */
  let loginSet = null;
  if (mode === 'default') {
    loginSet = 'default';
  } else if (mode === 'shared') {
    const nameEl = byId(`pf-${agentId}-login-name`);
    const name = nameEl ? String(nameEl.value || '').trim() : '';
    if (!name) throw new Error(`${label}: name the shared login set, or pick another mode.`);
    if (!LOGIN_SET_RE.test(name)) {
      throw new Error(`${label}: the login set name must be lowercase letters, digits and dashes (max 32 chars).`);
    }
    loginSet = name;
  }

  /** @type {Record<string,string>} */
  const env = {};
  document.querySelectorAll(`#pf-${agentId}-env-rows [data-row="env"]`).forEach((row) => {
    const key = String(row.querySelector('[data-field="key"]').value || '').trim();
    const value = String(row.querySelector('[data-field="value"]').value || '');
    if (key) env[key] = value;
  });

  // WRITE-ONLY (hosts.js readCredentialForm): a typed value SETS the secret, a blank field on
  // a stored key OMITS it (keep), and a stored key whose row was removed is sent as null.
  /** @type {Record<string,string|null>} */
  const envSecrets = {};
  const seen = new Set();
  document.querySelectorAll(`#pf-${agentId}-secret-rows [data-row="secret"]`).forEach((row) => {
    const keyInput = row.querySelector('[data-field="key"]');
    const key = String(row.getAttribute('data-key') || (keyInput ? keyInput.value : '') || '').trim();
    if (!key) return;
    seen.add(key);
    const typed = String(row.querySelector('[data-field="value"]').value || '');
    if (typed) envSecrets[key] = typed;
  });
  const stored = (editing && editing.agents && editing.agents[agentId] && editing.agents[agentId].envSecrets) || {};
  for (const [key, secret] of Object.entries(stored)) {
    if (secret && secret.set && !seen.has(key)) envSecrets[key] = null;
  }

  const textarea = byId(`pf-${agentId}-settings`);
  const raw = textarea ? String(textarea.value || '').trim() : '';
  /** @type {any} */
  let settings = {};
  if (raw) {
    try {
      settings = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${label}: the settings overlay is not valid JSON - ${(err && err.message) || 'parse error'}`);
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(`${label}: the settings overlay must be a JSON object.`);
    }
    for (const key of SERVER_OWNED_SETTINGS_KEYS) {
      if (key in settings) {
        throw new Error(`${label}: "${key}" is composed by the server and cannot be set in the overlay.`);
      }
    }
  }

  /** @type {any[]} */
  const marketplaces = [];
  document.querySelectorAll(`#pf-${agentId}-marketplace-rows [data-row="marketplace"]`).forEach((row) => {
    const name = String(row.querySelector('[data-field="name"]').value || '').trim();
    const source = String(row.querySelector('[data-field="source"]').value || '').trim();
    if (!name && !source) return;
    if (!name || !source) throw new Error(`${label}: a marketplace needs both a name and a source.`);
    marketplaces.push({ name, source });
  });

  /** @type {any[]} */
  const plugins = [];
  document.querySelectorAll(`#pf-${agentId}-plugin-rows [data-row="plugin"]`).forEach((row) => {
    const ref = String(row.querySelector('[data-field="ref"]').value || '').trim();
    if (ref) plugins.push({ ref });
  });

  return { loginSet, env, envSecrets, settings, marketplaces, plugins };
}

/** Serialise #profile-form into a ProfileInput; throws on client-side validation. */
export function readProfileForm() {
  const value = (id) => {
    const el = byId(id);
    return el ? String(el.value || '').trim() : '';
  };
  const name = value('pf-name');
  if (!name) {
    const el = byId('pf-name');
    if (el) el.classList.add('is-invalid');
    throw new Error('Give the profile a name.');
  }
  /** @type {any} */
  const input = { name, description: value('pf-description') || null, agents: {} };
  // the id is immutable, so it is sent on CREATE only
  if (!editing) {
    const id = value('pf-id') || slugify(name);
    if (!PROFILE_ID_RE.test(id)) {
      const el = byId('pf-id');
      if (el) el.classList.add('is-invalid');
      throw new Error('The id must be lowercase letters, digits and dashes (max 32 chars).');
    }
    input.id = id;
  }
  const body = byId('profile-form-body');
  const ids = body
    ? Array.from(body.querySelectorAll('[data-agent-section]')).map((el) => el.getAttribute('data-agent-section'))
    : [DEFAULT_PROFILE_AGENT];
  for (const agentId of ids) input.agents[agentId] = readAgentSection(agentId);
  return input;
}

/** Delegated handlers of the generated form body (add/remove rows, login-set mode). */
function wireProfileForm() {
  const body = byId('profile-form-body');
  if (!body) return;
  const appendTo = (containerId, html) => {
    const box = byId(containerId);
    if (box) box.insertAdjacentHTML('beforeend', html);
  };
  body.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-row]');
    if (remove) {
      const row = remove.closest('.pc-kv-row');
      if (row) row.remove();
      return;
    }
    const env = event.target.closest('[data-add-env]');
    if (env) {
      appendTo(`pf-${env.getAttribute('data-add-env')}-env-rows`, envRow());
      return;
    }
    const secret = event.target.closest('[data-add-secret]');
    if (secret) {
      appendTo(`pf-${secret.getAttribute('data-add-secret')}-secret-rows`, secretRow('', null, false));
      return;
    }
    const market = event.target.closest('[data-add-marketplace]');
    if (market) {
      appendTo(`pf-${market.getAttribute('data-add-marketplace')}-marketplace-rows`, marketplaceRow());
      return;
    }
    const plugin = event.target.closest('[data-add-plugin]');
    if (plugin) {
      appendTo(`pf-${plugin.getAttribute('data-add-plugin')}-plugin-rows`, pluginRow());
    }
  });
  body.addEventListener('change', (event) => {
    const select = event.target.closest('[data-login-mode]');
    if (!select) return;
    const wrap = byId(`pf-${select.getAttribute('data-login-mode')}-login-name-wrap`);
    if (wrap) wrap.classList.toggle('d-none', select.value !== 'shared');
  });
}

/**
 * Build #profile-form-body and show #profile-modal.
 * @param {any|null} profile SanitizedProfile for edit, null for create
 */
export function openProfileModal(profile = null) {
  editing = profile;
  const body = byId('profile-form-body');
  const title = byId('profile-modal-title');
  const modalEl = byId('profile-modal');
  if (!body || !modalEl || typeof bootstrap === 'undefined') return;
  if (title) title.textContent = profile ? `Edit ${profile.name || profile.id}` : 'New profile';
  setFormError('');
  body.innerHTML = profileFormHtml(profile);
  wireProfileForm();
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

/**
 * POST /api/profiles (create) or PUT /api/profiles/:id (edit) -> close, reload, toast.
 * A 422 renders the zod issues as "<path>: <message>" lines (agents.js saveAgent does the
 * same); a 409 explains the id clash.
 * @param {Event} [event]
 * @returns {Promise<void>}
 */
export async function saveProfile(event) {
  if (event) event.preventDefault();
  const btn = byId('btn-profile-save');
  setFormError('');
  const body = byId('profile-form-body');
  if (body) body.querySelectorAll('.is-invalid').forEach((el) => el.classList.remove('is-invalid'));
  /** @type {any} */
  let input;
  try {
    input = readProfileForm();
  } catch (err) {
    setFormError((err && err.message) || 'Invalid form');
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const wasCreate = !editing;
    if (editing) await api.profiles.update(editing.id, input);
    else await api.profiles.create(input);
    editing = null;
    const modalEl = byId('profile-modal');
    if (modalEl && typeof bootstrap !== 'undefined') bootstrap.Modal.getOrCreateInstance(modalEl).hide();
    await loadProfiles();
    toast(`Profile ${input.name} ${wasCreate ? 'created' : 'updated'}`, { variant: 'success' });
  } catch (err) {
    if (err && err.code === 'validation_error') {
      const issues = Array.isArray(err.details) ? err.details : [];
      setFormError(
        issues.length
          ? issues
              .map((issue) => {
                const path = Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path || '');
                return `${path || 'profile'}: ${issue.message || 'invalid'}`;
              })
              .join('\n')
          : err.message || 'the profile was rejected',
      );
    } else if (err && err.status === 409) {
      setFormError(`That id is taken: ${(err && err.message) || 'pick another id'}`);
    } else {
      setFormError((err && err.message) || 'Could not save the profile');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** The container names of a 409 delete envelope (`error.details.containers`). */
function conflictContainers(err) {
  const details = (err && err.details) || null;
  const names = details && Array.isArray(details.containers) ? details.containers : [];
  return names.map((n) => String(n));
}

/**
 * confirmDialog -> DELETE /api/profiles/:id. A 409 means containers still use it: name them,
 * then offer the retry with `?force=1`, which strips the profile from those containers.
 * @param {any} profile SanitizedProfile
 * @returns {Promise<void>}
 */
export async function deleteProfile(profile) {
  if (!profile) return;
  const ok = await confirmDialog({
    title: `Delete ${profile.name || profile.id}?`,
    body:
      `The profile <code>${escapeHtml(profile.id)}</code> and its stored secrets are removed. ` +
      'Login volumes are kept - a named set may still belong to another profile.',
    confirmLabel: 'Delete profile',
  });
  if (!ok) return;
  try {
    await api.profiles.remove(profile.id);
    toast(`Profile ${profile.name || profile.id} deleted`, { variant: 'success' });
    await loadProfiles();
    return;
  } catch (err) {
    if (!err || err.status !== 409) {
      toastError(err, 'Could not delete the profile');
      return;
    }
    const names = conflictContainers(err);
    const list = names.length
      ? `<ul class="mb-2">${names.map((n) => `<li><code>${escapeHtml(n)}</code></li>`).join('')}</ul>`
      : `<p class="mb-2">${escapeHtml((err && err.message) || 'some containers still use it')}</p>`;
    const forced = await confirmDialog({
      title: 'Remove it from those containers too?',
      body:
        'These containers still use this profile:' + list +
        'Deleting it anyway clears their profile: they fall back to the host-wide login volume ' +
        'the next time they are recreated.',
      confirmLabel: 'Delete anyway',
    });
    if (!forced) return;
    try {
      await api.profiles.remove(profile.id, { force: true });
      toast(`Profile ${profile.name || profile.id} deleted`, { variant: 'success' });
      await loadProfiles();
    } catch (inner) {
      toastError(inner, 'Could not delete the profile');
    }
  }
}

// ---------------------------------------------------------------------------
// verify probe (#4)
// ---------------------------------------------------------------------------
//
// POST /api/profiles/:id/verify { container } runs the agent CLI INSIDE a running container
// and answers a report. The point of the feature is the RAW probe transcript at the bottom
// of the dialog: the CLI drifts, and a human has to be able to read what it actually said.
// Every value below is arbitrary CLI text, so nothing here reaches the DOM unescaped.

/** A tri-state capability chip: green true, red false, grey "the server did not say". */
function flagChip(label, value) {
  const known = typeof value === 'boolean';
  const variant = !known ? 'text-bg-secondary' : value ? 'text-bg-success' : 'text-bg-danger';
  const icon = !known ? 'bi-question-lg' : value ? 'bi-check-lg' : 'bi-x-lg';
  return (
    `<span class="badge ${variant} pc-agent-chip">` +
    `<i class="bi ${icon} me-1"></i>${escapeHtml(label)}</span>`
  );
}

/** One label/value line of the report header. */
function reportRow(label, value) {
  const text = value === undefined || value === null || value === '' ? '—' : String(value);
  return (
    '<div class="row g-2 pc-kv-row small">' +
    `<div class="col-4 text-secondary">${escapeHtml(label)}</div>` +
    `<div class="col-8 font-monospace text-break">${escapeHtml(text)}</div>` +
    '</div>'
  );
}

/** A chip per string; `highlight` renders them as failures (the missing plugins). */
function chipsHtml(values, highlight = false) {
  const list = Array.isArray(values) ? values.filter((v) => v !== undefined && v !== null) : [];
  if (!list.length) return '<span class="small text-secondary">none</span>';
  const variant = highlight ? 'text-bg-danger' : 'text-bg-secondary';
  return list
    .map((v) => `<span class="badge ${variant} pc-agent-chip">${escapeHtml(String(v))}</span>`)
    .join('');
}

/** One titled block of the report. */
function reportSection(title, body) {
  return `<div class="mt-3"><div class="fw-semibold small">${escapeHtml(title)}</div>${body}</div>`;
}

/** The collapsed transcript of every probe the server ran - monospace, whitespace kept. */
function probesHtml(report) {
  const probes = Array.isArray(report && report.probes) ? report.probes : [];
  if (!probes.length) return '';
  const body = probes
    .map((probe) => {
      const p = probe || {};
      const hasCode = typeof p.exitCode === 'number';
      const variant = hasCode && p.exitCode === 0 ? 'text-bg-success' : 'text-bg-danger';
      const code = hasCode ? String(p.exitCode) : '?';
      const output = p.output === undefined || p.output === null ? '' : String(p.output);
      return (
        '<div class="mb-2">' +
        `<div class="small"><span class="badge ${variant} pc-agent-chip">exit ${escapeHtml(code)}</span>` +
        `<code>${escapeHtml(String(p.cmd || ''))}</code></div>` +
        `<pre class="pc-logs small mb-0">${escapeHtml(output)}</pre>` +
        '</div>'
      );
    })
    .join('');
  return (
    '<details class="mt-3"><summary class="small">' +
    `Raw probe output (${probes.length} command${probes.length === 1 ? '' : 's'})</summary>` +
    `<div class="mt-2">${body}</div></details>`
  );
}

/**
 * Render one verify report. Every field is treated as possibly missing: a report with
 * `cli.available:false` is a legitimate FAIL, not a crash.
 * @param {any} report
 * @returns {string}
 */
export function verifyReportHtml(report) {
  const r = report || {};
  const cli = r.cli || {};
  const plugin = r.pluginCommand || {};
  const managed = r.managedSettings || {};
  const marker = r.marker || {};
  const warnings = Array.isArray(r.warnings) ? r.warnings : [];
  const missing = Array.isArray(r.missingPlugins) ? r.missingPlugins : [];
  const ok = r.ok === true;

  const headline =
    `<div class="alert ${ok ? 'alert-success' : 'alert-danger'} py-2 mb-0">` +
    `<i class="bi ${ok ? 'bi-check-circle' : 'bi-exclamation-triangle'} me-1"></i>` +
    `<span class="fw-semibold">${ok ? 'Profile verified' : 'Verification failed'}</span>` +
    (warnings.length
      ? ` <span class="small">${warnings.length} warning${warnings.length === 1 ? '' : 's'}</span>`
      : '') +
    '</div>';

  const header =
    '<div class="mt-3">' +
    reportRow('Profile', r.profileId) +
    reportRow('Container', r.container) +
    reportRow('Agent', r.agentId) +
    reportRow('Login set', r.loginSet) +
    reportRow('Login volume', r.loginVolume) +
    reportRow('Checked at', r.checkedAt ? fmtDate(r.checkedAt) : null) +
    '</div>';

  const cliSection = reportSection(
    'CLI',
    '<div class="mt-1">' +
      flagChip('available', cli.available) +
      `<span class="small">version <code>${escapeHtml(String(cli.version || 'unknown'))}</code></span>` +
      '</div>',
  );

  const pluginSection = reportSection(
    'claude plugin',
    '<div class="mt-1">' +
      flagChip('available', plugin.available) +
      flagChip('--yes flag', plugin.supportsYesFlag) +
      flagChip('list works', plugin.listWorks) +
      flagChip('json list', plugin.supportsJsonList) +
      '</div>' +
      '<div class="small text-secondary mt-1">reported by <code>plugin list</code></div>' +
      `<div>${chipsHtml(plugin.installed)}</div>`,
  );

  // KEY NAMES ONLY - the server never sends the values and the UI never asks for them.
  const managedSection = reportSection(
    'Managed settings',
    '<div class="mt-1">' +
      flagChip('present', managed.present) +
      flagChip('valid JSON', managed.valid) +
      '</div>' +
      `<div class="mt-1">${chipsHtml(managed.keys)}</div>` +
      '<div class="form-text">key names only &mdash; a value is never read back.</div>',
  );

  const pluginsSection = reportSection(
    'Plugins',
    '<div class="small text-secondary mt-1">wanted by the profile</div>' +
      `<div>${chipsHtml(r.desiredPlugins)}</div>` +
      '<div class="small text-secondary mt-2">installed in the login set</div>' +
      `<div>${chipsHtml(marker.installed)}</div>` +
      (missing.length
        ? `<div class="small text-danger mt-2">missing</div><div>${chipsHtml(missing, true)}</div>`
        : '') +
      `<div class="mt-2">${flagChip('install marker', marker.present)}</div>`,
  );

  const warningsSection = warnings.length
    ? reportSection(
      'Warnings',
      '<ul class="small mb-0 mt-1">' +
        warnings.map((w) => `<li>${escapeHtml(String(w))}</li>`).join('') +
        '</ul>',
    )
    : '';

  return (
    headline + header + cliSection + pluginSection + managedSection + pluginsSection +
    warningsSection + probesHtml(report)
  );
}

/** Paint the result area of the verify dialog. */
function setVerifyResult(html) {
  const el = byId('profile-verify-result');
  if (el) el.innerHTML = html || '';
}

/**
 * A failed probe stays INSIDE the dialog (a raw toast dump of a CLI transcript is
 * unreadable). 404/409/422 get their own sentence; anything else falls back to the envelope
 * message, exactly like setFormError does for the edit form.
 * @param {any} err ApiError
 * @param {string} container
 */
function setVerifyError(err, container) {
  const name = escapeHtml(String(container || ''));
  const message = escapeHtml((err && err.message) || 'the probe failed');
  let text;
  if (err && err.status === 409) {
    text =
      `The probe needs a <strong>running</strong> container with the agent mounted: ` +
      `<code>${name}</code> cannot be probed right now.` +
      `<div class="small mt-1">${message}</div>`;
  } else if (err && err.status === 404) {
    text =
      `Nothing to probe: the profile or the container <code>${name}</code> is gone.` +
      `<div class="small mt-1">${message}</div>`;
  } else if (err && err.status === 422) {
    text = `The request was rejected.<div class="small mt-1">${message}</div>`;
  } else {
    text = `Could not run the probe.<div class="small mt-1">${message}</div>`;
  }
  setVerifyResult(`<div class="alert alert-warning py-2 mb-0">${text}</div>`);
}

/**
 * Fill the container picker of the verify dialog. The probe only makes sense in a RUNNING
 * container (the server answers 409 otherwise), so a stopped one is not offered at all -
 * with a sentence saying so instead of an empty select.
 *
 * containers.js already imports THIS module (getProfiles/profileOptionsHtml), so its cache
 * is unreachable from here without an import cycle: the flat list endpoint is the same data.
 * @param {any} profile
 * @returns {Promise<void>}
 */
async function loadVerifyContainers(profile) {
  const select = byId('pf-verify-container');
  const note = byId('profile-verify-note');
  const run = byId('btn-profile-verify-run');
  if (!select) return;
  select.disabled = true;
  if (run) run.disabled = true;
  select.innerHTML = '<option value="">loading…</option>';
  if (note) note.textContent = '';
  /** @type {any[]} */
  let list = [];
  try {
    const res = await api.containers.list();
    list = Array.isArray(res && res.containers) ? res.containers : [];
  } catch (err) {
    select.innerHTML = '<option value="">unavailable</option>';
    if (note) {
      note.textContent = `Could not list the containers: ${(err && err.message) || 'unknown error'}`;
    }
    return;
  }
  const running = list.filter((c) => c && c.status === 'running');
  if (!running.length) {
    select.innerHTML = '<option value="">no running container</option>';
    if (note) {
      note.textContent = list.length
        ? 'The probe runs the agent CLI inside a container, so one has to be running. Start a container using this profile first.'
        : 'There is no container yet - create one with this profile and start it.';
    }
    return;
  }
  // the profile's own containers first: that is what "verify this profile" means
  const inUse = Array.isArray(profile && profile.inUse) ? profile.inUse.map(String) : [];
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
  const mine = running.filter((c) => inUse.includes(String(c.name))).sort(byName);
  const others = running.filter((c) => !inUse.includes(String(c.name))).sort(byName);
  select.innerHTML = mine
    .concat(others)
    .map((c) => {
      const name = String(c.name || '');
      const label = inUse.includes(name) ? `${name} — uses this profile` : name;
      return `<option value="${escapeHtml(name)}">${escapeHtml(label)}</option>`;
    })
    .join('');
  select.disabled = false;
  if (run) run.disabled = false;
  if (note) {
    note.textContent = mine.length
      ? ''
      : 'No running container uses this profile - probing another one still shows what its agent CLI supports.';
  }
}

/**
 * POST /api/profiles/:id/verify -> render the report (or the error) into the dialog.
 * @returns {Promise<void>}
 */
export async function runVerify() {
  if (!verifying) return;
  const select = byId('pf-verify-container');
  const run = byId('btn-profile-verify-run');
  const container = select ? String(select.value || '') : '';
  if (!container) {
    setVerifyResult('<div class="alert alert-warning py-2 mb-0">Pick a running container to probe.</div>');
    return;
  }
  if (run) run.disabled = true;
  setVerifyResult(
    '<div class="d-flex align-items-center gap-2 small text-secondary">' +
      '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>' +
      `Probing ${escapeHtml(container)}…</div>`,
  );
  try {
    const res = await api.profiles.verify(verifying.id, container);
    setVerifyResult(verifyReportHtml(res && res.report ? res.report : null));
  } catch (err) {
    setVerifyError(err, container);
  } finally {
    if (run) run.disabled = false;
  }
}

/**
 * Show #profile-verify-modal for one profile: container picker, empty result area.
 * @param {any} profile SanitizedProfile
 */
export function openVerifyModal(profile) {
  const modalEl = byId('profile-verify-modal');
  if (!profile || !modalEl || typeof bootstrap === 'undefined') return;
  verifying = profile;
  const title = byId('profile-verify-modal-title');
  if (title) title.textContent = `Verify ${profile.name || profile.id}`;
  setVerifyResult(
    '<div class="small text-secondary">Pick a running container and run the probe: it reports the ' +
      'agent CLI version, what <code>claude plugin</code> supports, the managed settings written ' +
      'into the container and which plugins are actually installed.</div>',
  );
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
  void loadVerifyContainers(profile);
}

function onProfilesListClick(event) {
  const editBtn = event.target.closest('[data-profile-edit]');
  if (editBtn) {
    const profile = getProfile(editBtn.getAttribute('data-profile-edit'));
    if (profile) openProfileModal(profile);
    return;
  }
  const verifyBtn = event.target.closest('[data-profile-verify]');
  if (verifyBtn) {
    const profile = getProfile(verifyBtn.getAttribute('data-profile-verify'));
    if (profile) openVerifyModal(profile);
    return;
  }
  const deleteBtn = event.target.closest('[data-profile-delete]');
  if (deleteBtn) {
    const profile = getProfile(deleteBtn.getAttribute('data-profile-delete'));
    if (profile) void deleteProfile(profile);
  }
}

const profilesPanel = {
  /** @param {any} ctx AppContext */
  async init(ctx) {
    void ctx;
    if (initialised) return;
    initialised = true;

    const newBtn = byId('btn-profile-new');
    if (newBtn) newBtn.addEventListener('click', () => openProfileModal(null));
    const refresh = byId('btn-profiles-refresh');
    if (refresh) refresh.addEventListener('click', () => { void loadProfiles(); });
    const list = byId('profiles-list');
    if (list) list.addEventListener('click', onProfilesListClick);
    const form = byId('profile-form');
    if (form) form.addEventListener('submit', (e) => { void saveProfile(e); });
    const modalEl = byId('profile-modal');
    if (modalEl) modalEl.addEventListener('hidden.bs.modal', () => { editing = null; });
    const verifyRun = byId('btn-profile-verify-run');
    if (verifyRun) verifyRun.addEventListener('click', () => { void runVerify(); });
    const verifyEl = byId('profile-verify-modal');
    if (verifyEl) {
      verifyEl.addEventListener('hidden.bs.modal', () => { verifying = null; setVerifyResult(''); });
    }

    renderProfiles();
  },
  /** Panel entry: refresh the list - a container CRUD elsewhere changes `inUse`. */
  show() {
    void loadProfiles().catch(() => {});
  },
  hide() {},
};

export default profilesPanel;
