// OWNER: F2. Code tab: GoldenLayout 2 tabs/split panes + the session rail + layout
// persistence. F1 must not edit this file (nor #view-code markup in index.html).
//
// GoldenLayout 2 is an ES module served from node_modules through /vendor (see
// server/src/vendor.ts). Its CSS is already linked in index.html.
import { api, formatShellParam, parseShellParam } from './api.js';
import { bus, EVENTS } from './bus.js';
import { byId, toast, toastError, debounce, escapeHtml, storage, LS_PREFIX } from './util.js';
import { TerminalPane, makeTerminalName, terminalSlug } from './terminal.js';
import { getSessions, reload as reloadSessions, imageOutdated } from './sessions.js';
import { getSettings } from './settings.js';
import { agentLabel, agentIcon } from './agents.js';

/** localStorage key for the layout blob (server copy lives in settings.ui.layout). FROZEN. */
export const LS_LAYOUT = `${LS_PREFIX}layout.v1`;
/** localStorage key remembering the session picked in the toolbar. */
export const LS_LAST_SESSION = `${LS_PREFIX}code.session`;
/** localStorage key remembering the host filter of the rail/toolbar ('' = all hosts). */
export const LS_CODE_HOST = `${LS_PREFIX}code.host`;
/** Debounce before persisting the layout (both localStorage and PUT /api/settings/ui). */
export const LAYOUT_SAVE_MS = 1500;
/**
 * Layout blob envelope. v0.2 bumped this because PaneState changed shape
 * (`shell:'claude'` -> `shell:'agent'` + `agentId`). A v1 blob is still ACCEPTED and migrated
 * in place (see migrateLayoutBlob) so an upgrade never throws a user's panes away - the pane
 * NAME is what tmux keys off, and migrating keeps it byte-identical.
 */
export const LAYOUT_VERSION = 2;
/** Blob versions restoreLayout() accepts; anything else is ignored (and dropped). */
export const ACCEPTED_LAYOUT_VERSIONS = [1, 2];
/** Hard ceiling for the persisted blob - it must never contain terminal output. */
export const LAYOUT_MAX_BYTES = 64 * 1024;

/**
 * @typedef {Object} PaneState        component state stored in the GoldenLayout config
 * @property {string} session
 * @property {'bash'|'sh'|'agent'} shell
 * @property {string|null} agentId    set exactly when shell === 'agent'
 * @property {string} name            stable pane/tmux name (makeTerminalName)
 * @property {string} [hostId]        informational: the host the session lived on when the
 *                                    pane was opened (the server always re-resolves it)
 * @property {string} [title]
 */

/**
 * @typedef {Object} LayoutBlob
 * @property {number} v               LAYOUT_VERSION
 * @property {number} savedAt         Date.now() - used to pick the fresher of local/server
 * @property {any} root               GoldenLayout `saveLayout()` output (LayoutConfig)
 */

export const COMPONENT_TERMINAL = 'terminal';

/** @type {any|null} the GoldenLayout instance */
let layout = null;
/** @type {any|null} the GoldenLayout constructor once the vendored module is resolved */
let GoldenLayoutCtor = null;
/** @type {any|null} the whole vendored module - we need its `LayoutConfig` namespace too */
let GoldenLayoutModule = null;
/** @type {Map<string, {pane: TerminalPane, container: any, state: PaneState}>} name -> pane */
const panes = new Map();
/** @type {any} AppContext handed to init() */
let appCtx = null;
/** @type {any[]} last SESSIONS_CHANGED payload */
let railSessions = [];
/** true while loadLayout()/clear() runs so we do not persist half-built states */
let suspendPersist = false;
/** true after AUTH_LOST tore the panes down; AUTH_READY then restores them */
let suspended = false;
let initialised = false;
/**
 * true while the first restore found nothing *and* no copy of the server settings has been
 * observed yet, i.e. the "fresher savedAt wins" decision of frontend.md 5.5 is still open.
 * While it is set (and no pane exists) we neither trust the empty layout nor persist it -
 * SETTINGS_CHANGED retries the restore as soon as GET /api/settings lands.
 */
let restorePending = false;

// ---------------------------------------------------------------------------
// GoldenLayout module loading
//
// golden-layout 2.6.0 ships `dist/esm/**` only - there is no `dist/bundle/`, so the
// `bundle/esm/golden-layout.js` path older notes mention never existed and probing it just
// logged a 404 on every page load (INT-04). api.md documents `/vendor/golden-layout/esm/index.js`
// as THE entry; the vendor mount passes `extensions: ['js']` so the browser can resolve its
// extensionless relative specifiers. We therefore try, in order:
//   1. `/vendor/golden-layout/esm/index.js`  (a plain dynamic import - the normal path)
//   2. a tiny in-page loader that fetches the (acyclic, 33 module) ESM graph and rewrites
//      the relative specifiers to blob URLs (for servers without `extensions: ['js']`).
// ---------------------------------------------------------------------------

/** THE golden-layout ESM entry (api.md "Static assets"). FROZEN alongside VENDOR_ROUTES. */
export const GL_ENTRY_URL = '/vendor/golden-layout/esm/index.js';
const GL_ENTRY_URLS = [GL_ENTRY_URL];
const GL_SHIM_ENTRY = GL_ENTRY_URL;

