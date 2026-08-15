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
import { byId, toast, toastError, confirmDialog, escapeHtml, fmtDuration, statusBadgeClass } from './util.js';

/** @type {any[]} */
let sessions = [];

/** FROZEN: F2 calls this for its initial rail paint. @returns {any[]} SessionView[] */
export function getSessions() {
  return sessions;
}

/**
 * TODO(F1):
 *  - render one <tr> per session into #sessions-tbody: name (+displayName), image
 *    (recipe title or custom ref), workspace summary, status badge, ports, uptime,
 *    action buttons (Open terminal / Start / Stop / Restart / Recreate / Edit / Logs / Destroy).
 *  - disable actions that do not apply to the current status; show a spinner on the row
 *    while a request is in flight.
 *  - surface `needsRecreate` (warning pill "config changed - recreate"), `orphan`
 *    (pill "orphan") and `warnings[]` (tooltip).
 */
function render() {
  throw new Error('TODO(F1): implement sessions render()');
}

/**
 * Load GET /api/sessions, store, render, emit SESSIONS_CHANGED.
 * Must swallow `backend_not_configured` into an inline #sessions-alert that links to
 * Settings instead of a toast storm.
 * TODO(F1)
 */
export async function reload() {
  throw new Error('TODO(F1): implement sessions reload()');
}

/**
 * Build/populate #session-form-body. Fields map 1:1 onto SessionInput (see api.md):
 *   name (slug ^[a-z0-9][a-z0-9-]{0,30}$, immutable when editing), displayName,
 *   image: radio recipe|custom -> <select> of GET /api/images/recipes | text input with a
 *          datalist from GET /api/images plus a "Validate" button
 *          (POST /api/images/custom/validate -> show warnings, e.g. missing tmux),
 *   workspace: radio volume|bind|git (+ hostPath / url + branch),
 *   env: repeatable KEY/VALUE rows, ports: repeatable containerPort/hostPort/protocol rows
 *        (leave hostPort blank => omit the field => docker picks a random port),
 *   extraMounts: repeatable type/source/target/readOnly rows,
 *   limits.cpus, limits.memoryMb, shareHistory, autoStart, network (<select> from
 *   GET /api/docker/networks), user.
 * TODO(F1)
 * @param {any|null} session existing SessionView for edit, null for create
 */
export function openSessionModal(session = null) {
  void session;
  throw new Error('TODO(F1): implement openSessionModal()');
}

/** Serialise #session-form into a SessionInput object; throws on client-side validation. TODO(F1) */
export function readSessionForm() {
  throw new Error('TODO(F1): implement readSessionForm()');
}

/** Open #logs-modal for a session and poll GET /api/sessions/:name/logs. TODO(F1) */
export function openLogs(name) {
  void name;
  throw new Error('TODO(F1): implement openLogs()');
}

/** @type {import('./app.js').ViewModule} */
const sessionsView = {
  /** TODO(F1): wire buttons (#btn-session-new, #btn-sessions-refresh, #btn-reconcile),
   *  delegate row actions from #sessions-tbody, do a first reload(). */
  async init(ctx) {
    void ctx;
    throw new Error('TODO(F1): implement sessionsView.init()');
  },
  /** TODO(F1): reload() + start a 5s poll (app.js SESSION_POLL_MS). The poll must keep
   *  running while the Code tab is visible too, because F2's rail depends on it - so start
   *  it in init() and only force an immediate refresh in show(). */
  show() { throw new Error('TODO(F1): implement sessionsView.show()'); },
  hide() { /* TODO(F1): nothing to tear down; keep the poll alive for the Code rail */ },
  refresh() { void reload(); },
};

export default sessionsView;

void api; void bus; void EVENTS; void byId; void toast; void toastError;
void confirmDialog; void escapeHtml; void fmtDuration; void statusBadgeClass; void render;
