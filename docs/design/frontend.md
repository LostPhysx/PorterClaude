# PorterClaude — frontend design (`web/`)

Companion to [`api.md`](api.md) (the wire contract, authoritative) and
[`backend.md`](backend.md). This doc is the internal design of the browser UI: module map,
DOM contract, layout/terminal mechanics, error handling and how QA verifies it.

Planner-owned. Coders implement the stubs; they do not restructure this doc. Anything that
would change a **FROZEN** name here is a cross-package change → raise it, don't just edit.

Deviations from `PLAN.md` (approved by the product owner): **no React, no Vite, no bundler**;
plain ES modules + Bootstrap 5.3 + jQuery 3 + xterm.js 5; **GoldenLayout 2 replaces dockview**
(dockview only ships as a bundler-first React/vanilla package; GoldenLayout 2 ships a ready
ESM bundle + CSS in `dist/`, has no runtime deps, and does tabs + drag-to-split + serialisable
layout state, which is exactly the feature set we need).

---

## 1. Ground rules

* **No build step.** `web/public/**` is served verbatim by Express (`WEB_DIR`, default
  `<repo>/web/public`). Our own code is ES modules loaded through
  `<script type="module" src="/js/app.js">`; the module graph is resolved by the browser.
* **No bare import specifiers.** A browser cannot resolve `import 'golden-layout'`. Vendor
  code is reached either as a global (classic `<script>`) or by an absolute `/vendor/...`
  URL. `web/tools/verify-assets.mjs` fails the build if a bare specifier sneaks in.
* **jQuery is the DOM/ajax toolkit** (`$`), Bootstrap 5.3 the component library
  (`bootstrap.Modal`, `bootstrap.Toast`, `bootstrap.Tab`) — both are globals.
* **No inline `<script>` with app logic** in `index.html`; the server sets a CSP-friendly
  posture and everything belongs in `/js/*.js`.
* Every string that comes from the API (session names, image refs, docker output, error
  messages) is HTML-escaped via `util.escapeHtml` before it touches `innerHTML`, or is set
  with `.text()`. Terminal bytes go into xterm, never into the DOM.
* Theme: `<html data-bs-theme="dark">` by default; `auto` follows
  `matchMedia('(prefers-color-scheme: dark)')`. The chosen theme is persisted server-side
  (`PUT /api/settings/ui {theme}`) so it follows the operator across browsers.

### 1.1 Lint prerequisite (cross-topic ask)

`eslint.config.js` (backend-owned, B1) currently declares only
`{window, document, console, fetch, $, WebSocket, localStorage}` as browser globals for
`web/**/*.js`, so `eslint:recommended`'s `no-undef` will flag `setTimeout`, `location`,
`URLSearchParams`, `TextEncoder`, `requestAnimationFrame`, `matchMedia`, `navigator`,
`bootstrap`, `Terminal`, `FitAddon`, `WebLinksAddon`. B1 must extend that globals map with:

```
sessionStorage, location, navigator, history, setTimeout, clearTimeout, setInterval,
clearInterval, requestAnimationFrame, cancelAnimationFrame, matchMedia, URL,
URLSearchParams, TextEncoder, TextDecoder, CustomEvent, Event, HTMLElement, Blob,
jQuery, bootstrap, Terminal, FitAddon, WebLinksAddon
```

Until that lands, files that use vendor globals carry a `/* global ... */` pragma
(`terminal.js` already does). Coders must not edit `eslint.config.js` themselves.

## 2. npm dependencies and the `/vendor` map

`web/package.json` (workspace `@porterclaude/web`, `"type": "module"`, no build script)
declares exactly these runtime deps:

| package | version | why |
|---|---|---|
| `bootstrap` | ^5.3.3 | layout, navbar, modals, toasts, forms |
| `bootstrap-icons` | ^1.11.3 | icon font |
| `jquery` | ^3.7.1 | DOM + `$.ajax` |
| `@xterm/xterm` | ^5.5.0 | terminals |
| `@xterm/addon-fit` | ^0.10.0 | cols/rows from the pane size |
| `@xterm/addon-web-links` | ^0.11.0 | clickable URLs in output |
| `golden-layout` | ^2.6.0 | tabs + drag-to-split panes + serialisable layout |

