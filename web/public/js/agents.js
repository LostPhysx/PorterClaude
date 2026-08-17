// OWNER: F1 (v0.2, new). Two jobs in one module:
//   1. the AGENT REGISTRY CACHE - the only place that knows what an agent id means. The
//      getters below are a CROSS-PACKAGE CONTRACT (FROZEN): F2 imports `agentLabel`,
//      `agentIcon` and `getAgents` for the Code tab's new-session menu and tab titles.
//   2. the Settings -> Agents panel (built-ins + custom definitions, per-host enable,
//      install state). Not a top-level view; settings.js drives its lifecycle, exactly like
//      images.js.
//
// CROSS-PACKAGE CONTRACT (FROZEN):
//   * loadAgents() must emit bus.emit(EVENTS.AGENTS_CHANGED, { agents }) after every
//     successful GET /api/agents (app.js calls it once during startApp(), before the views
//     are initialised, so F2 has labels on its first paint).
//   * getAgents() returns the last known AgentView[] (never null; [] before the first load).
//   * agentLabel(id) NEVER throws and NEVER returns '' - an unknown id renders as the id.
import { api } from './api.js';
import { bus, EVENTS } from './bus.js';
import { byId, toast, toastError, confirmDialog, escapeHtml, fmtDate, storage, LS_PREFIX } from './util.js';
import { openJob } from './images.js';
import { getHost, getHosts, hostLabel, hostOptionsHtml, resolveHostId } from './hosts.js';

/** localStorage key remembering which host the Agents panel is pointed at. */
export const LS_AGENTS_HOST = `${LS_PREFIX}agents.host`;

/**
 * Bootstrap-icon class per built-in agent id, used by the Settings cards AND by F2's
 * new-session menu. FROZEN: add ids here, never rename the export.
 */
export const AGENT_ICONS = Object.freeze({
  claude: 'bi-stars',
  opencode: 'bi-braces',
  gemini: 'bi-gem',
  codex: 'bi-code-square',
  aider: 'bi-robot',
});

/** Icon for an agent without an entry in AGENT_ICONS (custom agents). */
export const AGENT_ICON_FALLBACK = 'bi-robot';

/** @type {any[]} AgentView[] from GET /api/agents */
let agents = [];
/** @type {any[]} HostAgentView[] of the host the panel currently shows */
let hostAgents = [];
/** @type {string} host id the panel is pointed at ('' until hosts are known) */
let panelHostId = '';
/** @type {any|null} the agent open in #agent-modal (null = create) */
let editing = null;
let initialised = false;

/** tools-sync job watcher: refreshes the cards once the sync finishes */
const syncWatch = { hostId: '', jobId: null, cursor: 0, timer: null };
/** poll cadence of the tools-sync watcher (the job log itself lives in #job-modal) */
const SYNC_POLL_MS = 2000;

// ---------------------------------------------------------------------------
// registry cache (FROZEN accessors - implemented by the planner, do not change)
// ---------------------------------------------------------------------------

/** FROZEN. @returns {any[]} the last known AgentView[] (never null) */
export function getAgents() {
  return agents;
}

/**
 * The HostAgentView[] of the host the Agents panel currently shows (panel-local state;
 * containers.js fetches its own list for the host picked in the container dialog).
 * @returns {any[]}
 */
export function getHostAgents() {
  return hostAgents;
}

/** FROZEN. @param {string} id @returns {any|null} */
export function getAgent(id) {
  if (!id) return null;
  return agents.find((a) => a && a.id === id) || null;
}

/** FROZEN. Human label of an agent id ("Claude Code"); falls back to the raw id. */
export function agentLabel(id) {
  const agent = getAgent(id);
  return (agent && agent.name) || String(id || '');
}

/** FROZEN. Bootstrap-icon class for an agent id. */
export function agentIcon(id) {
  return AGENT_ICONS[String(id || '')] || AGENT_ICON_FALLBACK;
}

