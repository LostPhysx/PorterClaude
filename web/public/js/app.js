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

/** @type {any|null} last GET /api/settings payload */
let appSettings = null;
/** @type {'dark'|'light'} */
let effectiveTheme = 'dark';
/** @type {'auto'|'light'|'dark'} */
let themePreference = 'auto';
/** @type {string|null} currently visible view */
let currentView = null;
let viewsReady = false;
let loginVisible = false;
let booted = false;

/** @type {AppContext} */
const ctx = {
  api,
  bus,
  navigate,
  getSettings: () => appSettings,
  getTheme: () => effectiveTheme,
};

// ---------------------------------------------------------------------------
// theme
// ---------------------------------------------------------------------------

function prefersDark() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

/** Apply 'auto'|'light'|'dark' to <html data-bs-theme>; emit THEME_CHANGED. */
export function applyTheme(theme) {
  themePreference = theme === 'light' || theme === 'dark' ? theme : 'auto';
  const resolved = themePreference === 'auto' ? (prefersDark() ? 'dark' : 'light') : themePreference;
  const changed = resolved !== effectiveTheme;
  effectiveTheme = resolved;
  document.documentElement.setAttribute('data-bs-theme', resolved);
  const select = byId('theme-select');
  if (select && select.value !== themePreference) select.value = themePreference;
  if (changed) bus.emit(EVENTS.THEME_CHANGED, { theme: resolved });
  return resolved;
}

function watchSystemTheme() {
  try {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (themePreference === 'auto') applyTheme('auto');
    };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onChange);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// backend badge
// ---------------------------------------------------------------------------

function updateBackendBadge(settings) {
  const el = byId('backend-badge');
  if (!el) return;
  const kind = settings && settings.backend ? settings.backend.kind : 'none';
  if (kind === 'socket') {
    el.className = 'badge text-bg-success';
    el.textContent = 'backend: socket';
  } else if (kind === 'portainer') {
    el.className = 'badge text-bg-primary';
    el.textContent = 'backend: portainer';
  } else {
    el.className = 'badge text-bg-warning';
    el.textContent = 'backend: not configured';
  }
}

// ---------------------------------------------------------------------------
// login modal
// ---------------------------------------------------------------------------

/** true between show()/hide() and the matching shown./hidden. bootstrap event */
let loginTransitioning = false;
let loginModalWired = false;

function wireLoginModal(el) {
  if (loginModalWired) return;
  loginModalWired = true;
  const settled = () => {
    loginTransitioning = false;
    syncLoginModal();
  };
  el.addEventListener('show.bs.modal', () => { loginTransitioning = true; });
  el.addEventListener('hide.bs.modal', () => { loginTransitioning = true; });
  el.addEventListener('shown.bs.modal', settled);
  el.addEventListener('hidden.bs.modal', settled);
}

/**
 * Bootstrap ignores show()/hide() while the modal is still animating (~300ms), so a login
 * submitted inside the show transition (password managers, automation, a very fast Enter)
 * used to leave the static backdrop over the shell forever. `loginVisible` is the WANTED
 * state; this replays it whenever a transition finishes.
 */
function syncLoginModal() {
  const modal = loginModal();
  if (!modal || loginTransitioning) return;
  if (loginVisible) modal.show();
  else modal.hide();
}

function loginModal() {
  const el = byId('login-modal');
  if (!el || typeof bootstrap === 'undefined') return null;
  wireLoginModal(el);
  return bootstrap.Modal.getOrCreateInstance(el);
}

function setLoginError(message) {
  const el = byId('login-error');
  if (el) el.textContent = message || '';
}

/** Hide #app-shell and open the login modal (views keep their state). */
export function showLogin() {
  const shell = byId('app-shell');
  if (shell) shell.classList.add('d-none');
  loginVisible = true;
  const input = byId('login-password');
  if (input) input.value = '';
  setLoginError('');
  syncLoginModal();
  setTimeout(() => {
    const pwd = byId('login-password');
    if (pwd) pwd.focus();
  }, 250);
}

function hideLogin() {
  loginVisible = false;
  syncLoginModal();
}

async function submitLogin(event) {
  if (event) event.preventDefault();
  const input = byId('login-password');
  const password = input ? input.value : '';
  const button = document.querySelector('#login-form button[type="submit"]');
  setLoginError('');
  if (!password) {
    setLoginError('Enter the password.');
    return;
  }
  if (button) button.disabled = true;
  try {
    await api.auth.login(password);
    if (input) input.value = '';
    hideLogin();
    await startApp();
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) {
      setLoginError('Too many attempts. Wait 15 minutes and try again.');
    } else if (err instanceof ApiError && err.status === 401) {
      setLoginError('Wrong password.');
    } else {
      setLoginError((err && err.message) || 'Login failed.');
    }
  } finally {
    if (button) button.disabled = false;
  }
}