**Route → dist-dir map (must match `VENDOR_ROUTES` in `server/src/vendor.ts` exactly):**

| URL prefix | `node_modules/…` |
|---|---|
| `/vendor/bootstrap` | `bootstrap/dist` |
| `/vendor/bootstrap-icons` | `bootstrap-icons/font` |
| `/vendor/jquery` | `jquery/dist` |
| `/vendor/xterm` | `@xterm/xterm` |
| `/vendor/xterm-addon-fit` | `@xterm/addon-fit/lib` |
| `/vendor/xterm-addon-web-links` | `@xterm/addon-web-links/lib` |
| `/vendor/golden-layout` | `golden-layout/dist` |

Concrete URLs used by `index.html` / `code.js`:

```
/vendor/bootstrap/css/bootstrap.min.css
/vendor/bootstrap/js/bootstrap.bundle.min.js          -> window.bootstrap
/vendor/bootstrap-icons/bootstrap-icons.css           (fonts resolve relatively)
/vendor/jquery/jquery.min.js                          -> window.$ , window.jQuery
/vendor/xterm/css/xterm.css
/vendor/xterm/lib/xterm.js                            -> window.Terminal
/vendor/xterm-addon-fit/addon-fit.js                  -> window.FitAddon.FitAddon
/vendor/xterm-addon-web-links/addon-web-links.js      -> window.WebLinksAddon.WebLinksAddon
/vendor/golden-layout/css/goldenlayout-base.css
/vendor/golden-layout/css/themes/goldenlayout-dark-theme.css
/vendor/golden-layout/esm/index.js                    -> ESM `import { GoldenLayout }`
```

Loading strategy, and why it is mixed:

* jQuery, Bootstrap, xterm and the two xterm addons are loaded as **classic scripts** in
  `<head>`-order at the top of `<body>`, i.e. as globals. They are UMD builds that are
  guaranteed to exist in the published tarballs, and classic scripts run before the
  `type="module"` entry, so `app.js` can rely on them synchronously.
* GoldenLayout is imported as an **ES module** from `/vendor/golden-layout/esm/index.js`
  (it is dependency-free, so the browser needs no resolver). Its internal specifiers are
  extensionless (`export * from './ts/config/config'`), which is why the vendor mounts pass
  `extensions: ['js']` to `express.static` — see `server/src/vendor.ts`.
* **Corrected 2026-08-16 (B1/F1/F2):** golden-layout 2.6.0 publishes no `dist/bundle/` at
  all, so neither `bundle/esm/golden-layout.js` nor the `bundle/umd` "UMD twin" fallback
  named by earlier revisions of this doc exists; @xterm 5.5 likewise publishes UMD `.js`
  only, with no `.mjs` twins. Verify a vendor path with `GET /api/settings/vendor` and
  `web/tools/verify-assets.mjs` after `npm install`. Switching a path is a one-line change in
  `index.html` (F1) or `code.js` (F2) — it is **not** a reason to add a `VENDOR_ROUTES`
  entry. Adding a *new library* is: it needs `web/package.json` **and** a backend-owned
  `VENDOR_ROUTES` entry.

## 3. Module map