/**
 * FROZEN. GET /api/agents -> cache + AGENTS_CHANGED. Never rejects for a 401 (the login
 * flow owns that); any other failure keeps the previous cache and rethrows.
 * @returns {Promise<any[]>}
 */
export async function loadAgents() {
  const res = await api.agents.list();
  agents = Array.isArray(res && res.agents) ? res.agents : [];
  bus.emit(EVENTS.AGENTS_CHANGED, { agents });
  return agents;
}

// ---------------------------------------------------------------------------
// Settings -> Agents panel (F1)
// ---------------------------------------------------------------------------

/** The host the panel is pointed at (defaults to the default host). @returns {string} */
export function currentHostId() {
  return panelHostId;
}

/**
 * Fill #agents-host-select from the host cache, preselect the remembered host (or the
 * default one) and describe the per-host model in #agents-host-note.
 * @param {any[]} [hosts] HostView[] (defaults to the host cache)
 */
export function renderHostSelect(hosts) {
  const list = Array.isArray(hosts) ? hosts : getHosts();
  const select = byId('agents-host-select');
  const note = byId('agents-host-note');
  if (!select) return;
  if (!list.length) {
    panelHostId = '';
    select.innerHTML = '<option value="">no host</option>';
    select.disabled = true;
    if (note) note.textContent = 'No Docker host yet - add one under Settings > Hosts.';
    return;
  }
  select.disabled = false;
  const remembered = panelHostId || storage.get(LS_AGENTS_HOST, '') || '';
  panelHostId = resolveHostId(remembered);
  select.innerHTML = hostOptionsHtml(panelHostId);
  select.value = panelHostId;
  storage.set(LS_AGENTS_HOST, panelHostId);
  if (note) {
    // an unreachable engine answers with installed:false everywhere - say why, or the cards
    // read as "nothing installed yet" (FE-QA-07)
    const host = getHost(panelHostId);
    const unreachable = host && host.status === 'unreachable'
      ? `${hostLabel(panelHostId)} is unreachable${host.error ? ` (${host.error})` : ''} - the install `
        + 'state below could not be read. '
      : '';
    note.textContent =
      unreachable +
      `Agents are installed into the tools volume of ${hostLabel(panelHostId)}. ` +
      'Nothing is synced between hosts: every host installs and logs in on its own.';
    note.classList.toggle('text-danger', !!unreachable);
    note.classList.toggle('text-secondary', !unreachable);
  }
}

/** "npm @google/gemini-cli" / "pip aider-chat" / "script" / "binary" */
function installLabel(install) {
  if (!install || !install.kind) return 'unknown';
  switch (install.kind) {
    case 'npm':
      return `npm ${install.package || ''}${install.version ? `@${install.version}` : ''}`.trim();
    case 'pip':
      return `pip ${install.package || ''}${install.version ? `==${install.version}` : ''}`.trim();
    case 'script':
      return `script ${install.url || ''}`.trim();
    case 'binary':
      return 'binary download';
    default:
      return String(install.kind);
  }
}

function installBadge(state) {
  if (state && state.error) {
    return `<span class="badge text-bg-danger" title="${escapeHtml(state.error)}">install failed</span>`;
  }
  if (state && state.installed) {
    return `<span class="badge text-bg-success">installed ${escapeHtml(state.version || '?')}</span>`;
  }
  return '<span class="badge text-bg-secondary">not installed</span>';
}

