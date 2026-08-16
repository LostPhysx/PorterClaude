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
import { api } from './api.js';
import { bus, EVENTS } from './bus.js';
import {
  byId, toast, toastError, confirmDialog, escapeHtml, fmtBytes, renderAlert,
} from './util.js';

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
// host table (F1)
// ---------------------------------------------------------------------------

/**
 * TODO(F1): render #hosts-tbody, one row per HostView:
 *   Name        name (bold) + id (monospace, small) + a "default" badge + `notes`
 *   Connection  `connectionLabel` (never a secret) + `credentialName` when set
 *   Status      badge from hostStatusBadgeClass + `error` as a title/tooltip;
 *               `supported:false` renders "not supported yet (v0.3)" instead
 *   Sessions    `sessionCount`
 *   Agents      one chip per `agents.enabled` id, labelled through agents.js agentLabel()
 *   Actions     Test (POST /api/hosts/:id/test -> inline result), Info (#host-info-modal),
 *               Make default (hidden when isDefault), Edit, Delete
 * Toggle #hosts-empty when the list is empty. Everything from the API is escaped.
 */
export function renderHosts() {
  // TODO(F1)
  void byId;
  void hostStatusBadgeClass;
}

/**
 * TODO(F1): GET /api/hosts (probe only when asked), then renderHosts() + renderCredentials()
 * + refresh the selects of the other panels through EVENTS.HOSTS_CHANGED (loadHosts does the
 * emit). A failure renders an inline alert in #hosts-alert (renderAlert), never a toast loop.
 * @param {{probe?:boolean}} [opts]
 * @returns {Promise<void>}
 */
export async function reload(opts = {}) {
  void opts;
  void renderAlert;
  // TODO(F1)
}

/**
 * TODO(F1): build #host-form-body and show #host-modal.
 * Fields (ids FROZEN, see docs/design/frontend.md section 12.4):
 *   #hf-name      host name (required)
 *   #hf-id        slug, CREATE ONLY (readonly on edit, placeholder = slugified name)
 *   #hf-type-socket / #hf-type-portainer   connection radios; #hf-type-tcp / #hf-type-ssh
 *                 are rendered DISABLED with "planned for v0.3" (the schema accepts them,
 *                 every operation answers 501)
 *   #hf-socket-fields > #hf-socket-path    default /var/run/docker.sock
 *   #hf-portainer-fields > #hf-credential  <select> of stored credentials + a
 *                 "+ Add credential..." option that opens #credential-modal
 *                 and #hf-endpoint <select> filled from
 *                 GET /api/credentials/portainer/:id/endpoints
 *   #hf-agents    one checkbox per AgentView (agents.js getAgents()), checked from
 *                 host.agents.enabled; a new host starts with ['claude']
 *   #hf-overrides one input per general field (settings.js GENERAL_FIELDS), blank = inherit;
 *                 the placeholder shows the inherited value
 *   #hf-notes, #hf-default
 * A SECOND socket host must not be offerable: when another host already uses `socket`,
 * disable the radio and explain "the app runs on exactly one machine" (the server answers
 * 409 anyway).
 * @param {any|null} host HostView for edit, null for create
 */
export function openHostModal(host = null) {
  editingHost = host;
  // TODO(F1)
}

/**
 * TODO(F1): serialise #host-form into a HostInput / HostUpdateInput.
 * Rules: omit `id` when blank (the server slugifies `name`); `connection` is the
 * discriminated union from the radios; `overrides` only carries the fields the user actually
 * filled in; `agents` is the checked id list; `makeDefault` from #hf-default.
 * Throws an Error with a human message for client-side problems (no URL, no endpoint).
 * @returns {any}
 */
export function readHostForm() {
  // TODO(F1)
  return {};
}

/**
 * TODO(F1): POST /api/hosts/test with the CURRENT form connection (nothing is saved) and
 * render the BackendTestResult into #host-test-result: an info table on ok
 * (name, serverVersion, os, architecture, ncpu, fmtBytes(memTotalBytes), containers,
 * images), the `error.code: error.message` otherwise. For a portainer connection whose
 * credential is stored, the key is NOT sent (the server uses the stored one).
 * @returns {Promise<void>}
 */
export async function testHostForm() {
  void fmtBytes;
  // TODO(F1)
}

/**
 * TODO(F1): POST /api/hosts (create) or PUT /api/hosts/:id (edit), then close the modal,
 * reload({probe:true}) and toast. A 409 on a second socket host / a duplicate id renders
 * inline in #host-form-error; a 422 maps zod issues onto the offending field.
 * @param {Event} [event]
 * @returns {Promise<void>}
 */
export async function saveHost(event) {
  if (event) event.preventDefault();
  void editingHost;
  // TODO(F1)
}

/**
 * TODO(F1): confirmDialog -> DELETE /api/hosts/:id. A 409 means sessions still reference the
 * host: ask a SECOND time with the exact wording
 *   "<n> session(s) still point at this host. Deleting it leaves them read-only until a host
 *    with that id exists again. Containers, volumes and images on that engine are never
 *    touched."
 * and retry with `{ force: true }`.
 * @param {any} host HostView
 * @returns {Promise<void>}
 */