```
web/
  package.json                      F1   deps only, script: verify
  tools/verify-assets.mjs           F1   headless smoke test (planner-authored, complete)
  public/
    index.html                      F1   shell, navbar, all views + modals (DOM contract)
    favicon.svg                     F1
    css/app.css                     F1   shell/navbar/tables/modals/toasts
    css/code.css                    F2   rail, GoldenLayout container, xterm panes
    js/bus.js                       F1   FROZEN, complete: pub/sub + EVENTS (nobody edits)
    js/api.js                       F1   $.ajax wrapper, ApiError, full endpoint surface,
                                         terminalWsUrl() (complete)
    js/util.js                      F1   escapeHtml, toast, confirmDialog, fmt*, debounce, storage
    js/app.js                       F1   boot, auth gate, hash routing, theme, view lifecycle
    js/sessions.js                  F1   Sessions tab (table, modal, actions, logs)
    js/settings.js                  F1   Settings tab (backend / general / account)
    js/images.js                    F1   Settings → Images sub-panel (recipes, jobs, tools)
    js/code.js                      F2   Code tab: GoldenLayout, rail, layout persistence
    js/terminal.js                  F2   TerminalPane: xterm + websocket + reconnect
```

**Ownership is file-level and disjoint.** F1 never opens `code.js` / `terminal.js` /
`code.css`; F2 never opens anything else. The only coupling is through:

1. exported function signatures in `api.js` / `util.js` / `sessions.js` / `settings.js`
   (marked FROZEN in the stubs — F1 implements the bodies, F2 only calls them),
2. the event bus (`bus.js`, complete — neither coder edits it),
3. the DOM ids in `index.html` (§4),
4. the `ViewModule` lifecycle interface (§5.1).

### 3.1 Module graph (no cycles)

```
app.js ──▶ api.js ──▶ bus.js
   │  ├──▶ util.js
   │  ├──▶ sessions.js ──▶ api/util/bus
   │  ├──▶ settings.js ──▶ images.js ──▶ api/util
   │  └──▶ code.js  ──▶ terminal.js ──▶ api (terminalWsUrl) + bus
   │                └──▶ sessions.js (getSessions), settings.js (getSettings)
```

`code.js` reads *state* from F1 modules through two frozen getters and otherwise reacts to
bus events; F1 modules never import `code.js` (only `app.js` does, to run its lifecycle).

## 4. DOM contract (`index.html`)

Ids may be **added**, never renamed or removed. F1 owns the file but must leave the
`#view-code` subtree structurally intact.

**Shell / routing**

| id | purpose | used by |
|---|---|---|
| `#app-navbar`, `#main-tabs` | top bar | F1 |
| `#nav-code`, `#nav-sessions`, `#nav-settings` | tab links (`href="#/code"`, …, `data-view=`) | F1 |
| `#backend-badge` | active backend chip (`socket` / `portainer` / `not configured`) | F1 |
| `#btn-logout` | logout | F1 |
| `#app-shell` | wrapper, `d-none` until authenticated | F1 |
| `#view-code`, `#view-sessions`, `#view-settings` | `.pc-view`, exactly one visible | F1 toggles |
| `#toast-area` | Bootstrap toast container | `util.toast` |
| `#login-modal`, `#login-form`, `#login-password`, `#login-error`, `#login-setup-hint` | auth | F1 |
| `#confirm-modal`, `#confirm-title`, `#confirm-body`, `#confirm-ok` | `util.confirmDialog` | F1 |

**Code tab (behaviour = F2, markup frozen)**

| id | purpose |
|---|---|
| `#session-rail`, `#session-rail-list` | left rail; F2 renders `.pc-rail-item` rows |
| `#btn-rail-refresh` | force `sessions.reload()` (F2 calls the F1 module) |
| `#btn-reset-layout` | drop the saved layout, close all panes |
| `#code-toolbar`, `#code-session-select` | target session for new terminals |
| `#btn-new-bash`, `#btn-new-claude`, `#btn-new-sh` | open a pane with that shell |
| `#code-status` | connection summary ("3 panes · 1 reconnecting") |
| `#code-root` | **GoldenLayout mount point** — must stay empty and sized |
| `#code-empty` | empty-state overlay, toggled by F2 |