/** One card per agent: the definition plus this host's state. */
function agentCard(agent, state) {
  const id = String(agent.id);
  const enabled = !!(state && state.enabled);
  const shared = Array.isArray(agent.sharedPaths) ? agent.sharedPaths : [];
  const sharedHtml = shared.length
    ? `<div class="small text-secondary mt-1">shares ${shared
        .map((p) => `<code>${escapeHtml(p.path)}</code>`)
        .join(' ')}</div>`
    : '';
  const installedAt = state && state.installedAt
    ? `<span class="small text-secondary ms-1">${escapeHtml(fmtDate(state.installedAt))}</span>`
    : '';
  const error = state && state.error
    ? `<div class="small text-danger mt-1">${escapeHtml(state.error)}</div>`
    : '';
  const homepage = agent.homepage
    ? `<a class="small" href="${escapeHtml(agent.homepage)}" target="_blank" rel="noreferrer noopener">homepage</a>`
    : '';
  const login = agent.loginHint
    ? `<div class="small text-secondary mt-1"><i class="bi bi-key me-1"></i>${escapeHtml(agent.loginHint)}</div>`
    : '';
  const custom = agent.builtin === false;
  const buttons = custom
    ? '<div class="btn-group btn-group-sm ms-auto">' +
      `<button type="button" class="btn btn-outline-secondary" data-agent-edit="${escapeHtml(id)}" title="Edit definition"><i class="bi bi-pencil"></i></button>` +
      `<button type="button" class="btn btn-outline-danger" data-agent-delete="${escapeHtml(id)}" title="Delete agent"><i class="bi bi-trash"></i></button>` +
      '</div>'
    : '';

  return (
    // the card wrapper carries data-agent-id (DOM contract, frontend.md section 12.4)
    `<div class="col-12 col-lg-6"><div class="card pc-agent-card h-100" data-agent-id="${escapeHtml(id)}"><div class="card-body">` +
    '<div class="d-flex align-items-start gap-2 mb-1">' +
    `<i class="bi ${escapeHtml(agentIcon(id))}"></i>` +
    `<h6 class="card-title mb-0 me-auto">${escapeHtml(agent.name || id)}` +
    ` <span class="text-secondary font-monospace small">${escapeHtml(id)}</span>` +
    (agent.builtin ? ' <span class="badge text-bg-secondary">built-in</span>' : ' <span class="badge text-bg-info">custom</span>') +
    '</h6>' +
    '<div class="form-check form-switch mb-0">' +
    `<input class="form-check-input" type="checkbox" role="switch" data-agent-toggle="${escapeHtml(id)}"` +
    ` id="agent-toggle-${escapeHtml(id)}"${enabled ? ' checked' : ''}>` +
    `<label class="form-check-label small" for="agent-toggle-${escapeHtml(id)}">enabled</label>` +
    '</div></div>' +
    (agent.description ? `<div class="small text-secondary">${escapeHtml(agent.description)}</div>` : '') +
    `<div class="small text-secondary mt-1">install: <code>${escapeHtml(installLabel(agent.install))}</code></div>` +
    sharedHtml +
    login +
    `<div class="mt-2 d-flex align-items-center gap-1">${installBadge(state)}${installedAt}${homepage}${buttons}</div>` +
    error +
    '</div></div></div>'
  );
}

/** Built-ins first, then custom; every registry agent merged with its per-host state. */
function renderAgentCards() {
  const list = byId('agents-list');
  if (!list) return;
  const stateById = new Map();
  for (const state of hostAgents) if (state && state.id) stateById.set(state.id, state);
  const registry = agents.length ? agents : hostAgents;
  const merged = [...registry];
  for (const state of hostAgents) {
    if (!merged.some((a) => a && a.id === state.id)) merged.push(state);
  }
  merged.sort((a, b) => {
    const ab = a.builtin === false ? 1 : 0;
    const bb = b.builtin === false ? 1 : 0;
    if (ab !== bb) return ab - bb;
    return String(a.name || a.id).localeCompare(String(b.name || b.id));
  });
  if (!merged.length) {
    list.innerHTML = '<div class="col-12 small text-secondary">No agent definitions.</div>';
    return;
  }
  list.innerHTML = merged.map((agent) => agentCard(agent, stateById.get(agent.id) || null)).join('');
}

