// OWNER: F2. Code tab: GoldenLayout 2 tabs/split panes + the container rail + layout
// persistence. F1 must not edit this file (nor #view-code markup in index.html).
//
// v0.3 vocabulary (docs/design/users.md section 0): a CONTAINER is the long-lived project
// box, a SESSION is one shell connection into it - one pane is one session. The xterm
// WIDGET inside a pane is still a terminal, which is why COMPONENT_TERMINAL keeps its name.
//
// GoldenLayout 2 is an ES module served from node_modules through /vendor (see
// server/src/vendor.ts). Its CSS is already linked in index.html.
import { api, formatShellParam, parseShellParam } from './api.js';
import { bus, EVENTS } from './bus.js';
import { byId, toast, toastError, debounce, escapeHtml, storage, LS_PREFIX } from './util.js';
import { SessionPane, makeSessionName, sessionSlug } from './session.js';
import { getContainers, reload as reloadContainers, imageOutdated } from './containers.js';
import { getSettings } from './settings.js';
import { agentLabel, agentIcon } from './agents.js';
import { getHost, hostLabel } from './hosts.js';

/** localStorage key for the layout blob (server copy lives in settings.ui.layout). FROZEN. */
export const LS_LAYOUT = `${LS_PREFIX}layout.v1`;
/** localStorage key remembering the container picked in the toolbar.
 *  The KEY STRING is FROZEN so an upgrade keeps the user's preselection. */
export const LS_LAST_CONTAINER = `${LS_PREFIX}code.session`;
/** localStorage key remembering the host filter of the rail/toolbar ('' = all hosts). */
export const LS_CODE_HOST = `${LS_PREFIX}code.host`;
/** Debounce before persisting the layout (both localStorage and PUT /api/settings/ui). */
export const LAYOUT_SAVE_MS = 1500;
/**
 * Layout blob envelope. v0.2 bumped this because PaneState changed shape
 * (`shell:'claude'` -> `shell:'agent'` + `agentId`); v0.3 bumped it again because
 * `PaneState.session` (the container) became `PaneState.container`. Older blobs are still
 * ACCEPTED and migrated in place (see migrateLayoutBlob) so an upgrade never throws a user's
 * panes away - the pane NAME is what tmux keys off, and migrating keeps it byte-identical.
 */
export const LAYOUT_VERSION = 3;
/** Blob versions restoreLayout() accepts; anything else is ignored (and dropped). */
export const ACCEPTED_LAYOUT_VERSIONS = [1, 2, 3];
/** Hard ceiling for the persisted blob - it must never contain terminal output. */
export const LAYOUT_MAX_BYTES = 64 * 1024;

/**
 * @typedef {Object} PaneState        component state stored in the GoldenLayout config
 * @property {string} container       the container this session runs in (v0.2: `session`)
 * @property {'bash'|'sh'|'agent'} shell
 * @property {string|null} agentId    set exactly when shell === 'agent'
 * @property {string} name            stable session/tmux name (makeSessionName)
 * @property {string} [hostId]        informational: the host the container lived on when the
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
/** @type {Map<string, {pane: SessionPane, container: any, state: PaneState}>} name -> pane
 *  NB `container` here is the GoldenLayout ComponentContainer, not a PorterClaude container. */