**Sessions tab (F1)**: `#sessions-table` / `#sessions-tbody` / `#sessions-empty` /
`#sessions-alert`, buttons `#btn-session-new`, `#btn-sessions-refresh`, `#btn-reconcile`;
modals `#session-modal` (+ `#session-form`, `#session-form-body`, `#session-modal-title`,
`#btn-session-save`, `#session-form-error`) and `#logs-modal` (+ `#logs-body`, `#logs-tail`,
`#btn-logs-refresh`).

**Settings tab (F1)**: `#settings-subtabs` with `.pc-subview[data-subtab]` panes
`backend | general | images | account`; `#backend-form` (+ `#backend-kind-socket`,
`#backend-kind-portainer`, `#backend-socket-fields`, `#socket-path`,
`#backend-portainer-fields`, `#portainer-url`, `#portainer-api-key`, `#portainer-key-hint`,
`#portainer-endpoint`, `#portainer-insecure`, `#btn-backend-test`, `#btn-backend-save`,
`#backend-test-result`, `#socket-available-hint`); `#general-form`; images panel
(`#recipes-list`, `#tools-status`, `#btn-tools-sync`, `#btn-images-refresh`, `#jobs-list`,
`#job-modal`, `#job-body`, `#btn-job-cancel`); account (`#password-form`,
`#current-password`, `#new-password`, `#theme-select`).

### 4.1 Event bus (`js/bus.js`, FROZEN)

| event | emitted by | payload | consumed by |
|---|---|---|---|
| `sessions:changed` | sessions.js after every list/poll/CRUD | `{ sessions: SessionView[] }` | code.js (rail + session select) |
| `code:open-terminal` | sessions.js row action | `{ session, shell }` | code.js (opens a pane; app.js navigates to `#/code`) |
| `auth:required` | api.js on any 401 | `{}` | app.js (show login), code.js (dispose panes) |
| `auth:ready` | app.js after login/boot | `{}` | all views |
| `auth:lost` | app.js on logout | `{}` | code.js (dispose panes, keep the layout) |
| `settings:changed` | settings.js | `{ settings }` | code.js (layout blob, theme) |
| `theme:changed` | app.js | `{ theme: 'dark'\|'light' }` | code.js → `pane.setTheme()` |
| `view:changed` | app.js on every route change | `{ view }` | code.js (re-fit when it becomes visible) |
| `terminals:changed` | code.js | `{ count }` | F1 (badge, optional) |

## 5. Key flows

### 5.1 Boot and auth

```
DOMContentLoaded
  └─ app.boot()
       ├─ GET /api/auth/session
       │    ├─ needsSetup:true      → login modal + "set APP_PASSWORD and restart" hint
       │    ├─ authenticated:false  → login modal (static backdrop, #app-shell hidden)
       │    └─ authenticated:true   → app.startApp()
       └─ login form submit → POST /api/auth/login {password}
            ├─ 200 → hide modal → startApp()
            ├─ 401 → inline #login-error "wrong password"
            └─ 429 → inline "too many attempts, wait 15 minutes"

startApp()
  ├─ show #app-shell
  ├─ GET /api/settings   (theme, ui.layout, backend kind for #backend-badge)
  ├─ await view.init(ctx) for code / sessions / settings   (each is idempotent)
  ├─ bus.emit('auth:ready')
  └─ route()   // from location.hash, else the remembered view, else #/code
```

Any later 401 (cookie expired, password changed elsewhere) → `api.js` emits `auth:required`
→ `app.js` hides the shell and reopens the login modal; `code.js` disposes its panes so no
websocket retries hammer the server. After a successful re-login the layout is restored and
panes reattach to their tmux sessions.

### 5.2 Routing

Hash routing only: `#/code`, `#/sessions`, `#/settings`. Unknown/empty hash → the value in
`localStorage['porterclaude.lastView']`, else `#/code`. The server's SPA fallback means a
hard reload of `https://host/#/sessions` still serves `index.html`. Route changes call
`hide()` on the outgoing module and `show()` on the incoming one; modules keep their state
(terminals stay connected while you visit Settings).

`ViewModule` (FROZEN):