export async function deleteHost(host) {
  void host;
  void confirmDialog;
  // TODO(F1)
}

/**
 * TODO(F1): POST /api/hosts/:id/default -> reload + toast "<name> is now the default host".
 * @param {string} hostId
 * @returns {Promise<void>}
 */
export async function makeDefault(hostId) {
  void hostId;
  // TODO(F1)
}

/**
 * TODO(F1): GET /api/hosts/:id/info -> #host-info-modal (#host-info-title = host name,
 * #host-info-body = the same info table testHostForm() renders plus the effective
 * `settings` of the host and its `overrides`). An unreachable host shows the error.
 * @param {any} host HostView
 * @returns {Promise<void>}
 */
export async function showHostInfo(host) {
  void host;
  // TODO(F1)
}

// ---------------------------------------------------------------------------
// portainer credentials (F1)
// ---------------------------------------------------------------------------

/**
 * TODO(F1): GET /api/credentials/portainer -> `credentials` -> #credentials-list, one card
 * per SanitizedPortainerCredential: name, url (monospace), "stored ...a1b2" from
 * `apiKeyHint` (or "no key stored"), `insecureTls` marker, the hosts using it
 * (`hostIds` through hostLabel()), and the actions Test / Import endpoints / Edit / Delete.
 * THE API KEY IS WRITE-ONLY: it is never rendered, never logged, never put into
 * localStorage - the input always starts empty and an empty value means "keep the stored
 * key" (the property is omitted from the request, never sent as "").
 * @returns {Promise<void>}
 */
export async function reloadCredentials() {
  // TODO(F1)
  credentials = [];
}

/**
 * TODO(F1): open #credential-modal. Edit fills #cf-name/#cf-url/#cf-insecure, leaves
 * #cf-apikey EMPTY and shows `apiKeyHint` in #cf-key-hint.
 * @param {any|null} credential
 */
export function openCredentialModal(credential = null) {
  editingCredential = credential;
  // TODO(F1)
}

/**
 * TODO(F1): POST /api/credentials/portainer/test (create) or
 * POST /api/credentials/portainer/:id/test (edit, sending only the fields that were typed)
 * -> #credential-test-result. On success also show how many endpoints were found.
 * @returns {Promise<void>}
 */
export async function testCredentialForm() {
  // TODO(F1)
}

/**
 * TODO(F1): POST/PUT /api/credentials/portainer[/:id] -> close, reloadCredentials(),
 * and offer the natural next step: toast with "Import endpoints" wording. On create the
 * apiKey is REQUIRED; on edit it is omitted when blank.
 * @param {Event} [event]
 * @returns {Promise<void>}
 */
export async function saveCredential(event) {
  if (event) event.preventDefault();
  void editingCredential;
  // TODO(F1)
}

/**
 * TODO(F1): confirmDialog -> DELETE /api/credentials/portainer/:id; a 409 (a host still
 * references it) is reported as-is - deleting the hosts first is a deliberate step.
 * @param {any} credential
 * @returns {Promise<void>}
 */
export async function deleteCredential(credential) {
  void credential;
  // TODO(F1)
}

/**
 * TODO(F1): GET /api/credentials/portainer/:id/endpoints -> #import-endpoints, one checkbox
 * per endpoint (`<input data-endpoint="<id>">`, label = name + "#id" + a "docker"/"other"
 * marker; non-docker endpoints render disabled with the reason). Show #import-modal.
 * @param {any} credential
 * @returns {Promise<void>}
 */
export async function openImportModal(credential) {
  importingCredential = credential;
  // TODO(F1)
}

/**
 * TODO(F1): POST /api/credentials/portainer/:id/import
 *   { endpointIds: [checked ids], nameTemplate: #import-name-template, update: #import-update }
 * then render PortainerImportResult into #import-result:
 *   "<n> created, <n> updated, <n> skipped" plus one line per skipped entry with its reason,
 * and reload() the host table underneath (the modal stays open so the summary is readable).
 * @returns {Promise<void>}
 */
export async function runImport() {
  void importingCredential;
  void toast;
  void toastError;
  // TODO(F1)
}

const hostsPanel = {
  /**
   * TODO(F1): wire #btn-host-new, #btn-hosts-refresh, #btn-credential-new, #btn-import-run,
   * #btn-host-test, #btn-credential-test, the #host-form / #credential-form submits, and the
   * delegated click handlers of #hosts-tbody ([data-action] rows) and #credentials-list.
   * @param {any} ctx AppContext
   */
  async init(ctx) {
    void ctx;
    if (initialised) return;
    initialised = true;
    // TODO(F1)
  },
  /** TODO(F1): reload() (without probe) whenever the panel becomes visible. */
  show() {
    // TODO(F1)
  },
  hide() {},
};

export default hostsPanel;