async function doLogout() {
  try {
    await api.auth.logout();
  } catch {
    /* logging out locally is enough */
  }
  appSettings = null;
  bus.emit(EVENTS.AUTH_LOST, {});
  showLogin();
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

function viewFromHash() {
  const raw = String(location.hash || '').replace(/^#\/?/, '').split('?')[0];
  if (VIEWS.includes(raw)) return raw;
  const remembered = storage.get(LS_LAST_VIEW, null);
  if (VIEWS.includes(remembered)) return remembered;
  return DEFAULT_VIEW;
}

/** Navigate by changing the hash (route() runs from the hashchange handler). */
export function navigate(view) {
  const target = VIEWS.includes(view) ? view : DEFAULT_VIEW;
  const hash = `#/${target}`;
  if (location.hash === hash) route();
  else location.hash = hash;
}

/**
 * Hash routing: '#/code' | '#/sessions' | '#/settings' (anything else -> the last view
 * remembered in localStorage, else DEFAULT_VIEW).
 */
export function route() {
  const next = viewFromHash();
  if (!viewsReady) return;
  for (const name of VIEWS) {
    const link = byId(`nav-${name}`);
    if (link) link.classList.toggle('active', name === next);
    const section = byId(`view-${name}`);
    if (section) section.classList.toggle('d-none', name !== next);
  }
  if (currentView && currentView !== next) {
    try {
      views[currentView].hide();
    } catch (err) {
      console.error(`[app] ${currentView}.hide() threw`, err);
    }
  }
  currentView = next;
  storage.set(LS_LAST_VIEW, next);
  try {
    views[next].show();
  } catch (err) {
    console.error(`[app] ${next}.show() threw`, err);
  }
  bus.emit(EVENTS.VIEW_CHANGED, { view: next });
}

// ---------------------------------------------------------------------------
// boot / startApp
// ---------------------------------------------------------------------------

async function loadSettings() {
  try {
    const settings = await api.settings.get();
    appSettings = settings;
    updateBackendBadge(settings);
    applyTheme(settings && settings.ui ? settings.ui.theme : 'auto');
    return settings;
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) {
      console.error('[app] failed to load settings', err);
    }
    updateBackendBadge(null);
    return null;
  }
}

/**
 * Reveal the shell, load settings, init every view once, emit AUTH_READY and route().
 * Safe to call again after a re-login.
 */
export async function startApp() {
  const shell = byId('app-shell');
  if (shell) shell.classList.remove('d-none');
  loginVisible = false;

  await loadSettings();

  if (!viewsReady) {
    await Promise.all(
      VIEWS.map(async (name) => {
        try {
          await views[name].init(ctx);
        } catch (err) {
          console.error(`[app] ${name}.init() failed`, err);
          toast(`The ${name} view failed to initialise: ${(err && err.message) || err}`, {
            variant: 'danger',
            title: 'UI error',
          });
        }
      }),
    );
    viewsReady = true;
  }

  bus.emit(EVENTS.AUTH_READY, {});
  currentView = null;
  route();
}

function wireChrome() {
  const form = byId('login-form');
  if (form) form.addEventListener('submit', (e) => { void submitLogin(e); });

  const logout = byId('btn-logout');
  if (logout) logout.addEventListener('click', () => { void doLogout(); });

  const themeSelect = byId('theme-select');
  if (themeSelect) {
    themeSelect.addEventListener('change', () => {
      const value = themeSelect.value;
      applyTheme(value);
      if (appSettings && appSettings.ui) appSettings.ui.theme = value;
      api.settings.putUi({ theme: value }).catch((err) => toastError(err, 'Could not save the theme'));
    });
  }

  for (const name of VIEWS) {
    const link = byId(`nav-${name}`);
    if (link) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        navigate(name);
      });
    }
  }

  window.addEventListener('hashchange', () => route());
  watchSystemTheme();
}

/**
 * Boot sequence: wire the chrome, ask who we are, then either show the login modal or
 * start the app. Any later 401 tears the shell down and reopens the login modal.
 */
export async function boot() {
  if (booted) return;
  booted = true;
  wireChrome();

  bus.on(EVENTS.SETTINGS_CHANGED, ({ settings }) => {
    if (!settings) return;
    appSettings = settings;
    updateBackendBadge(settings);
    if (settings.ui && settings.ui.theme && settings.ui.theme !== themePreference) {
      applyTheme(settings.ui.theme);
    }
  });

  bus.on(EVENTS.AUTH_REQUIRED, () => {
    if (loginVisible) return;
    appSettings = null;
    bus.emit(EVENTS.AUTH_LOST, {});
    showLogin();
  });

  let session = null;
  try {
    session = await api.auth.session();
  } catch (err) {
    console.error('[app] /api/auth/session failed', err);
    setLoginError('Cannot reach the server.');
  }

  const hint = byId('login-setup-hint');
  if (session && session.needsSetup) {
    if (hint) hint.classList.remove('d-none');
    const input = byId('login-password');
    if (input) input.disabled = true;
    const button = document.querySelector('#login-form button[type="submit"]');
    if (button) button.disabled = true;
    showLogin();
    return;
  }
  if (hint) hint.classList.add('d-none');

  if (session && session.authenticated) {
    await startApp();
  } else {
    showLogin();
  }
}

// Kick off once the DOM (and the classic vendor scripts above it) are ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void boot(); });
} else {
  void boot();
}