```js
{ init(ctx): Promise<void>|void,   // once, after auth
  show(): void,                    // becomes visible
  hide(): void,                    // becomes hidden
  refresh?(): void }
```

`ctx` = `{ api, bus, navigate(view), getSettings(), getTheme() }`.

### 5.3 Sessions CRUD

* `sessions.reload()` → `GET /api/sessions` → render + `bus.emit('sessions:changed')`.
  Polled every **5 s** (`SESSION_POLL_MS`), started in `init()` and kept running while the
  Code tab is visible, because the rail depends on it. Poll pauses while a modal is open
  and while the tab is hidden (`document.visibilityState`).
* Create/Edit use one modal. The form maps 1:1 onto `SessionInput`
  (`server/src/sessions/model.ts` is the schema of record):
  name (`^[a-z0-9][a-z0-9-]{0,30}$`, **immutable on edit**), displayName, image
  (`{type:'recipe',recipe}` | `{type:'custom',ref}`), workspace
  (`{type:'volume'}` | `{type:'bind',hostPath}` | `{type:'git',url,branch?}`), env map,
  ports (`containerPort` required, `hostPort` optional → leave blank for a random port),
  extraMounts, limits (`cpus`, `memoryMb`), `shareHistory`, `autoStart`, `network`, `user`.
* Custom images: a "Validate" button calls `POST /api/images/custom/validate` and renders
  `warnings[]` (e.g. *no tmux → terminals do not survive a reload*, non-root user, arch
  mismatch) inline; validation never blocks saving.
* Edit ⇒ recreate: the confirm dialog says *"this recreates the container; the workspace and
  named volumes survive"*. Destroy asks twice when `removeVolumes` is ticked.
* Row actions map to `POST /api/sessions/:name/{start,stop,restart,recreate}`, `DELETE`,
  logs modal (`GET …/logs?tail=`), and **Open terminal** →
  `bus.emit('code:open-terminal', {session, shell:'bash'})` + `navigate('code')`.
* `needsRecreate` renders a warning pill with a one-click **Recreate**; `orphan` renders an
  "adopt or destroy" hint; `warnings[]` becomes a tooltip on the row.

### 5.4 Settings

* Backend picker: radio `socket | portainer`. **Test connection** (`POST
  /api/settings/backend/test`) uses the *current form values* and saves nothing; on success
  it renders `info` (server version, OS, arch, CPUs, memory, container counts) and, for
  Portainer, fills the endpoint `<select>` from `endpoints[]`. Save issues
  `PUT /api/settings/backend`.
* The API key field is **write-only**: it always renders empty, shows `apiKeyHint`
  ("stored …a1b2") next to the label, and an empty value means *keep the stored key* (the
  property is omitted from the request — never sent as `""`, which the schema rejects).
  The key is never logged, never put in the DOM, never stored in localStorage.
* General: one input per `GeneralConfig` key; `PUT /api/settings/general` accepts partials.
* Images sub-panel (`images.js`): recipe cards with built / outdated / building state,
  Build → `202 {job}` → `#job-modal` tailing `GET /api/images/jobs/:id?since=` every second
  (append-only cursor `nextIndex`), Cancel → `POST …/cancel`; tools volume status + Sync.
  A `409 conflict` on build means one is already running → open that job instead of erroring.
* Account: password change (`POST /api/settings/password`, min 8, confirm client-side) and
  theme (`PUT /api/settings/ui {theme}`).

### 5.5 Code tab: GoldenLayout

`code.js` creates one `GoldenLayout` over `#code-root` and registers a single component
factory, `'terminal'`, whose **component state is the pane contract**:

```js
{ session: 'web', shell: 'claude', name: 'web-claude-1', title?: 'web · claude' }
```

* `layout.registerComponentFactoryFunction('terminal', (container, state) => …)` builds
  `.pc-pane > .pc-pane-term`, constructs a `TerminalPane` and attaches it.
* New pane: `layout.addComponent('terminal', state, title)` (first pane bootstraps the root
  via `layout.loadLayout()`); drag-to-split and tab reordering come from GoldenLayout.