/**
 * GET /api/hosts/:hostId/agents -> per-host state, then repaint the cards. An unreachable
 * host answers installed:false + an error per agent: that is rendered, never toasted.
 * @returns {Promise<void>}
 */
export async function reloadHostAgents() {
  const list = byId('agents-list');
  if (!panelHostId) {
    hostAgents = [];
    if (list) {
      list.innerHTML =
        '<div class="col-12"><div class="alert alert-warning py-2 small mb-0">' +
        'No Docker host yet - add one under Settings &rarr; Hosts, then come back to enable agents on it.' +
        '</div></div>';
    }
    return;
  }
  try {
    const res = await api.hosts.agents(panelHostId);
    hostAgents = Array.isArray(res && res.agents) ? res.agents : [];
  } catch (err) {
    hostAgents = [];
    if (list && (!err || err.status !== 401)) {
      const message = err && err.code === 'backend_not_configured'
        ? 'This host has no usable connection yet - fix it under Hosts.'
        : `Could not load the agents of this host: ${escapeHtml((err && err.message) || 'unknown error')}`;
      list.innerHTML = `<div class="col-12"><div class="alert alert-warning py-2 small mb-0">${message}</div></div>`;
    }
    return;
  }
  renderAgentCards();
}

/** The ids of every checked toggle in #agents-list. */
function checkedAgentIds() {
  /** @type {string[]} */
  const ids = [];
  document.querySelectorAll('#agents-list [data-agent-toggle]').forEach((el) => {
    if (el.checked) ids.push(el.getAttribute('data-agent-toggle'));
  });
  return ids;
}

/**
 * PUT /api/hosts/:hostId/agents { enabled } and tell the user what is still missing:
 * enabling installs nothing.
 * @param {string} agentId @param {boolean} enabled
 * @returns {Promise<void>}
 */
export async function setAgentEnabled(agentId, enabled) {
  if (!panelHostId) return;
  const wanted = checkedAgentIds();
  try {
    const res = await api.hosts.setAgents(panelHostId, wanted);
    hostAgents = Array.isArray(res && res.agents) ? res.agents : hostAgents;
    renderAgentCards();
    toast(
      enabled
        ? `Enabled on ${hostLabel(panelHostId)}. Run "Sync tools", then recreate the containers that should mount it.`
        : `Disabled on ${hostLabel(panelHostId)}. Containers keep the mount until they are recreated.`,
      { variant: enabled ? 'success' : 'info', title: agentLabel(agentId) },
    );
  } catch (err) {
    toastError(err, 'Could not change the agents of this host');
    // put the toggle back where the server says it is
    await reloadHostAgents();
  }
}

function stopSyncWatch() {
  if (syncWatch.timer) clearTimeout(syncWatch.timer);
  syncWatch.timer = null;
  syncWatch.jobId = null;
}

/** Poll the tools-sync job (the log itself is tailed by #job-modal) and refresh when done. */
async function pollSyncJob() {
  if (!syncWatch.jobId || !syncWatch.hostId) return;
  try {
    const res = await api.images.job(syncWatch.hostId, syncWatch.jobId, syncWatch.cursor);
    if (res && typeof res.nextIndex === 'number') syncWatch.cursor = res.nextIndex;
    const status = res && res.job ? res.job.status : null;
    if (status === 'running') {
      syncWatch.timer = setTimeout(() => { void pollSyncJob(); }, SYNC_POLL_MS);
      return;
    }
    stopSyncWatch();
    await reloadHostAgents();
  } catch {
    stopSyncWatch();
  }
}

function watchSyncJob(hostId, jobId) {
  stopSyncWatch();
  syncWatch.hostId = hostId;
  syncWatch.jobId = jobId;
  syncWatch.cursor = 0;
  syncWatch.timer = setTimeout(() => { void pollSyncJob(); }, SYNC_POLL_MS);
}

