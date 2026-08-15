// OWNER: F1. Entry module: boot, auth gate, hash routing, theme, view lifecycle.
//
// CONTRACT (FROZEN): every view module exports a default object implementing ViewModule:
//   { init(ctx): Promise<void>|void, show(): void, hide(): void, refresh?(): void }
// app.js calls init() once (after authentication), then show()/hide() on route changes.
// F2 owns codeView; F1 owns sessionsView / settingsView. app.js never reaches inside them.
import { api, ApiError } from './api.js';
import { bus, EVENTS } from './bus.js';
import { byId, toast, toastError, storage, LS_PREFIX } from './util.js';
import codeView from './code.js';
import sessionsView from './sessions.js';
import settingsView from './settings.js';

/**
 * @typedef {Object} ViewModule
 * @property {(ctx: AppContext) => (void|Promise<void>)} init
 * @property {() => void} show
 * @property {() => void} hide
 * @property {() => void} [refresh]
 */

/**
 * @typedef {Object} AppContext
 * @property {typeof api} api
 * @property {typeof bus} bus
 * @property {(view: 'code'|'sessions'|'settings') => void} navigate
 * @property {() => any} getSettings    last GET /api/settings payload (may be null)
 * @property {() => 'dark'|'light'} getTheme
 */

export const VIEWS = /** @type {const} */ (['code', 'sessions', 'settings']);
export const DEFAULT_VIEW = 'code';
export const LS_LAST_VIEW = `${LS_PREFIX}lastView`;

/** Session-poll interval used by sessions.js; F2 relies on SESSIONS_CHANGED, not on timing. */
export const SESSION_POLL_MS = 5000;

/** @type {Record<string, ViewModule>} */
const views = { code: codeView, sessions: sessionsView, settings: settingsView };

/**
 * TODO(F1) boot sequence:
 *  1. wire the login form + #btn-logout + theme select
 *  2. GET /api/auth/session
 *     - needsSetup -> show #login-setup-hint, disable the form
 *     - !authenticated -> showLogin()
 *     - authenticated -> startApp()
 *  3. bus.on(EVENTS.AUTH_REQUIRED) -> tear the app down (emit AUTH_LOST) and showLogin()
 *  4. window.addEventListener('hashchange', ...) -> route()
 */
export async function boot() {
  throw new Error('TODO(F1): implement boot()');
}

/**
 * TODO(F1): reveal #app-shell, load GET /api/settings once, apply the theme, update
 * #backend-badge, `await view.init(ctx)` for all three views (in parallel is fine, but
 * awaited before the first route()), emit AUTH_READY, then route().
 */
export async function startApp() {
  throw new Error('TODO(F1): implement startApp()');
}

/** TODO(F1): hide #app-shell, hide+dispose nothing (views keep state), open #login-modal. */
export function showLogin() {
  throw new Error('TODO(F1): implement showLogin()');
}

/**
 * Hash routing: '#/code' | '#/sessions' | '#/settings' (anything else -> DEFAULT_VIEW,
 * or the last view remembered in localStorage on a bare '#').
 * TODO(F1): toggle `.active` on #nav-*, toggle `.d-none` on #view-*, call hide() on the
 * previous module and show() on the next, emit VIEW_CHANGED, persist LS_LAST_VIEW.
 */
export function route() {
  throw new Error('TODO(F1): implement route()');
}

/** Apply 'auto'|'light'|'dark' to <html data-bs-theme>; emit THEME_CHANGED. TODO(F1) */
export function applyTheme(theme) {
  void theme;
  throw new Error('TODO(F1): implement applyTheme()');
}

// Kick off once the DOM (and the classic vendor scripts above it) are ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void boot(); });
} else {
  void boot();
}

void ApiError; void byId; void toast; void toastError; void storage; void views; void VIEWS;