* Sizing: GoldenLayout 2 does not observe its container by itself — call
  `layout.setSize(el.clientWidth, el.clientHeight)` on window resize (debounced ~100 ms) and
  once on `view:changed → code` (a hidden container measures 0×0, which would create a 1×1
  terminal). Each `container.on('resize')` runs `pane.fit()` on the next animation frame.
* `container.on('destroy')` disposes the pane and persists.
* Pane naming (FROZEN, in `terminal.js`): `makeTerminalName(session, shell, n)` →
  `"<session>-<shell>-<n>"` with the smallest free `n ≥ 1`, matching
  `^[a-z0-9][a-z0-9_-]{0,39}$`. The server derives the tmux session `pc_<name>`, so the name
  **must** survive a reload unchanged — that is exactly why it lives in the layout state.

**Layout persistence** — envelope, written to both stores:

```js
{ v: 1, savedAt: Date.now(), root: layout.saveLayout() }
```

* `localStorage['porterclaude.layout.v1']` — written immediately on `stateChanged`.
* `PUT /api/settings/ui { layout }` — debounced 1.5 s, failures swallowed (never toast).
* On boot the **fresher `savedAt` wins**; blobs with a different `v` are ignored. Restoring
  recreates panes, which reconnect and reattach to tmux. A pane whose session vanished gets
  a `4404` close and shows an inline error with a close action instead of retrying forever.
* `#btn-reset-layout` disposes all panes and clears both copies.

### 5.6 Terminal websocket (`terminal.js`)

```
new WebSocket(terminalWsUrl({session, shell, name, cols, rows}))   // cookie rides along
ws.binaryType = 'arraybuffer'
```

| direction | frame | handling |
|---|---|---|
| server → client | binary | `term.write(new Uint8Array(ev.data))` |
| server → client | text | `JSON.parse` → `ready` / `info` / `error` / `exit` / `pong` |
| client → server | binary | `ws.send(new TextEncoder().encode(data))` from `term.onData` |
| client → server | text | `{type:'resize',cols,rows}`, `{type:'ping'}`, `{type:'signal',signal:'SIGINT'}` |

* First text frame is always `ready`; store `terminalId`, `tmux`, `reattached`. Send a
  `resize` right after `ready` (the fit addon has real numbers by then).
  `tmux:false` → a persistent amber `.pc-pane-note` strip: *"no tmux in this image —
  reloading the page kills this shell"*. `reattached:true` → a dim `info` line.
* Client keepalive `{type:'ping'}` every 25 s (the server also ws-pings every 30 s and kills
  sockets that miss two pongs).
* Reconnect policy (from api.md): close `1000` → **no** auto-reconnect, print
  `[process exited] press Enter to restart` and reconnect on Enter with the same `name`
  (tmux reattaches); `4401` → `bus.emit('auth:required')`, never retry; `4400/4404/4409/
  4502/4500` and abnormal `1006` → exponential backoff 1 s → 15 s with jitter, forever, with
  the countdown shown in the pane; the delay resets after a socket that stayed open > 10 s.
  `4409` (session not running) additionally offers a "start session" button.
* `dispose()` is idempotent: clear timers, `ws.close(1000)`, `term.dispose()`.
* Copy/paste: rely on xterm defaults (`Ctrl+Shift+C/V`); do not intercept `Ctrl+C`, it must
  reach the pty. No app-level keyboard shortcuts inside a pane — the keyboard belongs to the
  terminal; pane management happens with the mouse and the toolbar.

## 6. Error handling

* One code path: `api.request()` rejects with `ApiError { code, status, message, details }`
  built from the `{error:{…}}` envelope.
* `401` → `auth:required` (login modal), never a toast.
* `409 backend_not_configured` → inline alert in the view with a link to Settings
  (`#/settings`), not a toast loop. Sessions/Code render an empty state instead of an error.