/**
 * POST /api/hosts/:hostId/images/tools/sync - installs every agent enabled on this host.
 * The job log opens in the shared #job-modal; a 409 opens the sync that is already running.
 *
 * `force` is the UPGRADE path: a plain sync carries an installed agent over unchanged (its
 * definition does not change when upstream ships a new version), `force: true` rebuilds the
 * tools image and reinstalls every agent and runtime from source. It is slow and downloads
 * a few hundred MB, so it is confirmed first.
 *
 * @param {boolean} [force] reinstall every agent instead of carrying installed ones over
 * @returns {Promise<void>}
 */
export async function syncAgents(force = false) {
  if (!panelHostId) {
    toast('Pick a host first.', { variant: 'warning' });
    return;
  }
  if (force) {
    const ok = await confirmDialog({
      title: 'Upgrade all agents?',
      body:
        `Every agent enabled on <strong>${escapeHtml(hostLabel(panelHostId))}</strong> is reinstalled from ` +
        'source, together with the bundled Node/Python runtimes, so they pick up the current ' +
        'upstream versions. This takes minutes and re-downloads a few hundred MB. Running ' +
        'containers keep their current agent until they are restarted.',
      confirmLabel: 'Upgrade',
      variant: 'primary',
    });
    if (!ok) return;
  }
  const btn = byId('btn-agents-sync');
  const more = byId('btn-agents-sync-more');
  if (btn) btn.disabled = true;
  if (more) more.disabled = true;
  try {
    const res = await api.images.syncTools(panelHostId, force);
    const job = (res && res.job) || null;
    if (job && job.id) {
      openJob(panelHostId, job.id);
      watchSyncJob(panelHostId, job.id);
    }
  } catch (err) {
    if (err && err.code === 'conflict') {
      try {
        const status = await api.images.tools(panelHostId);
        const jobId = status && status.status ? status.status.jobId : null;
        if (jobId) {
          openJob(panelHostId, jobId);
          watchSyncJob(panelHostId, jobId);
          return;
        }
      } catch {
        /* fall through to the toast */
      }
    }
    toastError(err, 'Could not install the agents on this host');
  } finally {
    if (btn) btn.disabled = false;
    if (more) more.disabled = false;
  }
}

