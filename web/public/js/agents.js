// OWNER: F1 (v0.2, new). Two jobs in one module:
//   1. the AGENT REGISTRY CACHE - the only place that knows what an agent id means. The
//      getters below are a CROSS-PACKAGE CONTRACT (FROZEN): F2 imports `agentLabel`,
//      `agentIcon` and `getAgents` for the Code tab's new-terminal menu and tab titles.
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
import { byId, toast, toastError, escapeHtml, fmtDate, storage, LS_PREFIX } from './util.js';
import { openJob } from './images.js';

/** localStorage key remembering which host the Agents panel is pointed at. */
export const LS_AGENTS_HOST = `${LS_PREFIX}agents.host`;

/**
 * Bootstrap-icon class per built-in agent id, used by the Settings cards AND by F2's
 * new-terminal menu. FROZEN: add ids here, never rename the export.
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

// ---------------------------------------------------------------------------
// registry cache (FROZEN accessors - implemented by the planner, do not change)
// ---------------------------------------------------------------------------

/** FROZEN. @returns {any[]} the last known AgentView[] (never null) */
export function getAgents() {
  return agents;
}

/**
 * The HostAgentView[] of the host the Agents panel currently shows (panel-local state;
 * sessions.js fetches its own list for the host picked in the session dialog).
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
 * TODO(F1): fill #agents-host-select from hosts.js `getHosts()` (label = host name, value =
 * id), preselect `storage.get(LS_AGENTS_HOST)` when that host still exists, else the default
 * host, remember the choice, and re-render on change. Disable the select and show
 * "no hosts yet - add one under Hosts" in #agents-host-note when there is no host.
 * @param {any[]} hosts HostView[]
 */
export function renderHostSelect(hosts) {
  void hosts;
  // TODO(F1)
}

/**
 * TODO(F1): GET /api/hosts/:hostId/agents -> `hostAgents`, then render #agents-list:
 * one card per AgentView (built-ins first, then custom) with
 *   - name, id (font-monospace), description, homepage link, `builtin` badge
 *   - install kind ("script" / "npm @google/gemini-cli" / "pip aider-chat" / "binary")
 *   - sharedPaths as <code> chips, loginHint as a muted line
 *   - a form-switch `input[data-agent-toggle="<id>"]` bound to HostAgentView.enabled
 *   - an install badge: "installed <version>" (success) / "not installed" (secondary) /
 *     the error string (danger), plus `installedAt` via fmtDate
 *   - Edit / Delete buttons for custom agents only (`data-agent-edit` / `data-agent-delete`)
 * An unreachable host answers installed:false + an error string per agent - render that,
 * never a toast loop.
 * @returns {Promise<void>}
 */
export async function reloadHostAgents() {
  // TODO(F1)
  hostAgents = [];
}

/**
 * TODO(F1): PUT /api/hosts/:hostId/agents { enabled } from every checked toggle, then
 * re-render and tell the user what is still missing:
 *   toast('Enabled on <host>. Run "Install / update on this host" to install it, then
 *          recreate the sessions that should mount it.')
 * A 409/422 puts the toggle back where it was (re-render from the response).
 * @param {string} agentId @param {boolean} enabled
 * @returns {Promise<void>}
 */
export async function setAgentEnabled(agentId, enabled) {
  void agentId;
  void enabled;
  // TODO(F1)
}

/**
 * TODO(F1): POST /api/hosts/:hostId/images/tools/sync (api.images.syncTools) and open the
 * job log with `openJob(hostId, job.id)` from images.js; a 409 conflict means a sync is
 * already running - open THAT job (ToolsStatus.jobId) instead of erroring. Refresh
 * reloadHostAgents() when the job finishes.
 * @returns {Promise<void>}
 */
export async function syncAgents() {
  // TODO(F1)
}

/**
 * TODO(F1): open #agent-modal. Create: prefill #af-json with AGENT_TEMPLATE and fill
 * #af-preset with "(empty)" + every built-in (picking one copies its definition into the
 * textarea with a fresh id, e.g. "my-claude"). Edit: JSON.stringify(agent, null, 2), preset
 * select hidden, id read-only in the JSON is not enforced client-side - the server answers
 * 409/422. Built-ins are never editable (the card has no Edit button).
 * @param {any|null} agent AgentView for edit, null for create
 */
export function openAgentModal(agent = null) {
  editing = agent;
  // TODO(F1)
}

/**
 * TODO(F1): parse #af-json (JSON.parse -> inline error in #agent-form-error on a syntax
 * error, never a toast), then POST /api/agents (create) or PUT /api/agents/:id (edit).
 * A 422 renders the zod issues as "<path>: <message>" lines under the textarea; a 409 says
 * "that id is taken by a built-in agent". On success: hide the modal, loadAgents(),
 * reloadHostAgents().
 * @param {Event} [event]
 * @returns {Promise<void>}
 */
export async function saveAgent(event) {
  if (event) event.preventDefault();
  void editing;
  // TODO(F1)
}

/**
 * TODO(F1): confirmDialog "Delete the custom agent <name>?" -> DELETE /api/agents/:id.
 * A 409 means a host enables it or a session pins it: ask again with
 * "Remove it from those hosts and sessions too? Their containers keep the mount until they
 *  are recreated." and retry with `{ force: true }`.
 * @param {any} agent AgentView
 * @returns {Promise<void>}
 */
export async function deleteAgent(agent) {
  void agent;
  // TODO(F1)
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

const agentsPanel = {
  /**
   * TODO(F1): wire #agents-host-select (change -> remember + reload), #btn-agents-refresh,
   * #btn-agents-sync, #btn-agent-new, the #agents-list delegated click handler
   * ([data-agent-toggle] / [data-agent-edit] / [data-agent-delete]), #agent-form submit and
   * #af-preset change. Subscribe to EVENTS.HOSTS_CHANGED to keep the host select fresh.
   * @param {any} ctx AppContext
   */
  async init(ctx) {
    void ctx;
    if (initialised) return;
    initialised = true;
    void storage;
    void toast;
    void toastError;
    void escapeHtml;
    void fmtDate;
    void byId;
    void openJob;
    // TODO(F1)
  },
  /** TODO(F1): refresh the host select + the per-host agent state. */
  show() {
    // TODO(F1)
  },
  hide() {},
};

export default agentsPanel;