const panes = new Map();
/** @type {any} AppContext handed to init() */
let appCtx = null;
/** @type {any[]} last CONTAINERS_CHANGED payload */
let railContainers = [];
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
 * Normalise a pane state coming from an older layout blob or from openSession().
 * v0.1 wrote `shell:'claude'`; that migrates to `{shell:'agent', agentId:'claude'}`, which
 * keeps the pane NAME (`<container>-claude-<n>`) and therefore the tmux session.
 * v0.2 called the container `session`: WRITE `container`, READ EITHER, so a stored layout
 * survives the vocabulary change instead of losing every pane.
 * An `agent` state without a valid agent id (api.js AGENT_ID_RE, enforced by
 * formatShellParam/parseShellParam) is unusable and returns null - the caller either drops
 * it from the migrated tree or renders the "unusable session state" placeholder.
 * @param {any} raw @returns {PaneState|null}
 */
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // v0.2 blobs carry `session`; v0.3 writes `container`.
  const legacy = typeof raw.session === 'string' ? raw.session : '';
  const container = typeof raw.container === 'string' && raw.container ? raw.container : legacy;
  if (!container) return null;
  // parseShellParam accepts 'bash' | 'sh' | 'agent:<id>' | 'claude' (v0.1 alias)
  let wire = String(raw.shell || 'bash');
  if (raw.shell === 'agent') {
    // `shell:'agent'` alone carries no agent id: it only means anything together with one.
    if (!raw.agentId) return null;
    try {
      wire = formatShellParam('agent', raw.agentId);
    } catch {
      return null;
    }
  }
  const parsed = parseShellParam(wire);
  if (!parsed) return null;
  if (parsed.shell === 'agent' && !parsed.agentId) return null;
  let name = typeof raw.name === 'string' ? raw.name : '';
  if (!name) {
    try {
      name = makeSessionName(container, sessionSlug(parsed.shell, parsed.agentId), 1);
    } catch {
      return null;
    }
  }
  return {
    container,
    shell: parsed.shell,
    agentId: parsed.agentId,
    name,
    hostId: typeof raw.hostId === 'string' ? raw.hostId : undefined,
    title: typeof raw.title === 'string' ? raw.title : undefined,
  };
}

/**
 * Smallest free index for this container + shell SLUG, so session names stay stable across
 * reloads. The slug is the AGENT ID for agent panes (`web-claude-1`), which is exactly the
 * v0.1 name - an upgraded layout reattaches to its existing tmux sessions.
 * @param {string} container @param {string} slug sessionSlug(shell, agentId)
 */
function nextFreeName(container, slug) {
  for (let n = 1; n < 1000; n += 1) {
    const name = makeSessionName(container, slug, n);
    if (!panes.has(name)) return name;
  }
  throw new Error('too many sessions for this container');
}

/**
 * Tab title: `<container> · <agent name|shell>[ n][ mark]`, prefixed with `<host>/` while
 * panes of MORE THAN ONE host are open (`prod/web · Claude Code`). Kept short - GoldenLayout
 * tabs are narrow.
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
  return `${paneHostPrefix(state)}${state.container} · ${what}${suffix}${mark}`;
}

/** The host a pane belongs to: what `ready` reported, else what the container says. */
function paneHostId(state) {
  if (state && typeof state.hostId === 'string' && state.hostId) return state.hostId;
  const view = containerByName(state && state.container);
  return hostIdOf(view);
}

/** `"<host>/"` while panes of more than one host are open, '' otherwise. */
function paneHostPrefix(state) {
  const ids = new Set();
  for (const entry of panes.values()) ids.add(paneHostId(entry.state));
  ids.add(paneHostId(state));
  if (ids.size < 2) return '';
  const id = paneHostId(state);
  if (!id) return '';
  if (getHost(id)) return `${hostLabel(id)}/`;
  const view = railContainers.find((s) => hostIdOf(s) === id) || null;
  return `${(view && hostNameOf(view)) || id}/`;
}

