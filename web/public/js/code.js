// OWNER: F2. Code tab: GoldenLayout 2 tabs/split panes + the session rail + layout
// persistence. F1 must not edit this file (nor #view-code markup in index.html).
//
// GoldenLayout 2 is an ES module served from node_modules through /vendor (see
// server/src/vendor.ts). Its CSS is already linked in index.html.
import { GoldenLayout } from '/vendor/golden-layout/bundle/esm/golden-layout.js';

import { api } from './api.js';
import { bus, EVENTS } from './bus.js';
import { byId, toast, toastError, debounce, escapeHtml, storage, LS_PREFIX } from './util.js';
import { TerminalPane, makeTerminalName, THEMES } from './terminal.js';
import { getSessions } from './sessions.js';
import { getSettings } from './settings.js';

/** localStorage key for the layout blob (server copy lives in settings.ui.layout). FROZEN. */
export const LS_LAYOUT = `${LS_PREFIX}layout.v1`;
/** Debounce before persisting the layout (both localStorage and PUT /api/settings/ui). */
export const LAYOUT_SAVE_MS = 1500;
/** Layout blob envelope. Bump `v` if the pane state shape changes. */
export const LAYOUT_VERSION = 1;

/**
 * @typedef {Object} PaneState        component state stored in the GoldenLayout config
 * @property {string} session
 * @property {'bash'|'claude'|'sh'} shell
 * @property {string} name            stable pane/tmux name (makeTerminalName)
 * @property {string} [title]
 */

/**
 * @typedef {Object} LayoutBlob
 * @property {number} v               LAYOUT_VERSION
 * @property {number} savedAt         Date.now() - used to pick the fresher of local/server
 * @property {any} root               GoldenLayout `saveLayout()` output (LayoutConfig)
 */

export const COMPONENT_TERMINAL = 'terminal';

/** @type {GoldenLayout|null} */
let layout = null;
/** @type {Map<string, TerminalPane>} name -> pane */
const panes = new Map();

/**
 * TODO(F2) init:
 *  1. `layout = new GoldenLayout(byId('code-root'))`
 *  2. `layout.registerComponentFactoryFunction(COMPONENT_TERMINAL, (container, state) => {...})`
 *     - build `<div class="pc-pane">` + a `<div class="pc-pane-term">` host inside
 *       `container.element`
 *     - `const pane = new TerminalPane({session, shell, name, onStatus, onTitle})`
 *     - `pane.attach(host)`; `panes.set(name, pane)`
 *     - `container.on('resize', debouncedFit)`; `container.on('destroy', () => {
 *        pane.dispose(); panes.delete(name); persist(); })`
 *     - `container.setTitle(...)`; update it from onStatus (e.g. "web · claude ⟳")
 *  3. `layout.on('stateChanged', debouncedPersist)` (also fires on tab drag/split/close)
 *  4. window 'resize' -> `layout.setSize(el.clientWidth, el.clientHeight)` (debounced);
 *     GoldenLayout 2 does NOT auto-size unless you call layout.setSize()/resizeWithContainerAutomatically.
 *  5. restore the saved layout (see restoreLayout) or show #code-empty
 *  6. subscribe:
 *     - EVENTS.SESSIONS_CHANGED -> renderRail() + refresh #code-session-select
 *     - EVENTS.OPEN_TERMINAL    -> openTerminal(payload.session, payload.shell)
 *     - EVENTS.THEME_CHANGED    -> pane.setTheme(...) for every pane
 *     - EVENTS.AUTH_LOST        -> dispose every pane (no reconnect storm), keep the layout
 *     - EVENTS.VIEW_CHANGED     -> when view === 'code', re-fit on the next frame
 *  7. wire #btn-new-bash / #btn-new-claude / #btn-new-sh / #btn-reset-layout /
 *     #btn-rail-refresh.
 */
async function init(ctx) {
  void ctx;
  throw new Error('TODO(F2): implement codeView.init()');
}

/**
 * Open a new terminal pane.
 * TODO(F2):
 *  - refuse (toast) when the session is not `running`; offer to start it via
 *    api.sessions.start(name) and retry.
 *  - pick the next free index so the name is stable: makeTerminalName(session, shell, n)
 *    where n is the smallest positive integer not already in `panes`.
 *  - `layout.addComponent(COMPONENT_TERMINAL, state, title)` when a layout root exists,
 *    otherwise `layout.loadLayout(...)` with a single stack first.
 *  - hide #code-empty, persist().
 * @param {string} session @param {'bash'|'claude'|'sh'} shell
 */
export function openTerminal(session, shell) {
  void session; void shell;
  throw new Error('TODO(F2): implement openTerminal()');
}

/**
 * TODO(F2): paint #session-rail-list from getSessions() (or the SESSIONS_CHANGED payload):
 * one row per session with a status dot, the name, and two quick actions (bash / claude);
 * stopped sessions are dimmed and their actions offer "start + open". Also mirror the list
 * into #code-session-select (running sessions first, remember the last choice).
 * Must HTML-escape names.
 */
function renderRail(sessions) {
  void sessions;
  throw new Error('TODO(F2): implement renderRail()');
}

/**
 * Persist the layout.
 * TODO(F2): blob = { v: LAYOUT_VERSION, savedAt: Date.now(), root: layout.saveLayout() };
 * write `storage.set(LS_LAYOUT, blob)` immediately and `api.settings.putUi({layout: blob})`
 * debounced by LAYOUT_SAVE_MS. Swallow 401/backend errors silently (never toast on save).
 * Keep the blob under ~64 KB (drop pane scrollback - never store terminal output).
 */
export const persist = () => { throw new Error('TODO(F2): implement persist()'); };

/**
 * TODO(F2): choose the fresher of `storage.get(LS_LAYOUT)` and
 * `getSettings()?.ui?.layout` by `savedAt`, ignore blobs whose `v !== LAYOUT_VERSION`,
 * then `layout.loadLayout(blob.root)`. Panes reconnect automatically because the pane
 * `name` is part of the component state -> tmux reattach. If the referenced session no
 * longer exists, still create the pane; the socket will close 4404 and the pane shows the
 * error with a "close" action.
 * @returns {boolean} true when a layout was restored
 */
export function restoreLayout() {
  throw new Error('TODO(F2): implement restoreLayout()');
}

/** TODO(F2): dispose every pane, clear both stores, show #code-empty. */
export function resetLayout() {
  throw new Error('TODO(F2): implement resetLayout()');
}

/** @type {import('./app.js').ViewModule} */
const codeView = {
  init,
  /** TODO(F2): show -> layout.setSize(...) + fit every pane on the next animation frame
   *  (GoldenLayout measures 0x0 while #view-code is display:none). */
  show() { throw new Error('TODO(F2): implement codeView.show()'); },
  /** TODO(F2): nothing to tear down - terminals stay connected while another tab is open. */
  hide() {},
};

export default codeView;

void api; void bus; void EVENTS; void byId; void toast; void toastError; void debounce;
void escapeHtml; void storage; void THEMES; void renderRail; void panes; void layout;