/** `from './x'` / `import './x'` with a RELATIVE specifier (never touches other strings). */
const REL_SPEC_RE = /\b(from|import)(\s*)(['"])(\.{1,2}\/[^'"]*)\3/g;

/** @type {Map<string,string>} resolved module URL -> blob URL */
const shimCache = new Map();
/** @type {Set<string>} modules currently being shimmed (cycle guard) */
const shimLoading = new Set();

async function fetchModuleSource(url) {
  let res;
  try {
    res = await fetch(url, { credentials: 'same-origin' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  // The server's SPA fallback answers unknown paths with index.html - not a module.
  if (type.includes('html')) return null;
  return res.text();
}

async function resolveModuleUrl(baseUrl, spec) {
  const abs = new URL(spec, baseUrl);
  const candidates = /\.[a-z0-9]+$/i.test(abs.pathname)
    ? [abs.href]
    : [`${abs.href}.js`, `${abs.href}/index.js`];
  for (const candidate of candidates) {
    // already shimmed: no need to fetch it a second time
    if (shimCache.has(candidate)) return { url: candidate, source: null };
    const source = await fetchModuleSource(candidate);
    if (source !== null) return { url: candidate, source };
  }
  throw new Error(`cannot resolve "${spec}" from ${baseUrl}`);
}

/** Fetch one module, shim its dependencies, return a blob URL for it. */
async function shimModule(url, source) {
  const cached = shimCache.get(url);
  if (cached) return cached;
  if (shimLoading.has(url)) throw new Error(`circular import at ${url}: cannot shim`);
  shimLoading.add(url);
  try {
    const src = source ?? (await fetchModuleSource(url));
    if (src === null) throw new Error(`cannot fetch ${url}`);
    const specs = new Set();
    for (const match of src.matchAll(REL_SPEC_RE)) specs.add(match[4]);
    /** @type {Map<string,string>} */
    const mapped = new Map();
    for (const spec of specs) {
      const dep = await resolveModuleUrl(url, spec);
      mapped.set(spec, await shimModule(dep.url, dep.source));
    }
    const rewritten = src
      .replace(REL_SPEC_RE, (whole, kw, gap, quote, spec) =>
        (mapped.has(spec) ? `${kw}${gap}${quote}${mapped.get(spec)}${quote}` : whole))
      .replace(/^\s*\/\/#\s*sourceMappingURL=.*$/gm, '');
    const blobUrl = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
    shimCache.set(url, blobUrl);
    return blobUrl;
  } finally {
    shimLoading.delete(url);
  }
}

/** Resolve the GoldenLayout constructor, whatever shape the vendored package has. */
export async function loadGoldenLayout() {
  if (GoldenLayoutCtor) return GoldenLayoutCtor;
  for (const url of GL_ENTRY_URLS) {
    try {
      const mod = await import(url);
      if (mod && mod.GoldenLayout) {
        GoldenLayoutModule = mod;
        GoldenLayoutCtor = mod.GoldenLayout;
        return GoldenLayoutCtor;
      }
    } catch {
      /* try the next strategy */
    }
  }
  console.warn(`[code] ${GL_ENTRY_URL} did not import directly; loading the ESM graph through a blob shim`);
  // shimModule resolves specifiers with `new URL(spec, base)`, which needs an ABSOLUTE base.
  const entry = await shimModule(new URL(GL_SHIM_ENTRY, window.location.href).href);
  const mod = await import(entry);
  if (!mod || !mod.GoldenLayout) throw new Error('golden-layout: GoldenLayout export not found');
  GoldenLayoutModule = mod;
  GoldenLayoutCtor = mod.GoldenLayout;
  return GoldenLayoutCtor;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a pane state coming from a (possibly v1) layout blob or from openTerminal().
 * v0.1 wrote `shell:'claude'`; that migrates to `{shell:'agent', agentId:'claude'}`, which
 * keeps the pane NAME (`<session>-claude-<n>`) and therefore the tmux session.
 * TODO(F2): an `agent` state without a valid agentId (api.js AGENT_ID_RE) is unusable -
 * return null so the pane renders the "unusable terminal state" placeholder.
 * @param {any} raw @returns {PaneState|null}
 */
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const session = typeof raw.session === 'string' ? raw.session : '';
  if (!session) return null;
  // parseShellParam accepts 'bash' | 'sh' | 'agent:<id>' | 'claude' (v0.1 alias)
  let wire = String(raw.shell || 'bash');
  if (raw.shell === 'agent' && raw.agentId) {
    try {
      wire = formatShellParam('agent', raw.agentId);
    } catch {
      return null;
    }
  }
  const parsed = parseShellParam(wire);
  if (!parsed) return null;
  let name = typeof raw.name === 'string' ? raw.name : '';
  if (!name) {
    try {
      name = makeTerminalName(session, terminalSlug(parsed.shell, parsed.agentId), 1);
    } catch {
      return null;
    }
  }
  return {
    session,
    shell: parsed.shell,
    agentId: parsed.agentId,
    name,
    hostId: typeof raw.hostId === 'string' ? raw.hostId : undefined,
    title: typeof raw.title === 'string' ? raw.title : undefined,
  };
}

/**
 * Smallest free index for this session + shell SLUG, so pane names stay stable across
 * reloads. The slug is the AGENT ID for agent panes (`web-claude-1`), which is exactly the
 * v0.1 name - an upgraded layout reattaches to its existing tmux sessions.
 * @param {string} session @param {string} slug terminalSlug(shell, agentId)
 */
function nextFreeName(session, slug) {
  for (let n = 1; n < 1000; n += 1) {
    const name = makeTerminalName(session, slug, n);
    if (!panes.has(name)) return name;
  }
  throw new Error('too many terminals for this session');
}

/**
 * Tab title.
 * TODO(F2): agent panes show the agent NAME (agentLabel), not the id; bash/sh keep the shell
 * word. When sessions of MORE THAN ONE host are on screen, prefix the host name:
 * `prod/web · Claude Code`. Keep it short - GoldenLayout tabs are narrow.
 * @param {PaneState} state @param {string} [status]
 */
function titleFor(state, status) {
  const index = /-(\d+)$/.exec(state.name);
  const suffix = index && index[1] !== '1' ? ` ${index[1]}` : '';
  let mark = '';
  if (status === 'connecting' || status === 'reconnecting') mark = ' ⟳';
  else if (status === 'fatal') mark = ' ⚠';
  else if (status === 'closed') mark = ' ●';
  const what = state.shell === 'agent' ? agentLabel(state.agentId) : state.shell;
  return `${state.session} · ${what}${suffix}${mark}`;
}

function dotClass(status) {
  switch (status) {
    case 'running': return 'pc-dot-running';
    case 'dead':
    case 'error': return 'pc-dot-error';
    case 'created':
    case 'restarting':
    case 'removing':
    case 'paused': return 'pc-dot-pending';
    default: return 'pc-dot-exited';
  }
}

function sessionByName(name) {
  return railSessions.find((s) => s && s.name === name) || null;
}

function currentTheme() {
  try {
    if (appCtx && typeof appCtx.getTheme === 'function') return appCtx.getTheme();
  } catch {
    /* fall through */
  }
  return document.documentElement.getAttribute('data-bs-theme') === 'light' ? 'light' : 'dark';
}

function toggleEmpty() {
  const empty = byId('code-empty');
  if (empty) empty.classList.toggle('d-none', panes.size > 0 || !layout);
}

function updateStatus() {
  const el = byId('code-status');
  if (el) {
    if (!layout) {
      el.textContent = 'layout unavailable';
    } else if (panes.size === 0) {
      el.textContent = '';
    } else {
      let busy = 0;
      for (const entry of panes.values()) {
        if (entry.pane.status === 'reconnecting' || entry.pane.status === 'connecting') busy += 1;
      }
      el.textContent = `${panes.size} pane${panes.size === 1 ? '' : 's'}${busy ? ` · ${busy} reconnecting` : ''}`;
    }
  }
  bus.emit(EVENTS.TERMINALS_CHANGED, { count: panes.size });
}

// ---------------------------------------------------------------------------
// layout persistence
// ---------------------------------------------------------------------------

/**
 * GoldenLayout's `saveLayout()` returns a *ResolvedLayoutConfig* (numeric `size` +
 * separate `sizeUnit`), but `loadLayout()` re-runs `LayoutConfig.resolve()` on whatever
 * it is handed and that calls `parseSize()` on the size - which throws
 * `TypeError: value.trimStart is not a function` for a number. Everything persisted
 * therefore has to be turned back into an *unresolved* LayoutConfig before it is loaded.
 * `LayoutConfig.fromResolved()` does exactly that; the manual walk is a fallback for
 * builds that do not expose the namespace.
 * @param {any} root a (possibly already unresolved) layout config
 * @returns {any} a config `loadLayout()` accepts
 */
export function toLoadableLayoutConfig(root) {
  if (!root || typeof root !== 'object') return root;
  const ns = GoldenLayoutModule && GoldenLayoutModule.LayoutConfig;
  const resolved = ns && typeof ns.isResolved === 'function'
    ? ns.isResolved(root)
    : root.resolved === true;
  if (!resolved) return root;
  if (ns && typeof ns.fromResolved === 'function') {
    try {
      return ns.fromResolved(root);
    } catch (err) {
      console.debug('[code] LayoutConfig.fromResolved failed, falling back', err);
    }
  }
  return unresolveManually(root);
}

/**
 * Fallback for {@link toLoadableLayoutConfig} (exported so it can be exercised directly):
 * a resolved config splits every CSS size
 * into `<key>` (number) + `<key>Unit` ('px'|'%'|'fr'|'em') - `size`/`minSize` on items and
 * `defaultMinItemWidth`/`defaultMinItemHeight` under `dimensions`. Join every such pair
 * back into the string form the unresolved config uses, and drop the `resolved` marker.
 */
export function unresolveManually(value) {
  if (Array.isArray(value)) return value.map(unresolveManually);
  if (!value || typeof value !== 'object') return value;
  /** @type {any} */
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === 'resolved') continue;
    if (key.endsWith('Unit') && typeof val === 'string') continue;
    const unit = value[`${key}Unit`];
    if (typeof val === 'number' && typeof unit === 'string') {
      out[key] = `${val}${unit}`;
      continue;
    }
    // componentState is user data (our PaneState) - copy it verbatim.
    out[key] = key === 'componentState' ? val : unresolveManually(val);
  }
  return out;
}

/** Forget both persisted copies (used by the reset button and after a corrupt blob). */
function clearPersistedLayout() {
  persistSoon.cancel();
  pushLayoutToServer.cancel();
  storage.remove(LS_LAYOUT);
  api.settings.putUi({ layout: null }).catch(() => {});
}

/** @returns {LayoutBlob|null} */
function snapshot() {
  if (!layout) return null;
  try {
    return { v: LAYOUT_VERSION, savedAt: Date.now(), root: layout.saveLayout() };
  } catch (err) {
    console.debug('[code] saveLayout failed', err);
    return null;
  }
}

const pushLayoutToServer = debounce((blob) => {
  // Failures are never surfaced: losing a layout save must not interrupt the user.
  api.settings.putUi({ layout: blob }).catch(() => {});
}, LAYOUT_SAVE_MS);

/**
 * Persist the layout: localStorage immediately, the server copy debounced.
 * Never stores terminal output - only the component state (session/shell/name).
 */
export function persist() {
  if (!layout || suspendPersist || suspended) return;
  // Do not overwrite the server copy with an empty layout while the first restore decision
  // is still waiting for GET /api/settings (a second browser would lose its panes).
  if (restorePending && panes.size === 0) return;
  const blob = snapshot();
  if (!blob) return;
  let encoded;
  try {
    encoded = JSON.stringify(blob);
  } catch (err) {
    console.debug('[code] layout is not serialisable', err);
    return;
  }
  if (encoded.length > LAYOUT_MAX_BYTES) {
    console.warn(`[code] layout blob too large (${encoded.length} bytes) - not persisted`);
    return;
  }
  storage.set(LS_LAYOUT, blob);
  pushLayoutToServer(blob);
}

const persistSoon = debounce(() => persist(), 250);

/**
 * Migrate a v1 layout blob to v2 in place: every `componentState` goes through
 * normalizeState(), i.e. `shell:'claude'` becomes `{shell:'agent', agentId:'claude'}` while
 * `name` is left untouched (that is the tmux identity).
 * TODO(F2): walk `blob.root` recursively (`content[]` arrays + `componentState` objects),
 * rewrite the states, set `v: LAYOUT_VERSION`, and return the blob. A state that does not
 * normalise is DROPPED from the tree, not kept as a broken pane.
 * @param {LayoutBlob} blob
 * @returns {LayoutBlob|null}
 */
export function migrateLayoutBlob(blob) {
  // TODO(F2)
  return blob;
}

/** @param {any} blob @returns {LayoutBlob|null} */
function validBlob(blob) {
  if (!blob || typeof blob !== 'object') return null;
  if (!ACCEPTED_LAYOUT_VERSIONS.includes(blob.v)) return null;
  if (!blob.root || typeof blob.root !== 'object' || !blob.root.root) return null;
  return blob.v === LAYOUT_VERSION ? blob : migrateLayoutBlob(blob);
}

/**
 * Every known copy of the server settings, freshest source first.
 * `settings.js` only fills its cache from its *own* GET /api/settings (fired inside
 * `settingsView.init()`), which races the GoldenLayout ESM import - `app.startApp()`
 * however awaits GET /api/settings *before* any `init()`, so `ctx.getSettings()` is
 * race-free. Reading both removes the race without adding another request.
 * @returns {any[]}
 */
function settingsSources() {
  /** @type {any[]} */
  const out = [];
  for (const read of [
    () => getSettings(),
    () => (appCtx && typeof appCtx.getSettings === 'function' ? appCtx.getSettings() : null),
  ]) {
    let value = null;
    try { value = read(); } catch { value = null; }
    if (value && typeof value === 'object') out.push(value);
  }
  return out;
}

/** @returns {boolean} true once *any* GET /api/settings answer is known to the page */
function settingsSeen() {
  return settingsSources().length > 0;
}

/**
 * The server-side layout blob, taken from whichever settings copy is fresher.
 * @returns {LayoutBlob|null}
 */
function remoteBlob() {
  /** @type {LayoutBlob|null} */
  let best = null;
  for (const settings of settingsSources()) {
    const blob = validBlob(settings.ui && settings.ui.layout);
    if (blob && (!best || Number(blob.savedAt || 0) > Number(best.savedAt || 0))) best = blob;
  }
  return best;
}

/**
 * Restore the fresher of the localStorage / server layout blobs (frontend.md 5.5).
 * The server copy is read through {@link remoteBlob}, i.e. from *both* settings sources,
 * so a cold-localStorage browser no longer depends on settings.js winning its race against
 * the GoldenLayout import. When neither copy is available yet, `restorePending` keeps the
 * decision open (see the SETTINGS_CHANGED handler in `init()`).
 * Panes reconnect automatically because the pane `name` is part of the component state,
 * so tmux reattaches.
 * @returns {boolean} true when a layout was restored
 */
export function restoreLayout() {
  if (!layout) return false;
  const local = validBlob(storage.get(LS_LAYOUT, null));
  const remote = remoteBlob();
  let blob = local;
  if (remote && (!local || Number(remote.savedAt || 0) > Number(local.savedAt || 0))) blob = remote;
  if (!blob) {
    // Nothing to restore *yet*: keep the decision open until the settings are known.
    restorePending = !settingsSeen();
    return false;
  }
  restorePending = false;

  suspendPersist = true;
  try {
    layout.loadLayout(toLoadableLayoutConfig(blob.root));
    return true;
  } catch (err) {
    console.error('[code] could not restore the saved layout', err);
    try { layout.clear(); } catch { /* ignore */ }
    // Drop BOTH copies: keeping the server one would replay the same failure on every
    // boot (and the local one alone would silently disagree with the server).
    clearPersistedLayout();
    return false;
  } finally {
    suspendPersist = false;
    toggleEmpty();
    updateStatus();
  }
}

/** Dispose every pane, clear both stores, show the empty state. */
export function resetLayout() {
  if (!layout) return;
  suspendPersist = true;
  try {
    layout.clear();
  } catch (err) {
    console.error('[code] clear failed', err);
  } finally {
    suspendPersist = false;
  }
  for (const entry of panes.values()) entry.pane.dispose();
  panes.clear();
  restorePending = false;
  clearPersistedLayout();
  toggleEmpty();
  updateStatus();
}

/** Drop every socket without touching the saved layout (used on logout / 401). */
function suspendPanes() {
  if (!layout || suspended) return;
  persist();
  pushLayoutToServer.cancel();
  suspended = true;
  suspendPersist = true;
  try {
    layout.clear();
  } catch (err) {
    console.debug('[code] clear on auth loss failed', err);
  } finally {
    suspendPersist = false;
  }
  for (const entry of panes.values()) entry.pane.dispose();
  panes.clear();
  persistSoon.cancel();
  toggleEmpty();
  updateStatus();
}

function resumePanes() {
  if (!layout || !suspended) return;
  suspended = false;
  restoreLayout();
  resize();
}

// ---------------------------------------------------------------------------
// sizing
// ---------------------------------------------------------------------------

function resize() {
  if (!layout) return;
  const root = byId('code-root');
  if (!root) return;
  const width = root.clientWidth;
  const height = root.clientHeight;
  // GoldenLayout measures 0x0 while #view-code is display:none, which would create 1x1
  // terminals - skip those calls entirely.
  if (width < 2 || height < 2) return;
  try {
    layout.setSize(width, height);
  } catch (err) {
    console.debug('[code] setSize failed', err);
  }
  fitAll();
}

function fitAll() {
  requestAnimationFrame(() => {
    for (const entry of panes.values()) entry.pane.fit();
  });
}

const resizeSoon = debounce(() => resize(), 100);

// ---------------------------------------------------------------------------
// panes
// ---------------------------------------------------------------------------

/** GoldenLayout component factory for the single 'terminal' component. */
function buildTerminalComponent(container, rawState) {
  const state = normalizeState(rawState);
  if (!state) {
    container.element.innerHTML =
      '<div class="pc-pane pc-pane-broken p-3 small text-danger">Unusable terminal state - close this pane.</div>';
    return;
  }
  // A restored layout may contain a duplicate name (e.g. two blobs merged): keep names unique
  // because they are the tmux identity.
  if (panes.has(state.name)) state.name = nextFreeName(state.session, state.shell);

  const root = document.createElement('div');
  root.className = 'pc-pane';
  container.element.appendChild(root);

  const pane = new TerminalPane({
    session: state.session,
    shell: state.shell,
    agentId: state.agentId ?? null,
    name: state.name,
    theme: currentTheme(),
    // 4410 agent_not_available: the pane offers "Open bash instead" and calls this.
    onOpenBash: () => openTerminal(state.session, 'bash'),
    onStatus: (status) => {
      try { container.setTitle(titleFor(state, status)); } catch { /* container gone */ }
      updateStatus();
    },
    onTitle: (title) => { root.title = title; },
    onRequestClose: () => {
      try { container.close(); } catch (err) { console.debug('[code] close failed', err); }
    },
  });

  panes.set(state.name, { pane, container, state });
  container.setTitle(titleFor(state, 'connecting'));
  pane.attach(root);

  const fitSoon = () => requestAnimationFrame(() => pane.fit());
  container.on('resize', fitSoon);
  container.on('show', fitSoon);
  container.on('destroy', () => {
    // Closing a pane on purpose must also end the shell inside the container (INT-06);
    // a programmatic teardown (layout restore, reset, auth loss) must not, so that
    // reopening the pane reattaches its tmux session. `suspendPersist` is set around every
    // loadLayout()/clear(), and `suspended` covers the auth-loss teardown.
    pane.dispose({ kill: !suspendPersist && !suspended });
    panes.delete(state.name);
    toggleEmpty();
    updateStatus();
    persistSoon();
  });

  toggleEmpty();
  updateStatus();
  fitSoon();
}

/**
 * Open a new terminal pane for `session`.
 * A stopped session is started first (best effort); the pane itself shows a "start session"
 * action when the server answers 4409.
 *
 * v0.2: `shellParam` is the WIRE value - 'bash' | 'sh' | 'agent:<agentId>' (api.js
 * formatShellParam). The legacy 'claude' is accepted (parseShellParam maps it) so an old
 * bookmark/bus payload still works. An agent that is not in the session's `resolvedAgents`
 * must NOT be opened: toast "<agent> is not mounted into <session> - enable it on the host
 * and recreate the session" and return (the server would close 4410 anyway).
 * @param {string} session @param {string} shellParam
 */
export function openTerminal(session, shellParam) {
  if (!session) {
    toast('Pick a session first.', { variant: 'warning' });
    return;
  }
  if (!layout) {
    toast('The terminal layout could not be loaded.', { variant: 'danger' });
    return;
  }
  const parsed = parseShellParam(shellParam) || { shell: 'bash', agentId: null };
  const wanted = parsed.shell;
  const agentId = parsed.agentId;
  // TODO(F2): refuse an agent the session does not mount (see the doc comment above).
  const view = sessionByName(session);
  if (view && view.status !== 'running') {
    toast(`Session "${session}" is not running - starting it…`, { variant: 'info' });
    api.sessions
      .start(session)
      .then(() => reloadSessions())
      .catch((err) => toastError(err, `Could not start "${session}"`));
  }

  let name;
  try {
    name = nextFreeName(session, terminalSlug(wanted, agentId));
  } catch (err) {
    toastError(err, 'Could not name the terminal');
    return;
  }
  // The user is building a layout now - stop waiting for a server copy to arrive.
  restorePending = false;
  /** @type {PaneState} */
  const state = {
    session,
    shell: wanted,
    agentId,
    name,
    ...(view && view.hostId ? { hostId: view.hostId } : {}),
  };
  try {
    layout.addComponent(COMPONENT_TERMINAL, state, titleFor(state, 'connecting'));
  } catch (err) {
    console.error('[code] addComponent failed', err);
    toastError(err, 'Could not open the terminal');
    return;
  }
  toggleEmpty();
  resize();
  persist();
  const entry = panes.get(name);
  if (entry) requestAnimationFrame(() => entry.pane.focus());
}

// ---------------------------------------------------------------------------
// session rail + toolbar
// ---------------------------------------------------------------------------

/**
 * The host filter of the rail/toolbar ('' = all hosts). Persisted in LS_CODE_HOST.
 * @returns {string}
 */
function codeHostFilter() {
  return storage.get(LS_CODE_HOST, '') || '';
}

/**
 * TODO(F2): fill #code-host-filter with one option per DISTINCT hostId present in
 * `railSessions` (label = the session's `hostName`), plus a leading "All hosts" option.
 * Hide the whole select while only one host is present (a single-host install must look
 * exactly like v0.1). Persist the choice in LS_CODE_HOST and re-render rail + select.
 * @param {any[]} sessions
 */
function renderHostFilter(sessions) {
  void sessions;
  void codeHostFilter;
  // TODO(F2)
}

/**
 * Paint #session-rail-list. All API strings are HTML-escaped.
 *
 * TODO(F2) v0.2: GROUP BY HOST. With more than one host, emit one
 *   `<div class="pc-rail-group" data-host="<hostId>">`
 *      `<div class="pc-rail-group-head">` + hostName + a muted session count + `</div>`
 *      ...one `.pc-rail-item` per session of that host...
 *   `</div>`
 * (hosts sorted by name, the default host first; sessions sorted as today). With a single
 * host, render the flat list exactly as v0.1 did - no group header at all.
 * A session with `hostMissing === true` renders in a group headed "host gone" and its quick
 * actions are disabled.
 * The per-row quick actions become: bash (`data-open="bash"`) and the session's FIRST agent
 * (`data-open="agent:<id>"`, icon agentIcon(id), title "Open <agentLabel(id)>"); a session
 * without agents shows only bash.
 */
function renderRail(sessions) {
  const list = byId('session-rail-list');
  if (!list) return;
  const items = Array.isArray(sessions) ? sessions : [];
  if (!items.length) {
    list.innerHTML =
      '<div class="p-2 small text-secondary">No sessions yet. Create one in the <a href="#/sessions">Sessions</a> tab.</div>';
    return;
  }
  list.innerHTML = items
    .map((s) => {
      const name = escapeHtml(s.name);
      const stopped = s.status !== 'running';
      // INT-01: never show the raw image id here - only whether a newer build is waiting.
      const stale = imageOutdated(s);
      const title = escapeHtml(
        `${s.name} - ${s.status}${s.displayName ? ` (${s.displayName})` : ''}` +
        (stale ? ' - image updated, recreate to pick it up' : ''),
      );
      const staleIcon = stale
        ? '<i class="bi bi-arrow-repeat text-warning ms-1" title="image updated \u2014 recreate the container to pick it up" aria-label="image updated - recreate"></i>'
        : '';
      return (
        `<div class="pc-rail-item${stopped ? ' is-stopped' : ''}" data-session="${name}" title="${title}">` +
        `<span class="pc-dot ${dotClass(s.status)}"></span>` +
        `<span class="pc-rail-name text-truncate flex-grow-1">${name}${staleIcon}</span>` +
        '<span class="pc-rail-actions">' +
        `<button type="button" class="btn btn-sm btn-link p-0" data-open="bash" data-session="${name}" title="Open bash" aria-label="Open bash in ${name}"><i class="bi bi-terminal"></i></button>` +
        // TODO(F2): the second quick action is the session's first resolvedAgent, not
        // "claude": data-open="agent:<id>", icon agentIcon(id), title "Open <label>".
        `<button type="button" class="btn btn-sm btn-link p-0 ms-1" data-open="agent:claude" data-session="${name}" title="Open the agent" aria-label="Open the agent in ${name}"><i class="bi ${escapeHtml(agentIcon('claude'))}"></i></button>` +
        '</span></div>'
      );
    })
    .join('');
}

/**
 * Mirror the sessions into #code-session-select (running first, remembering the choice).
 * TODO(F2) v0.2: honour the host filter, and when more than one host is present render the
 * option label as `<session> - <hostName>` so two hosts with similar names stay tellable
 * apart. Changing the selection must also re-render the agent menu (renderAgentMenu).
 */
function renderSessionSelect(sessions) {
  const select = /** @type {HTMLSelectElement|null} */ (byId('code-session-select'));
  if (!select) return;
  const items = (Array.isArray(sessions) ? sessions : []).slice().sort((a, b) => {
    const ar = a.status === 'running' ? 0 : 1;
    const br = b.status === 'running' ? 0 : 1;
    if (ar !== br) return ar - br;
    return String(a.name).localeCompare(String(b.name));
  });
  const previous = select.value || storage.get(LS_LAST_SESSION, '') || '';
  select.textContent = '';
  if (!items.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'no sessions';
    select.appendChild(opt);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const s of items) {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = s.status === 'running' ? s.name : `${s.name} (${s.status})`;
    select.appendChild(opt);
  }
  const wanted = items.some((s) => s.name === previous) ? previous : items[0].name;
  select.value = wanted;
  storage.set(LS_LAST_SESSION, wanted);
}

/**
 * Fill #new-agent-menu from the SELECTED session's `resolvedAgents`:
 *   `<li><button class="dropdown-item" type="button" data-agent="<id>">`
 *   `<i class="bi <agentIcon(id)> me-2"></i><agentLabel(id)></button></li>`
 * TODO(F2): when the session has no agent, render a single disabled item
 * "no coding agent in this session" plus a link item "Settings -> Agents"; when no session
 * is selected at all, disable #btn-new-agent. Rebuild this on SESSIONS_CHANGED,
 * AGENTS_CHANGED and on every #code-session-select change - it is what makes a freshly
 * synced agent appear without a reload.
 */
function renderAgentMenu() {
  void agentLabel;
  void agentIcon;
  // TODO(F2)
}

function selectedSession() {
  const select = /** @type {HTMLSelectElement|null} */ (byId('code-session-select'));
  const value = select && select.value ? select.value : storage.get(LS_LAST_SESSION, '');
  return value || (railSessions.find((s) => s.status === 'running') || {}).name || '';
}

function wireToolbar() {
  const openFrom = (shellParam) => () => openTerminal(selectedSession(), shellParam);
  const bash = byId('btn-new-bash');
  if (bash) bash.addEventListener('click', openFrom('bash'));
  const sh = byId('btn-new-sh');
  if (sh) sh.addEventListener('click', openFrom('sh'));

  // TODO(F2): #new-agent-menu is a delegated click target - `[data-agent]` opens
  // openTerminal(selectedSession(), formatShellParam('agent', id)). Also wire
  // #code-host-filter (change -> storage.set(LS_CODE_HOST, value) + re-render rail/select).
  const agentMenu = byId('new-agent-menu');
  if (agentMenu) {
    agentMenu.addEventListener('click', (event) => {
      const item = event.target.closest('[data-agent]');
      if (!item) return;
      event.preventDefault();
      openTerminal(selectedSession(), formatShellParam('agent', item.getAttribute('data-agent')));
    });
  }

  const reset = byId('btn-reset-layout');
  if (reset) reset.addEventListener('click', () => resetLayout());

  const refresh = byId('btn-rail-refresh');
  if (refresh) {
    refresh.addEventListener('click', () => {
      Promise.resolve(reloadSessions()).catch((err) => toastError(err, 'Could not refresh sessions'));
    });
  }

  const select = /** @type {HTMLSelectElement|null} */ (byId('code-session-select'));
  if (select) select.addEventListener('change', () => storage.set(LS_LAST_SESSION, select.value));

  const list = byId('session-rail-list');
  if (list) {
    list.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      const button = target.closest('[data-open]');
      if (button) {
        event.preventDefault();
        openTerminal(button.getAttribute('data-session') || '', button.getAttribute('data-open') || 'bash');
        return;
      }
      const row = target.closest('.pc-rail-item');
      if (!row) return;
      const name = row.getAttribute('data-session') || '';
      const select2 = /** @type {HTMLSelectElement|null} */ (byId('code-session-select'));
      if (select2 && name) {
        select2.value = name;
        storage.set(LS_LAST_SESSION, name);
      }
    });
    list.addEventListener('dblclick', (event) => {
      const row = /** @type {HTMLElement} */ (event.target).closest('.pc-rail-item');
      if (row) openTerminal(row.getAttribute('data-session') || '', 'bash');
    });
  }
}

// ---------------------------------------------------------------------------
// view module
// ---------------------------------------------------------------------------

function showLoadFailure(err) {
  const empty = byId('code-empty');
  if (empty) {
    empty.classList.remove('d-none');
    empty.innerHTML =
      '<p class="mb-2"><i class="bi bi-exclamation-triangle display-6 text-warning"></i></p>' +
      '<p class="mb-1">The terminal workspace could not start.</p>' +
      `<p class="small mb-0">${escapeHtml((err && err.message) || String(err))}</p>`;
  }
  const status = byId('code-status');
  if (status) status.textContent = 'layout unavailable';
}

async function init(ctx) {
  if (initialised) return;
  initialised = true;
  appCtx = ctx || null;

  wireToolbar();

  railSessions = getSessions() || [];
  renderHostFilter(railSessions);
  renderRail(railSessions);
  renderSessionSelect(railSessions);
  renderAgentMenu();

  bus.on(EVENTS.SESSIONS_CHANGED, ({ sessions }) => {
    railSessions = Array.isArray(sessions) ? sessions : [];
    renderHostFilter(railSessions);
    renderRail(railSessions);
    renderSessionSelect(railSessions);
    renderAgentMenu();
  });
  // v0.2: `shell` is the wire value ('bash' | 'sh' | 'agent:<id>'); 'claude' still parses.
  bus.on(EVENTS.OPEN_TERMINAL, ({ session, shell }) => openTerminal(session, shell || 'bash'));
  // A newly installed/renamed agent must reach the menu and the tab titles without a reload.
  bus.on(EVENTS.AGENTS_CHANGED, () => renderAgentMenu());
  bus.on(EVENTS.THEME_CHANGED, ({ theme }) => {
    for (const entry of panes.values()) entry.pane.setTheme(theme);
  });
  // The server copy of the layout may land after this init() (settings.js issues its own
  // GET /api/settings). Retry the restore once, but only while the workspace is still
  // untouched, so a pane the user opened in the meantime is never thrown away.
  bus.on(EVENTS.SETTINGS_CHANGED, () => {
    if (!restorePending) return;
    restorePending = false;
    if (!layout || suspended || panes.size > 0) return;
    restoreLayout();
    resize();
  });
  bus.on(EVENTS.AUTH_LOST, () => suspendPanes());
  bus.on(EVENTS.AUTH_REQUIRED, () => suspendPanes());
  bus.on(EVENTS.AUTH_READY, () => resumePanes());
  bus.on(EVENTS.VIEW_CHANGED, ({ view }) => {
    if (view === 'code') requestAnimationFrame(() => resize());
  });
  window.addEventListener('resize', () => resizeSoon());

  const root = byId('code-root');
  if (!root) {
    showLoadFailure(new Error('#code-root is missing'));
    return;
  }

  let GoldenLayout;
  try {
    GoldenLayout = await loadGoldenLayout();
  } catch (err) {
    console.error('[code] golden-layout failed to load', err);
    showLoadFailure(err);
    return;
  }

  try {
    layout = new GoldenLayout(root);
    layout.resizeWithContainerAutomatically = false;
    layout.registerComponentFactoryFunction(COMPONENT_TERMINAL, (container, state) => {
      try {
        buildTerminalComponent(container, state);
      } catch (err) {
        console.error('[code] could not build a terminal pane', err);
      }
    });
  } catch (err) {
    console.error('[code] GoldenLayout could not be created', err);
    layout = null;
    showLoadFailure(err);
    return;
  }

  // Any structural change (tab drag, split, close, splitter, tab activation) bubbles here.
  for (const event of ['stateChanged', 'itemCreated', 'itemDestroyed', 'itemDropped', 'activeContentItemChanged']) {
    try {
      layout.on(event, () => persistSoon());
    } catch (err) {
      console.debug(`[code] cannot subscribe to ${event}`, err);
    }
  }

  // Keyboard focus follows the active tab (frontend.md section 7), but never steals it
  // while another view is on screen.
  try {
    layout.on('activeContentItemChanged', (item) => {
      const container = item && item.container;
      if (!container) return;
      const view = byId('view-code');
      if (!view || view.classList.contains('d-none')) return;
      for (const entry of panes.values()) {
        if (entry.container === container) {
          requestAnimationFrame(() => { entry.pane.fit(); entry.pane.focus(); });
          break;
        }
      }
    });
  } catch (err) {
    console.debug('[code] cannot subscribe to activeContentItemChanged', err);
  }

  restoreLayout();
  toggleEmpty();
  updateStatus();
  requestAnimationFrame(() => resize());
  // A restored layout is laid out before the view is first shown; re-fit once it is.
  setTimeout(() => resize(), 250);
}

/** @type {import('./app.js').ViewModule} */
const codeView = {
  init,
  /** GoldenLayout measures 0x0 while #view-code is display:none, so size it on show(). */
  show() {
    requestAnimationFrame(() => {
      resize();
      for (const entry of panes.values()) entry.pane.fit();
    });
  },
  /** Nothing to tear down - terminals stay connected while another tab is open. */
  hide() {},
  refresh() {
    resize();
  },
};

export default codeView;