/** Repaint every tab title (the host prefix depends on the whole set of open panes). */
function refreshTitles() {
  for (const entry of panes.values()) {
    try {
      entry.container.setTitle(titleFor(entry.state, entry.pane.status));
    } catch {
      /* the container is gone */
    }
  }
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

function containerByName(name) {
  return railContainers.find((s) => s && s.name === name) || null;
}

// ---------------------------------------------------------------------------
// hosts, as seen from the containers
//
// The host FACTS ride on the ContainerView (`hostId`, `hostName`, `hostMissing`); the display
// NAME is taken from the hosts cache instead (hosts.js -> hostLabel), because `hostName` is
// only as consistent as the row that carried it - an adopted/orphan row can name the host
// that scanned it rather than the host its id points at, which labelled every rail group,
// filter option and tab prefix identically (FE-QA-06). `hostName` stays the fallback for a
// host the cache does not know (deleted with force, or a pre-v0.2 payload).
// Importing hosts.js closes no cycle: it imports api/bus/util/settings only.
// Which host is the default one - so its rail group comes first - still comes from the
// settings summary (`settings.hosts.defaultHostId`) and the `hosts:changed` bus event.
// ---------------------------------------------------------------------------

/** @type {string} last `hosts:changed` defaultHostId ('' = unknown) */
let defaultHostIdHint = '';

/** @returns {string} the default host id, '' when it cannot be told */
function currentDefaultHostId() {
  if (defaultHostIdHint) return defaultHostIdHint;
  for (const settings of settingsSources()) {
    const hosts = settings && settings.hosts;
    if (hosts && typeof hosts.defaultHostId === 'string' && hosts.defaultHostId) {
      return hosts.defaultHostId;
    }
  }
  return '';
}

/** @param {any} container @returns {string} '' when the server did not say (pre-v0.2 payload) */
function hostIdOf(container) {
  return container && typeof container.hostId === 'string' ? container.hostId : '';
}

/** @param {any} container @returns {string} the host's display name, never '' */
function hostNameOf(container) {
  const id = hostIdOf(container);
  // the hosts cache is authoritative; ContainerView.hostName is the fallback for hosts it
  // does not know any more (see the note above)
  if (id && getHost(id)) return hostLabel(id);
  if (container && typeof container.hostName === 'string' && container.hostName) return container.hostName;
  return id || 'unknown host';
}

/**
 * @typedef {Object} HostGroup
 * @property {string} id       hostId ('' when the payload carries none)
 * @property {string} name     display name
 * @property {boolean} missing the host was deleted with force=1 (ContainerView.hostMissing)
 * @property {any[]} containers
 */

/**
 * The distinct hosts present in `containers`: the default host first, then by name; hosts
 * that no longer exist last. Container order inside a group is the order containers.js
 * delivered.
 * @param {any[]} containers @returns {HostGroup[]}
 */
function hostGroups(containers) {
  /** @type {Map<string, HostGroup>} */
  const map = new Map();
  for (const container of Array.isArray(containers) ? containers : []) {
    if (!container) continue;
    const id = hostIdOf(container);
    let group = map.get(id);
    if (!group) {
      group = { id, name: hostNameOf(container), missing: container.hostMissing === true, containers: [] };
      map.set(id, group);
    }
    if (container.hostMissing === true) group.missing = true;
    group.containers.push(container);
  }
  const dflt = currentDefaultHostId();
  return [...map.values()].sort((a, b) => {
    if (a.missing !== b.missing) return a.missing ? 1 : -1;
    if (!a.missing && dflt && a.id !== b.id) {
      if (a.id === dflt) return -1;
      if (b.id === dflt) return 1;
    }
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

/** The containers the rail/select currently show (the host filter narrows them). */
function filteredContainers(containers) {
  const items = Array.isArray(containers) ? containers : [];
  const host = codeHostFilter();
  if (!host) return items;
  return items.filter((s) => hostIdOf(s) === host);
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
  bus.emit(EVENTS.SESSIONS_CHANGED, { count: panes.size });
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
 * Never stores terminal output - only the component state (container/shell/name).
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
 * Migrate one item of a (possibly v1) layout tree.
 *
 * Every `componentState` goes through normalizeState(), i.e. v0.1's `shell:'claude'` becomes
 * `{shell:'agent', agentId:'claude'}` while `name` is left BYTE-IDENTICAL - the name is the
 * tmux identity (`pc_<name>`), so an upgraded browser reattaches to the shells that are
 * already running instead of spawning new ones.
 *
 * A component whose state does not normalise is dropped, and so is a container that is left
 * without any content by that (GoldenLayout renders an empty stack as a dead tab bar).
 * @param {any} item @returns {any|null} the same object, or null when it must be dropped
 */
function migrateLayoutItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(item, 'componentState')) {
    // Only our own component carries a PaneState; anything else is passed through untouched.
    const type = item.componentType ?? item.componentName;
    if (type === undefined || type === COMPONENT_TERMINAL) {
      const state = normalizeState(item.componentState);
      if (!state) return null;
      item.componentState = state;
    }
  }
  if (Array.isArray(item.content)) {
    const had = item.content.length;
    item.content = item.content
      .map((child) => migrateLayoutItem(child))
      .filter((child) => child !== null);
    if (had > 0 && item.content.length === 0) return null;
  }
  return item;
}

/**
 * Migrate an older layout blob to LAYOUT_VERSION in place (see {@link migrateLayoutItem}) and
 * stamp the new version. Returns null when nothing survived - the caller then treats the blob
 * as absent. Migrating a current blob is a no-op, so this is safe to run more than once.
 * @param {LayoutBlob} blob
 * @returns {LayoutBlob|null}
 */
export function migrateLayoutBlob(blob) {
  if (!blob || typeof blob !== 'object' || !blob.root || typeof blob.root !== 'object') return null;
  const root = migrateLayoutItem(blob.root.root);
  if (!root) return null;
  blob.root.root = root;
  blob.v = LAYOUT_VERSION;
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

/**
 * GoldenLayout component factory for the single 'terminal' component (the componentType is
 * FROZEN: it is persisted verbatim in every saved layout, and it names the xterm widget).
 * `container` is the GoldenLayout ComponentContainer, NOT a PorterClaude container.
 */
function buildSessionComponent(container, rawState) {
  const state = normalizeState(rawState);
  if (!state) {
    container.element.innerHTML =
      '<div class="pc-pane pc-pane-broken p-3 small text-danger">Unusable session state - close this pane.</div>';
    return;
  }
  // A restored layout may contain a duplicate name (e.g. two blobs merged): keep names unique
  // because they are the tmux identity.
  if (panes.has(state.name)) {
    state.name = nextFreeName(state.container, sessionSlug(state.shell, state.agentId));
  }

  const root = document.createElement('div');
  root.className = 'pc-pane';
  container.element.appendChild(root);

  const pane = new SessionPane({
    container: state.container,
    shell: state.shell,
    agentId: state.agentId ?? null,
    // agents.js owns the display names; session.js only needs the one of THIS pane (for the
    // 4410 note), which keeps it free of an import of its own.
    agentName: state.shell === 'agent' ? agentLabel(state.agentId) : null,
    name: state.name,
    theme: currentTheme(),
    // 4410 agent_not_available: the pane offers "Open bash instead" and calls this.
    onOpenBash: () => openSession(state.container, 'bash'),
    onStatus: (status, info) => {
      // The server is authoritative about where the container runs and which agent it started
      // (api.md `ready`): remember both, they drive the host prefix of the tab titles.
      let changed = false;
      if (info && typeof info.hostId === 'string' && info.hostId && info.hostId !== state.hostId) {
        state.hostId = info.hostId;
        changed = true;
      }
      if (info && state.shell === 'agent' && typeof info.agentId === 'string'
          && info.agentId && info.agentId !== state.agentId) {
        state.agentId = info.agentId;
        changed = true;
      }
      try { container.setTitle(titleFor(state, status)); } catch { /* container gone */ }
      if (changed) {
        refreshTitles();
        persistSoon();
      }
      updateStatus();
    },
    onTitle: (title) => { root.title = title; },
    onRequestClose: () => {
      try { container.close(); } catch (err) { console.debug('[code] close failed', err); }
    },
  });

  panes.set(state.name, { pane, container, state });
  container.setTitle(titleFor(state, 'connecting'));
  // This pane may be the second host on screen: every other title needs its prefix now.
  refreshTitles();
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
    // The last pane of a host may have gone: the remaining titles lose their host prefix.
    refreshTitles();
    toggleEmpty();
    updateStatus();
    persistSoon();
  });

  toggleEmpty();
  updateStatus();
  fitSoon();
}

/**
 * Open a new session (pane) in `container`.
 * A stopped container is started first (best effort); the pane itself shows a "start
 * container" action when the server answers 4409.
 *
 * v0.2: `shellParam` is the WIRE value - 'bash' | 'sh' | 'agent:<agentId>' (api.js
 * formatShellParam). The legacy 'claude' is accepted (parseShellParam maps it) so an old
 * bookmark/bus payload still works. An agent that is not in the container's `resolvedAgents`
 * must NOT be opened: toast "<agent> is not mounted into <container> - enable it on the host
 * and recreate the container" and return (the server would close 4410 anyway).
 * @param {string} container @param {string} shellParam
 */
export function openSession(container, shellParam) {
  if (!container) {
    toast('Pick a container first.', { variant: 'warning' });
    return;
  }
  if (!layout) {
    toast('The session layout could not be loaded.', { variant: 'danger' });
    return;
  }
  const parsed = parseShellParam(shellParam) || { shell: 'bash', agentId: null };
  const wanted = parsed.shell;
  const agentId = parsed.agentId;
  const view = containerByName(container);
  if (view && view.hostMissing === true) {
    toast(
      `The host of "${container}" no longer exists — recreate the container on a host that does.`,
      { variant: 'warning', title: 'Host gone' },
    );
    return;
  }
  // Refuse an agent this container does not mount: the server would close 4410 and the pane
  // would only be able to repeat the reason - saying it here can name the fix instead.
  if (wanted === 'agent' && view && Array.isArray(view.resolvedAgents)
      && !view.resolvedAgents.includes(agentId)) {
    toast(
      `"${agentLabel(agentId)}" is not mounted into "${container}" — enable it on the host ` +
      '(Settings → Agents), run "Sync tools", then recreate the container.',
      { variant: 'warning', title: 'Agent not available' },
    );
    return;
  }
  if (view && view.status !== 'running') {
    toast(`Container "${container}" is not running - starting it…`, { variant: 'info' });
    api.containers
      .start(container)
      .then(() => reloadContainers())
      .catch((err) => toastError(err, `Could not start "${container}"`));
  }

  let name;
  try {
    name = nextFreeName(container, sessionSlug(wanted, agentId));
  } catch (err) {
    toastError(err, 'Could not name the session');
    return;
  }
  // The user is building a layout now - stop waiting for a server copy to arrive.
  restorePending = false;
  /** @type {PaneState} */
  const state = {
    container,
    shell: wanted,
    agentId,
    name,
    ...(view && view.hostId ? { hostId: view.hostId } : {}),
  };
  try {
    layout.addComponent(COMPONENT_TERMINAL, state, titleFor(state, 'connecting'));
  } catch (err) {
    console.error('[code] addComponent failed', err);
    toastError(err, 'Could not open the session');
    return;
  }
  toggleEmpty();
  resize();
  persist();
  const entry = panes.get(name);
  if (entry) requestAnimationFrame(() => entry.pane.focus());
}

// ---------------------------------------------------------------------------
// container rail + session toolbar
// ---------------------------------------------------------------------------

/**
 * The host filter of the rail/toolbar ('' = all hosts). Persisted in LS_CODE_HOST.
 * @returns {string}
 */
function codeHostFilter() {
  return storage.get(LS_CODE_HOST, '') || '';
}

/**
 * Fill #code-host-filter with one option per DISTINCT host present in `containers` (label =
 * `hostName`), behind a leading "All hosts" option. The select is HIDDEN while only one host
 * is present - a single-host install has to look exactly like v0.1.
 * The stored choice is dropped as soon as that host has no containers any more.
 * @param {any[]} containers the UNFILTERED rail containers
 */
function renderHostFilter(containers) {
  const select = /** @type {HTMLSelectElement|null} */ (byId('code-host-filter'));
  if (!select) return;
  const groups = hostGroups(containers).filter((g) => g.id);
  const multi = groups.length > 1;
  select.classList.toggle('d-none', !multi);
  if (!multi) {
    select.textContent = '';
    if (codeHostFilter()) storage.set(LS_CODE_HOST, '');
    return;
  }
  let wanted = codeHostFilter();
  if (wanted && !groups.some((g) => g.id === wanted)) {
    wanted = '';
    storage.set(LS_CODE_HOST, '');
  }
  select.textContent = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All hosts';
  select.appendChild(all);
  for (const group of groups) {
    const opt = document.createElement('option');
    opt.value = group.id;
    opt.textContent = group.missing ? `${group.name} (host gone)` : group.name;
    select.appendChild(opt);
  }
  select.value = wanted;
}

/**
 * One `.pc-rail-item` row. All API strings are HTML-escaped.
 * Quick actions: open a bash session, or one running the container's FIRST resolved agent
 * (`data-open="agent:<id>"`); a container without an agent shows bash only, one whose host is
 * gone shows both disabled.
 * @param {any} s ContainerView
 */
function railItemHtml(s) {
  const name = escapeHtml(s.name);
  const stopped = s.status !== 'running';
  const missing = s.hostMissing === true;
  // INT-01: never show the raw image id here - only whether a newer build is waiting.
  const stale = imageOutdated(s);
  const title = escapeHtml(
    `${s.name} - ${s.status}${s.displayName ? ` (${s.displayName})` : ''}` +
    (missing ? ' - the host of this container no longer exists' : '') +
    (stale ? ' - image updated, recreate to pick it up' : ''),
  );
  const staleIcon = stale
    ? '<i class="bi bi-arrow-repeat text-warning ms-1" title="image updated \u2014 recreate the container to pick it up" aria-label="image updated - recreate"></i>'
    : '';
  const missingIcon = missing
    ? '<i class="bi bi-exclamation-triangle text-danger ms-1" title="the host of this container no longer exists" aria-label="host gone"></i>'
    : '';
  const disabled = missing ? ' disabled' : '';
  const agentId = firstAgentOf(s);
  const agentButton = agentId
    ? `<button type="button" class="btn btn-sm btn-link p-0 ms-1"${disabled} data-open="${escapeHtml(formatShellParam('agent', agentId))}" data-container="${name}" title="Open ${escapeHtml(agentLabel(agentId))}" aria-label="Open ${escapeHtml(agentLabel(agentId))} in ${name}"><i class="bi ${escapeHtml(agentIcon(agentId))}"></i></button>`
    : '';
  return (
    `<div class="pc-rail-item${stopped ? ' is-stopped' : ''}${missing ? ' is-missing' : ''}" data-container="${name}" title="${title}">` +
    `<span class="pc-dot ${dotClass(s.status)}"></span>` +
    `<span class="pc-rail-name text-truncate flex-grow-1">${name}${staleIcon}${missingIcon}</span>` +
    '<span class="pc-rail-actions">' +
    `<button type="button" class="btn btn-sm btn-link p-0"${disabled} data-open="bash" data-container="${name}" title="Open bash" aria-label="Open bash in ${name}"><i class="bi bi-terminal"></i></button>` +
    `${agentButton}</span></div>`
  );
}

/**
 * The agent a rail row offers as its quick action: the container's FIRST resolved agent.
 * @param {any} s ContainerView @returns {string} '' when the container mounts none
 */
function firstAgentOf(s) {
  const list = s && Array.isArray(s.resolvedAgents) ? s.resolvedAgents : [];
  const id = list.find((a) => typeof a === 'string' && a);
  return id || '';
}

/**
 * Paint #container-rail-list, grouped by host.
 *
 * With more than one host, every host gets a `.pc-rail-group[data-host]` with a
 * `.pc-rail-group-head` (host name + container count), the default host first, the rest by name
 * and a deleted host ("host gone") last. With exactly ONE host the flat v0.1 list is rendered
 * - no group header at all, so a single-host install is visually identical to v0.1.
 * @param {any[]} containers the UNFILTERED rail containers (#code-host-filter is applied here)
 */
function renderRail(containers) {
  const list = byId('container-rail-list');
  if (!list) return;
  const all = Array.isArray(containers) ? containers : [];
  if (!all.length) {
    list.innerHTML =
      '<div class="p-2 small text-secondary">No containers yet. Create one in the <a href="#/containers">Containers</a> tab.</div>';
    return;
  }
  const grouped = hostGroups(all).length > 1;
  const items = filteredContainers(all);
  if (!items.length) {
    list.innerHTML =
      '<div class="p-2 small text-secondary">No containers on this host. Pick <em>All hosts</em> above to see the others.</div>';
    return;
  }
  if (!grouped) {
    list.innerHTML = items.map((s) => railItemHtml(s)).join('');
    return;
  }
  list.innerHTML = hostGroups(items)
    .map((group) => {
      const count = group.containers.length;
      return (
        `<div class="pc-rail-group${group.missing ? ' is-missing' : ''}" data-host="${escapeHtml(group.id)}">` +
        '<div class="pc-rail-group-head">' +
        `<span class="pc-rail-group-name text-truncate">${escapeHtml(group.name)}</span>` +
        (group.missing ? '<span class="pc-rail-group-gone">host gone</span>' : '') +
        `<span class="pc-rail-group-count">${count}</span>` +
        '</div>' +
        group.containers.map((s) => railItemHtml(s)).join('') +
        '</div>'
      );
    })
    .join('');
}

/**
 * Mirror the containers into #code-container-select (running first, remembering the choice).
 * The host filter narrows it exactly like the rail, and with more than one host the option
 * label becomes `<container> — <hostName>` so two hosts with similar container names stay
 * tellable apart. The agent menu belongs to the selected container, so it is rebuilt too.
 * @param {any[]} containers the UNFILTERED rail containers
 */
function renderContainerSelect(containers) {
  const select = /** @type {HTMLSelectElement|null} */ (byId('code-container-select'));
  if (!select) return;
  const multiHost = hostGroups(containers).length > 1;
  const items = filteredContainers(containers).slice().sort((a, b) => {
    const ar = a.status === 'running' ? 0 : 1;
    const br = b.status === 'running' ? 0 : 1;
    if (ar !== br) return ar - br;
    return String(a.name).localeCompare(String(b.name));
  });
  const previous = select.value || storage.get(LS_LAST_CONTAINER, '') || '';
  select.textContent = '';
  if (!items.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'no containers';
    select.appendChild(opt);
    select.disabled = true;
    renderAgentMenu();
    return;
  }
  select.disabled = false;
  for (const s of items) {
    const opt = document.createElement('option');
    opt.value = s.name;
    const host = multiHost ? ` — ${hostNameOf(s)}` : '';
    opt.textContent = `${s.name}${host}${s.status === 'running' ? '' : ` (${s.status})`}`;
    select.appendChild(opt);
  }
  const wanted = items.some((s) => s.name === previous) ? previous : items[0].name;
  select.value = wanted;
  storage.set(LS_LAST_CONTAINER, wanted);
  renderAgentMenu();
}

/**
 * Fill #new-agent-menu from the SELECTED container's `resolvedAgents` - one
 * `<button class="dropdown-item" data-agent="<id>">` per agent, with its icon and display
 * name. A container that mounts none shows a disabled note plus a link to Settings → Agents;
 * with no container at all #btn-new-agent is disabled.
 * Rebuilt on CONTAINERS_CHANGED, AGENTS_CHANGED and on every #code-container-select change -
 * that is what makes a freshly synced agent appear without a reload.
 */
function renderAgentMenu() {
  const menu = byId('new-agent-menu');
  const button = /** @type {HTMLButtonElement|null} */ (byId('btn-new-agent'));
  if (!menu) return;
  const name = selectedContainer();
  const container = name ? containerByName(name) : null;
  const agents = container && Array.isArray(container.resolvedAgents)
    ? container.resolvedAgents.filter((id) => typeof id === 'string' && id)
    : [];
  if (button) button.disabled = !name;
  if (!name) {
    menu.innerHTML =
      '<li><span class="dropdown-item disabled">no container selected</span></li>';
    return;
  }
  if (!agents.length) {
    menu.innerHTML =
      '<li><span class="dropdown-item disabled">no coding agent in this container</span></li>' +
      '<li><hr class="dropdown-divider"></li>' +
      '<li><a class="dropdown-item" href="#/settings">Enable one under Settings → Agents</a></li>';
    return;
  }
  menu.innerHTML = agents
    .map((id) => (
      '<li><button class="dropdown-item" type="button" ' +
      `data-agent="${escapeHtml(id)}">` +
      `<i class="bi ${escapeHtml(agentIcon(id))} me-2"></i>${escapeHtml(agentLabel(id))}` +
      '</button></li>'
    ))
    .join('');
}

/**
 * The container new sessions open on: the picked option, else the remembered one, else
 * the first running container - always one the host filter actually shows.
 * @returns {string} '' when no container is visible at all
 */
function selectedContainer() {
  const select = /** @type {HTMLSelectElement|null} */ (byId('code-container-select'));
  const visible = filteredContainers(railContainers);
  if (!visible.length) return '';
  for (const candidate of [select && !select.disabled ? select.value : '', storage.get(LS_LAST_CONTAINER, '')]) {
    if (candidate && visible.some((s) => s.name === candidate)) return candidate;
  }
  return (visible.find((s) => s.status === 'running') || visible[0] || {}).name || '';
}

function wireToolbar() {
  const openFrom = (shellParam) => () => openSession(selectedContainer(), shellParam);
  const bash = byId('btn-new-bash');
  if (bash) bash.addEventListener('click', openFrom('bash'));
  const sh = byId('btn-new-sh');
  if (sh) sh.addEventListener('click', openFrom('sh'));

  // #new-agent-menu is rebuilt on every change, so its items are handled by delegation.
  const agentMenu = byId('new-agent-menu');
  if (agentMenu) {
    agentMenu.addEventListener('click', (event) => {
      const item = event.target.closest('[data-agent]');
      if (!item) return;
      event.preventDefault();
      const id = item.getAttribute('data-agent') || '';
      let wire;
      try {
        wire = formatShellParam('agent', id);
      } catch (err) {
        toastError(err, 'Unusable agent id');
        return;
      }
      openSession(selectedContainer(), wire);
    });
  }

  const hostFilter = /** @type {HTMLSelectElement|null} */ (byId('code-host-filter'));
  if (hostFilter) {
    hostFilter.addEventListener('change', () => {
      storage.set(LS_CODE_HOST, hostFilter.value || '');
      renderRail(railContainers);
      renderContainerSelect(railContainers);
    });
  }

  const reset = byId('btn-reset-layout');
  if (reset) reset.addEventListener('click', () => resetLayout());

  const refresh = byId('btn-rail-refresh');
  if (refresh) {
    refresh.addEventListener('click', () => {
      Promise.resolve(reloadContainers()).catch((err) => toastError(err, 'Could not refresh containers'));
    });
  }

  const select = /** @type {HTMLSelectElement|null} */ (byId('code-container-select'));
  if (select) {
    select.addEventListener('change', () => {
      storage.set(LS_LAST_CONTAINER, select.value);
      // the Agent dropdown belongs to the SELECTED container
      renderAgentMenu();
    });
  }

  const list = byId('container-rail-list');
  if (list) {
    list.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      const button = target.closest('[data-open]');
      if (button) {
        event.preventDefault();
        openSession(button.getAttribute('data-container') || '', button.getAttribute('data-open') || 'bash');
        return;
      }
      const row = target.closest('.pc-rail-item');
      if (!row) return;
      const name = row.getAttribute('data-container') || '';
      const select2 = /** @type {HTMLSelectElement|null} */ (byId('code-container-select'));
      if (select2 && name) {
        select2.value = name;
        storage.set(LS_LAST_CONTAINER, name);
        renderAgentMenu();
      }
    });
    list.addEventListener('dblclick', (event) => {
      const row = /** @type {HTMLElement} */ (event.target).closest('.pc-rail-item');
      if (row) openSession(row.getAttribute('data-container') || '', 'bash');
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
      '<p class="mb-1">The session workspace could not start.</p>' +
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

  railContainers = getContainers() || [];
  renderHostFilter(railContainers);
  renderRail(railContainers);
  renderContainerSelect(railContainers);
  renderAgentMenu();

  bus.on(EVENTS.CONTAINERS_CHANGED, ({ containers }) => {
    railContainers = Array.isArray(containers) ? containers : [];
    renderHostFilter(railContainers);
    renderRail(railContainers);
    renderContainerSelect(railContainers);
    renderAgentMenu();
    // a container may just have learned its host name -> the tab prefixes change with it
    refreshTitles();
  });
  // Which host is the DEFAULT one only decides the order of the rail groups; hosts.js is
  // never imported (see "hosts, as seen from the containers" above).
  bus.on(EVENTS.HOSTS_CHANGED, ({ defaultHostId }) => {
    defaultHostIdHint = typeof defaultHostId === 'string' ? defaultHostId : '';
    renderHostFilter(railContainers);
    renderRail(railContainers);
    renderContainerSelect(railContainers);
    refreshTitles(); // the tab prefix is a host NAME from the cache (FE-QA-06)
  });
  // v0.2: `shell` is the wire value ('bash' | 'sh' | 'agent:<id>'); 'claude' still parses.
  bus.on(EVENTS.OPEN_SESSION, ({ container, shell }) => openSession(container, shell || 'bash'));
  // A newly installed/renamed agent must reach the menu and the tab titles without a reload.
  bus.on(EVENTS.AGENTS_CHANGED, () => {
    renderRail(railContainers);
    renderAgentMenu();
    // open panes keep the label they were built with; refresh it for their 4410 note
    for (const entry of panes.values()) {
      if (entry.state.shell === 'agent') entry.pane.agentName = agentLabel(entry.state.agentId);
    }
    refreshTitles();
  });
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
        buildSessionComponent(container, state);
      } catch (err) {
        console.error('[code] could not build a session pane', err);
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
  /** Nothing to tear down - sessions stay connected while another tab is open. */
  hide() {},
  refresh() {
    resize();
  },
};

export default codeView;