/** Fill #af-preset with "(empty)" + every built-in definition. */
function renderPresetSelect() {
  const select = byId('af-preset');
  if (!select) return;
  select.innerHTML =
    '<option value="">(empty template)</option>' +
    agents
      .filter((a) => a && a.builtin)
      .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`)
      .join('');
  select.value = '';
}

/** A copy of a definition without the API-only `builtin` marker. */
function definitionOf(agent) {
  const copy = { ...(agent || {}) };
  delete copy.builtin;
  delete copy.enabled;
  delete copy.installed;
  delete copy.version;
  delete copy.installedAt;
  delete copy.error;
  delete copy.authVolume;
  return copy;
}

/**
 * Open #agent-modal. Create prefills #af-json with AGENT_TEMPLATE (or a built-in copied
 * through #af-preset); edit shows the stored definition and hides the preset picker.
 * @param {any|null} agent AgentView for edit, null for create
 */
export function openAgentModal(agent = null) {
  editing = agent;
  const title = byId('agent-modal-title');
  const json = byId('af-json');
  const presetWrap = byId('af-preset-wrap');
  if (title) title.textContent = agent ? `Edit ${agent.name}` : 'Custom agent';
  if (presetWrap) presetWrap.classList.toggle('d-none', !!agent);
  if (!agent) renderPresetSelect();
  if (json) json.value = JSON.stringify(agent ? definitionOf(agent) : AGENT_TEMPLATE, null, 2);
  const err = byId('agent-form-error');
  if (err) err.textContent = '';
  const modalEl = byId('agent-modal');
  if (modalEl && typeof bootstrap !== 'undefined') bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

/** #af-preset -> copy that built-in into the editor with a fresh id. */
function applyPreset() {
  const select = byId('af-preset');
  const json = byId('af-json');
  if (!select || !json) return;
  const base = getAgent(select.value);
  if (!base) {
    json.value = JSON.stringify(AGENT_TEMPLATE, null, 2);
    return;
  }
  const copy = definitionOf(base);
  copy.id = `my-${base.id}`;
  copy.name = `My ${base.name}`;
  json.value = JSON.stringify(copy, null, 2);
}

/** Inline error under the JSON editor (never a toast: a parse error is a form error). */
function setAgentFormError(message) {
  const el = byId('agent-form-error');
  if (!el) return;
  el.textContent = message || '';
  el.style.whiteSpace = 'pre-line';
}

/**
 * Parse #af-json, then POST /api/agents (create) or PUT /api/agents/:id (edit).
 * A 422 renders the zod issues as "<path>: <message>" lines; a 409 explains the id clash.
 * @param {Event} [event]
 * @returns {Promise<void>}
 */
export async function saveAgent(event) {
  if (event) event.preventDefault();
  const json = byId('af-json');
  const btn = byId('btn-agent-save');
  setAgentFormError('');
  if (!json) return;
  /** @type {any} */
  let definition;
  try {
    definition = JSON.parse(String(json.value || ''));
  } catch (err) {
    setAgentFormError(`That is not valid JSON: ${(err && err.message) || 'parse error'}`);
    return;
  }
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    setAgentFormError('The definition must be a JSON object.');
    return;
  }
  if (btn) btn.disabled = true;
  try {
    if (editing) await api.agents.update(editing.id, definition);
    else await api.agents.create(definition);
    const modalEl = byId('agent-modal');
    if (modalEl && typeof bootstrap !== 'undefined') bootstrap.Modal.getOrCreateInstance(modalEl).hide();
    toast(`Agent ${definition.name || definition.id} ${editing ? 'updated' : 'created'}`, { variant: 'success' });
    editing = null;
    await loadAgents().catch(() => {});
    await reloadHostAgents();
  } catch (err) {
    if (err && err.code === 'validation_error') {
      const issues = Array.isArray(err.details) ? err.details : [];
      setAgentFormError(
        issues.length
          ? issues
              .map((issue) => {
                const path = Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path || '');
                return `${path || 'definition'}: ${issue.message || 'invalid'}`;
              })
              .join('\n')
          : err.message || 'the definition was rejected',
      );
    } else if (err && err.status === 409) {
      setAgentFormError(`That id is taken by a built-in agent: ${(err && err.message) || 'pick another id'}`);
    } else {
      setAgentFormError((err && err.message) || 'Could not save the agent');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * confirmDialog -> DELETE /api/agents/:id. A 409 means a host enables it or a container pins
 * it: ask again, then retry with `?force=1`.
 * @param {any} agent AgentView
 * @returns {Promise<void>}
 */
export async function deleteAgent(agent) {
  if (!agent) return;
  const ok = await confirmDialog({
    title: `Delete the custom agent ${agent.name}?`,
    body: `The definition <code>${escapeHtml(agent.id)}</code> is removed. Auth volumes on the hosts are never deleted.`,
    confirmLabel: 'Delete agent',
  });
  if (!ok) return;
  try {
    await api.agents.remove(agent.id);
    toast(`Agent ${agent.name} deleted`, { variant: 'success' });
    await loadAgents().catch(() => {});
    await reloadHostAgents();
    return;
  } catch (err) {
    if (!err || err.status !== 409) {
      toastError(err, 'Could not delete the agent');
      return;
    }
  }
  const forced = await confirmDialog({
    title: 'Remove it everywhere?',
    body:
      'Remove it from those hosts and containers too? Their containers keep the mount until they ' +
      'are recreated.',
    confirmLabel: 'Remove everywhere',
  });
  if (!forced) return;
  try {
    await api.agents.remove(agent.id, { force: true });
    toast(`Agent ${agent.name} deleted`, { variant: 'success' });
    await loadAgents().catch(() => {});
    await reloadHostAgents();
  } catch (err) {
    toastError(err, 'Could not delete the agent');
  }
}

/** Starting point for a new custom agent (shown in #af-json). */
export const AGENT_TEMPLATE = Object.freeze({
  id: 'my-agent',
  name: 'My agent',
  description: '',
  command: 'my-agent',
  args: [],
  versionCommand: ['my-agent', '--version'],
  install: { kind: 'npm', package: 'my-agent-cli', version: 'latest' },
  sharedPaths: [{ path: '~/.my-agent', kind: 'dir' }],
  historyPath: null,
  env: {},
  loginHint: '',
});

function onAgentsListClick(event) {
  const editBtn = event.target.closest('[data-agent-edit]');
  if (editBtn) {
    const agent = getAgent(editBtn.getAttribute('data-agent-edit'))
      || hostAgents.find((a) => a && a.id === editBtn.getAttribute('data-agent-edit'));
    if (agent) openAgentModal(agent);
    return;
  }
  const deleteBtn = event.target.closest('[data-agent-delete]');
  if (deleteBtn) {
    const agent = getAgent(deleteBtn.getAttribute('data-agent-delete'))
      || hostAgents.find((a) => a && a.id === deleteBtn.getAttribute('data-agent-delete'));
    if (agent) void deleteAgent(agent);
  }
}

function onAgentsListChange(event) {
  const toggle = event.target.closest('[data-agent-toggle]');
  if (!toggle) return;
  void setAgentEnabled(toggle.getAttribute('data-agent-toggle'), !!toggle.checked);
}

const agentsPanel = {
  /** @param {any} ctx AppContext */
  async init(ctx) {
    void ctx;
    if (initialised) return;
    initialised = true;

    const select = byId('agents-host-select');
    if (select) {
      select.addEventListener('change', () => {
        panelHostId = select.value || '';
        storage.set(LS_AGENTS_HOST, panelHostId);
        renderHostSelect();
        void reloadHostAgents();
      });
    }
    const refresh = byId('btn-agents-refresh');
    if (refresh) refresh.addEventListener('click', () => { void reloadHostAgents(); });
    const sync = byId('btn-agents-sync');
    if (sync) sync.addEventListener('click', () => { void syncAgents(false); });
    const syncForce = byId('btn-agents-sync-force');
    if (syncForce) syncForce.addEventListener('click', () => { void syncAgents(true); });
    const newBtn = byId('btn-agent-new');
    if (newBtn) newBtn.addEventListener('click', () => openAgentModal(null));

    const list = byId('agents-list');
    if (list) {
      list.addEventListener('click', onAgentsListClick);
      list.addEventListener('change', onAgentsListChange);
    }
    const form = byId('agent-form');
    if (form) form.addEventListener('submit', (e) => { void saveAgent(e); });
    const preset = byId('af-preset');
    if (preset) preset.addEventListener('change', () => applyPreset());
    const modalEl = byId('agent-modal');
    if (modalEl) modalEl.addEventListener('hidden.bs.modal', () => { editing = null; });

    // the host select follows host CRUD
    bus.on(EVENTS.HOSTS_CHANGED, ({ hosts }) => {
      const before = panelHostId;
      renderHostSelect(hosts);
      if (before !== panelHostId) void reloadHostAgents();
    });
    // another module may refresh the registry (custom agent added elsewhere)
    bus.on(EVENTS.AGENTS_CHANGED, ({ agents: list2 }) => {
      agents = Array.isArray(list2) ? list2 : agents;
      renderAgentCards();
    });
  },
  /** Panel entry: refresh the host select and this host's agent state. */
  show() {
    renderHostSelect();
    void reloadHostAgents();
  },
  hide() {
    stopSyncWatch();
  },
};

export default agentsPanel;