* `422 validation_error` → map `details` (zod issues) onto the offending form field where
  the path is known, otherwise show the message in `#session-form-error`.
* `502 backend_error` → toast with the docker message and a "Retry" action; the sessions
  poll backs off to 30 s after three consecutive failures and returns to 5 s on success.
* `429` → inline on the login form.
* Network failures (`status 0`) → toast "server unreachable"; the poll keeps trying.
* Nothing secret is ever logged to the console: no API keys, no cookie values.

## 7. Accessibility / UX notes

* Every icon-only button carries a `title` and `aria-label`.
* Modals use Bootstrap focus management; the login modal is `data-bs-backdrop="static"`.
* Toasts are `aria-live="polite"`; errors are `assertive`.
* The Code tab is keyboard-first: focus follows the active GoldenLayout tab, and
  `pane.focus()` is called on tab activation.

## 8. Test plan hints for QA

**Without a browser (headless, no Docker needed)**

1. `npm install` (root, once) → `npm run verify --workspace web`
   Asserts: every `/vendor/**` URL referenced by `index.html` resolves inside
   `node_modules`, every local `/js|/css` asset exists, every ES import specifier resolves
   (no bare specifiers), and every module parses (`node --check`). Exit code 0 = pass.
2. `npm run lint` at the root — `eslint.config.js` already lints `web/**/*.js` as ES2023
   modules with browser globals.
3. Start the server (`npm run dev`) and curl the static contract:
   * `curl -sI localhost:8080/ | head -1` → `200`, `content-type: text/html`
   * `curl -s localhost:8080/js/app.js | head -3` → module source
   * `curl -sI localhost:8080/vendor/xterm/lib/xterm.js` → `200`
   * `curl -sI localhost:8080/vendor/golden-layout/esm/index.js` → `200`
   * `curl -sI localhost:8080/#/sessions`-equivalent: `curl -sI localhost:8080/anything`
     → `200` + `index.html` (SPA fallback)
   * `curl -s localhost:8080/api/settings/vendor | jq '.routes[] | select(.mounted==false)'`
     → empty
   * `curl -s localhost:8080/api/sessions` → `401` + `{"error":{"code":"unauthorized"…}}`
4. Grep guards: `grep -rn "from '[a-z@]" web/public/js` must return nothing (no bare
   specifiers); `grep -rn "apiKey" web/public/js` must show no persistence to localStorage.

**With a browser**

5. Login: wrong password → inline error, no crash; right password → shell appears, no
   console errors, `#backend-badge` shows the backend.
6. Settings → backend: pick Portainer, paste URL + key, **Test connection** → info card +
   endpoint list; reload the page → the key field is empty and shows the hint (proof the key
   never round-trips).
7. Sessions: create a session with recipe `node` and a volume workspace → row appears with
   status; Start/Stop/Logs work; Edit → recreate keeps the workspace; Destroy without
   `removeVolumes` leaves `porterclaude-ws-<name>`.
8. Code: open `bash` in a running session → prompt within a second; type `echo hi`; drag the
   tab to the right half → split pane, both terminals still live and resized correctly
   (`stty size` inside matches the pane).
9. Reload the page → the same panes come back and **tmux reattaches** (the `echo hi`
   scrollback and any running `claude` are still there). `info` line mentions "reattached".
10. Kill the server (or `docker stop` the session) → panes show a reconnect countdown, and
    they recover automatically when it comes back (session must be running again).
11. Stop a session from the Sessions tab while a pane is open → close code `4409` and an
    inline "session is not running" with a start action.
12. Custom image without tmux (e.g. `alpine:3.20` after tools sync) → the pane shows the
    amber "no tmux" warning strip.
13. `#btn-reset-layout` → all panes close, and a reload shows the empty state.
14. Log out → login modal, all sockets closed (check the network panel: no retry storm).

**Known non-goals for QA**: no unit-test runner ships for `web/` (no bundler, no jsdom);
`verify-assets.mjs` plus the browser walkthrough are the contract.
