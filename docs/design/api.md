# PorterClaude HTTP + WebSocket API — THE contract

Status: authoritative. Server (topic BACKEND) implements it; the web UI consumes it.
Anything not listed here does not exist. Changes require a note in both design docs.

Base URL: same origin as the UI. All REST lives under `/api`. All bodies are JSON
(`Content-Type: application/json`). All responses are JSON except static assets.

## Conventions

* **Auth**: a single-user session cookie `pc_session` (httpOnly, SameSite=Lax, signed JWT).
  The browser never reads it; it is sent automatically, including on the WebSocket upgrade.
* **Public endpoints** (no cookie): `GET /api/health`, `POST /api/auth/login`,
  `POST /api/auth/logout`, `GET /api/auth/session`, and everything outside `/api`
  (`/`, `/vendor/**`, static assets).
* **Everything else** returns `401 { "error": { "code": "unauthorized", ... } }` without a
  valid cookie.
* **Error envelope** — every non-2xx response:

```json
{ "error": { "code": "not_found", "message": "session 'web' does not exist", "details": null } }
```

| code | status | when |
|---|---|---|
| `bad_request` | 400 | malformed request that is not a schema violation |
| `validation_error` | 422 | zod validation failed; `details` = zod issues array |
| `unauthorized` | 401 | missing/expired/invalidated cookie, or wrong password |
| `forbidden` | 403 | reserved |
| `not_found` | 404 | unknown session/recipe/job/route |
| `conflict` | 409 | name already taken, job already running, session not running |
| `backend_not_configured` | 409 | no Docker backend selected/complete yet |
| `backend_error` | 502 | Docker/Portainer refused or is unreachable (`details.dockerStatus`) |
| `rate_limited` | 429 | login throttle |
| `not_implemented` | 501 | stub |
| `internal` | 500 | unexpected; message is always the generic string |

* **Secrets never leave the server.** The Portainer API key is write-only: it can be set,
  never read back. Responses expose `apiKeySet: boolean` and `apiKeyHint` (last 4 chars).
* Timestamps are ISO-8601 strings; durations are seconds; sizes are bytes.

---

## Auth

### `POST /api/auth/login` (public)
Request `{ "password": "..." }`
Response `200 { "authenticated": true }` + `Set-Cookie: pc_session=...`
Errors `401 unauthorized`, `429 rate_limited` (10 attempts / 15 min / IP).

### `POST /api/auth/logout` (public)
Response `200 { "authenticated": false }` + cookie cleared.

### `GET /api/auth/session` (public)
Response `200 { "authenticated": boolean, "needsSetup": boolean }`
`needsSetup` is true when no password has ever been configured (no `APP_PASSWORD`, no
stored hash) — the UI then tells the operator to set `APP_PASSWORD` and restart.

---

## Health

### `GET /api/health` (public)
```json
{ "status": "ok", "version": "0.1.0", "uptimeSec": 1234,
  "backend": { "kind": "socket", "configured": true } }
```
Always `200` while the process is alive (used by the container healthcheck). It performs
no network calls and leaks nothing.

---

## Settings

### `GET /api/settings`
```json
{
  "backend": {
    "kind": "portainer",
    "portainer": { "url": "https://portainer.example.com", "endpointId": 2,
                   "insecureTls": false, "apiKeySet": true, "apiKeyHint": "…a1b2" },
    "socket": { "socketPath": "/var/run/docker.sock" },
    "socketAvailable": false
  },
  "general": {
    "workspacesRoot": "/srv/porterclaude/workspaces",
    "sharedClaudeVolume": "porterclaude-claude",
    "sharedClaudeHomeVolume": "porterclaude-claude-home",
    "toolsVolume": "porterclaude-tools",
    "defaultRecipe": "node",
    "containerPrefix": "pc-",
    "sessionNetwork": null,
    "imageNamespace": "porterclaude",
    "containerHome": "/home/dev",
    "workspaceMount": "/workspace",
    "toolsMount": "/opt/porterclaude"
  },
  "ui": { "layout": null, "theme": "auto" },
  "auth": { "passwordSet": true }
}
```

### `PUT /api/settings/backend`
```json
{ "kind": "portainer",
  "portainer": { "url": "https://portainer.example.com", "apiKey": "ptr_…",
                 "endpointId": 2, "insecureTls": false } }
```
* `kind` ∈ `portainer | socket | none`.
* Omit `portainer.apiKey` to keep the stored key; send `""`… **not allowed** — to clear it,
  switch `kind` away from portainer. (Validation requires ≥1 char when present.)
* Response: the same object as `GET /api/settings`.
* Side effect: the backend instance is rebuilt on the next request.

### `POST /api/settings/backend/test`
Body identical to `PUT /api/settings/backend` (minus `kind: "none"`), but **nothing is
saved**. Always `200`:
```json
{ "ok": true,
  "info": { "name": "docker-host", "serverVersion": "29.1.3", "os": "Ubuntu 24.04",
            "architecture": "aarch64", "ncpu": 4, "memTotalBytes": 24696061952,
            "containers": 12, "containersRunning": 9, "images": 30 },
  "endpoints": [ { "id": 2, "name": "local", "type": 1, "status": 1 } ] }
```
or `{ "ok": false, "error": { "code": "backend_error", "message": "401 from Portainer" } }`.
`endpoints` is present only for `kind: "portainer"`.

### `POST /api/settings/backend/endpoints`
`{ "url"?: string, "apiKey"?: string, "insecureTls"?: boolean }` — all optional; omitted
values fall back to what is stored. Response `{ "endpoints": PortainerEndpoint[] }`.

### `PUT /api/settings/general`
Partial `general` object. Response: full sanitized settings.

Every field is validated where it enters the system (an unchecked value would otherwise
fail deep inside docker on the *next* session create), so a bad value is a `422
validation_error` naming the field:

| field | rule |
|---|---|
| `containerPrefix`, `imageNamespace`, `defaultRecipe` | `[a-z0-9][a-z0-9._-]*` (max 64) |
| `sharedClaudeVolume`, `sharedClaudeHomeVolume`, `toolsVolume`, `sessionNetwork` | docker object name `[a-zA-Z0-9][a-zA-Z0-9_.-]*` (max 128); `sessionNetwork` may be `null` |
| `workspacesRoot`, `containerHome`, `workspaceMount`, `toolsMount` | absolute POSIX path, no `.`/`..` segment (max 512) |

Session `env` keys are validated the same way by `SessionInput`: `[A-Za-z_][A-Za-z0-9_]*`.

### `PUT /api/settings/ui`
`{ "layout"?: any, "theme"?: "auto"|"light"|"dark" }` — the UI persists its GoldenLayout
state here. Response `{ "ui": { "layout": ..., "theme": ... } }`.

### `POST /api/settings/password`
`{ "currentPassword": "...", "newPassword": "..." }` (min 8 chars). Response
`200 { "ok": true }` plus a fresh cookie; every other session cookie is invalidated.
`401 unauthorized` when `currentPassword` is wrong.

### `GET /api/settings/vendor`
Debug aid: `{ "routes": [ { "route": "/vendor/bootstrap", "dir": "…", "mounted": true } ] }`.

---

## Docker (read-only helpers)

| Method | Path | Response |
|---|---|---|
| GET | `/api/docker/info` | `{ "info": DockerInfo }` |
| GET | `/api/docker/containers?all=1&managed=1` | `{ "containers": ContainerSummary[] }` |
| GET | `/api/docker/volumes` | `{ "volumes": VolumeSummary[] }` |
| GET | `/api/docker/networks` | `{ "networks": NetworkSummary[] }` |

`managed=1` filters on the label `porterclaude.managed=true`. All four return
`409 backend_not_configured` when no backend is set up.

---

## Sessions

`SessionInput` (request body for create/update):

```json
{
  "name": "web",                                  // ^[a-z0-9][a-z0-9-]{0,30}$
  "displayName": "Web app",                       // optional
  "image": { "type": "recipe", "recipe": "node" },// or { "type":"custom", "ref":"nginx:1.27" }
  "workspace": { "type": "volume" },              // or {"type":"bind","hostPath":"/srv/x"}
                                                  // or {"type":"git","url":"…","branch":"main"}
  "env": { "FOO": "bar" },                        // keys: ^[A-Za-z_][A-Za-z0-9_]*$
  "ports": [ { "containerPort": 3000, "hostPort": 3000, "protocol": "tcp" } ],
  "extraMounts": [ { "type": "volume", "source": "cache", "target": "/cache", "readOnly": false } ],
  "limits": { "cpus": 2, "memoryMb": 4096 },
  "shareHistory": true,
  "autoStart": true,
  "network": null,
  "user": null
}
```

`SessionView` (every response) = the stored config plus:

```json
{ "...": "all SessionInput fields",
  "createdAt": "2026-08-15T10:00:00.000Z", "updatedAt": "…", "specHash": "…",
  "status": "running",            // created|running|paused|restarting|removing|exited|dead|unknown|absent
  "containerId": "3f2a…", "containerName": "pc-web",
  "resolvedImage": "porterclaude/node:latest",
  "startedAt": "…", "uptimeSec": 3600,
  "runtimePorts": [ { "containerPort": 3000, "hostPort": 3000, "protocol": "tcp" } ],
  "needsRecreate": false, "orphan": false, "warnings": [] }
```

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/sessions` | – | `{ "sessions": SessionView[] }` |
| POST | `/api/sessions` | `SessionInput` | `201 { "session": SessionView }` |
| GET | `/api/sessions/:name` | – | `{ "session": SessionView }` |
| PUT | `/api/sessions/:name` | `SessionInput` | `{ "session": SessionView }` (recreates the container) |
| DELETE | `/api/sessions/:name?removeVolumes=1` | – | `204` |
| POST | `/api/sessions/:name/start` | – | `{ "session": SessionView }` |
| POST | `/api/sessions/:name/stop` | – | `{ "session": SessionView }` |
| POST | `/api/sessions/:name/restart` | – | `{ "session": SessionView }` |
| POST | `/api/sessions/:name/recreate` | – | `{ "session": SessionView }` |
| GET | `/api/sessions/:name/logs?tail=200&timestamps=0` | – | `{ "logs": "…" }` |
| POST | `/api/sessions/reconcile` | – | `{ "report": { "known": 3, "running": 2, "orphans": [], "adopted": ["x"], "missing": ["y"] } }` |

Notes
* `PUT` = edit = **recreate**: stop → remove container (volumes kept) → create → start if
  it was running or `autoStart`. `name` is immutable; a rename is a new session.
* `DELETE` removes the container and the stored definition; `removeVolumes=1` also deletes
  `porterclaude-ws-<name>` and `porterclaude-hist-<name>` (never the shared volumes).
* `409 conflict` when creating a name that already exists (config or container).
* Route order: `/reconcile` is registered before `/:name`.
* `POST /reconcile` **adopts**: every container labelled `porterclaude.managed=true` that
  has no stored definition is written back into `config.json` (reconstructed from its
  labels/inspect) and reported under `adopted`; those sessions answer `orphan:false`
  afterwards and are editable again. `orphans` therefore only lists the containers that
  could *not* be adopted (e.g. a container name that is not a valid session slug), and
  `known` is the session count **after** the adoption. The reconcile that runs at startup
  never adopts — there an orphan stays visible as `orphan:true`.

---

## Images

### `GET /api/images`
`{ "images": ImageSummary[] }` — raw docker image list for the custom-image picker.

### `GET /api/images/recipes`
```json
{ "recipes": [ {
  "name": "node", "title": "Node.js 22", "description": "…", "baseImage": "node:22-bookworm",
  "defaultPorts": [], "imageRef": "porterclaude/node:latest",
  "built": true, "imageId": "sha256:…", "builtAt": "2026-08-14T…", "sizeBytes": 1234567890,
  "claudeVersion": "1.2.3", "outdated": false, "building": false, "jobId": null } ] }
```
`outdated` = the image's `porterclaude.context-hash` label differs from the hash of the
current `docker/recipes/<name>` context (plus `common.sh`).

### `POST /api/images/recipes/:name/build`
Body `{ "noCache"?: boolean, "pull"?: boolean }` → `202 { "job": JobSummary }`.
`409 conflict` when a build for that recipe is already running.

### Jobs (build / pull / tools-sync)
`JobSummary`:
```json
{ "id": "…", "kind": "build", "target": "node", "status": "running",
  "startedAt": "…", "finishedAt": null, "error": null, "lineCount": 42 }
```
| Method | Path | Response |
|---|---|---|
| GET | `/api/images/jobs` | `{ "jobs": JobSummary[] }` (newest first, max 50) |
| GET | `/api/images/jobs/:id?since=0` | `{ "job": JobSummary, "lines": ["…"], "nextIndex": 42 }` |
| POST | `/api/images/jobs/:id/cancel` | `{ "job": JobSummary }` |

Live build output is **polled** (recommended 1 s while `status === "running"`), not
streamed — `since`/`nextIndex` give an append-only cursor.

### Tools volume
`GET /api/images/tools` →
```json
{ "status": { "volume": "porterclaude-tools", "imageRef": "porterclaude/tools:latest",
              "present": true, "lastSyncedAt": "…", "claudeVersion": "1.2.3",
              "contextHash": "9f86d081…", "outdated": false,
              "syncing": false, "jobId": null } }
```
`contextHash` is the hash of the current `docker/tools` context; `outdated` = the image's
stored `porterclaude.context-hash` differs from it (or the volume is populated from an image
that no longer exists) — the same rule as `RecipeStatus.outdated`.

`POST /api/images/tools/sync` body `{ "force"?: boolean }` → `202 { "job": JobSummary }`.
The sync **rebuilds `<ns>/tools:latest` whenever it is missing or outdated** and only then
re-populates the volume, so upgrading PorterClaude replaces the entrypoint and the claude
binaries in the volume without any extra step. `force: true` rebuilds unconditionally,
pulling the base image and ignoring the layer cache.

### `POST /api/images/custom/validate`
Body `{ "image": "nginx:1.27" }` →
```json
{ "result": { "image": "nginx:1.27", "ok": true, "existsLocally": false, "pulled": true,
              "architecture": "arm64", "user": "root",
              "warnings": ["no tmux in this image: terminals will not survive a reload"],
              "error": null } }
```

### `POST /api/images/pull`
Body `{ "image": "…" }` → `202 { "job": JobSummary }`.

---

## WebSocket: terminals

```
GET /api/terminals?session=<slug>&shell=bash|claude|sh&name=<terminal>&cols=<n>&rows=<n>
Upgrade: websocket          Cookie: pc_session=…   (sent automatically, same origin)
```

* `name` is the stable pane identity chosen by the UI (e.g. `main`, `claude-1`). It maps to
  the tmux session `pc_<name>`; reconnecting with the same `name` **reattaches**.
* `cols`/`rows` default to 80×24; the client should still send a `resize` after `ready`.
* The browser must set `ws.binaryType = 'arraybuffer'`.

### Frames

| Direction | Frame type | Meaning |
|---|---|---|
| client → server | **binary** | raw stdin bytes (keystrokes, paste) |
| client → server | text | JSON `ClientMessage` |
| server → client | **binary** | raw pty output — feed directly into `term.write()` |
| server → client | text | JSON `ServerMessage` |

`ClientMessage`:
```json
{ "type": "resize", "cols": 120, "rows": 32 }
{ "type": "ping" }
{ "type": "signal", "signal": "SIGINT" }
```

`ServerMessage`:
```json
{ "type": "ready", "terminalId": "8f…", "session": "web", "shell": "bash",
  "name": "main", "tmux": true, "reattached": false, "cols": 120, "rows": 32 }
{ "type": "info",  "message": "reattached to tmux session pc_main" }
{ "type": "error", "code": "session_not_running", "message": "session 'web' is not running" }
{ "type": "exit",  "code": 0 }
{ "type": "pong" }
```

`ready` is always the first text frame on success. `tmux:false` means the image has no
tmux — the UI must warn that a reload kills the shell.

`exit.code` is the **process** exit status of the exec (read back with `exec inspect`), never
a transport code, and may be `null` when the engine cannot report it. When the exec ends
because the container is no longer running, the server does not send `exit` at all: it sends
`{"type":"error","code":"session_not_running"}` and closes `4409` (`session_not_found` /
`4404` when the session is gone), so the pane can offer "Start session" instead of claiming
the shell exited.

### Close codes

| code | meaning |
|---|---|
| 1000 | normal (the shell itself exited, or the client closed the socket) |
| 4400 | bad request (invalid query) |
| 4401 | unauthorized — the upgrade is rejected with an HTTP `401` before the handshake |
| 4404 | session not found |
| 4409 | session exists but is not running |
| 4502 | backend error (Docker/Portainer) |
| 4500 | internal error |

### Reconnect semantics

The server keeps **no** per-terminal state. A reconnect is a fresh exec; continuity comes
from tmux inside the container. Client rule: on close with code ≥ 4400 other than 4401,
reconnect with exponential backoff (1 s → 15 s, jitter); on 4401 redirect to the login
screen; on 1000 do not reconnect automatically. The server pings every 30 s and terminates
sockets that miss two pongs.

---

## Static assets

| Path | Served from |
|---|---|
| `/` and any non-`/api` GET without a file match | `web/public/index.html` |
| `/assets/**`, `/app/**`, … | `web/public/**` |
| `/vendor/bootstrap/**` | `node_modules/bootstrap/dist/**` |
| `/vendor/bootstrap-icons/**` | `node_modules/bootstrap-icons/font/**` |
| `/vendor/jquery/**` | `node_modules/jquery/dist/**` |
| `/vendor/xterm/**` | `node_modules/@xterm/xterm/**` |
| `/vendor/xterm-addon-fit/**` | `node_modules/@xterm/addon-fit/lib/**` |
| `/vendor/xterm-addon-web-links/**` | `node_modules/@xterm/addon-web-links/lib/**` |
| `/vendor/golden-layout/**` | `node_modules/golden-layout/dist/**` |

Concrete URLs the UI can rely on:

```
/vendor/bootstrap/css/bootstrap.min.css
/vendor/bootstrap/js/bootstrap.bundle.min.js
/vendor/bootstrap-icons/bootstrap-icons.css
/vendor/jquery/jquery.min.js
/vendor/xterm/css/xterm.css
/vendor/xterm/lib/xterm.js            (UMD; no .mjs is published)
/vendor/xterm-addon-fit/addon-fit.js  (UMD; no .mjs is published)
/vendor/xterm-addon-web-links/addon-web-links.js
/vendor/golden-layout/esm/index.js
/vendor/golden-layout/css/goldenlayout-base.css
/vendor/golden-layout/css/themes/goldenlayout-dark-theme.css
```

Corrected 2026-08-16 (B1/F1/F2, verified against the published tarballs): golden-layout
2.6.0 ships **no** `dist/bundle/` — `bundle/esm/golden-layout.js` and the `bundle/umd`
twin never existed — and @xterm 5.5 publishes UMD `.js` only. The ESM entry is
`/vendor/golden-layout/esm/index.js`; its relative specifiers are extensionless, so the
vendor mounts pass `extensions: ['js']` to `express.static` for the browser to resolve
them. `VENDOR_ROUTES` itself is unchanged.

The vendor list is defined in `server/src/vendor.ts` (`VENDOR_ROUTES`, FROZEN). Adding a
library means adding it to `web/package.json` **and** that array.

---

## PROPOSED ADDITIONS / CLARIFICATIONS (raised by the FRONTEND topic, 2026-08-15)

Non-blocking. These are clarifications of existing endpoints, not new calls — the UI is
built assuming the answers below. Backend: confirm or correct; no code change is expected
unless a bullet says otherwise.

1. **`SessionInput.ports[].hostPort` is optional.** `sessions/model.ts` already has
   `hostPort: z.number().int().min(1).max(65535).optional()`. The session modal leaves the
   host-port input blank by default and then **omits the property** (never sends `null` or
   `0`), meaning "let Docker choose". The chosen port comes back in
   `SessionView.runtimePorts[]` and is what the table renders.

2. **"Keep the stored Portainer key" is expressed by omission.** `PUT /api/settings/backend`
   and `POST /api/settings/backend/test` are sent **without** `portainer.apiKey` when the
   user leaves the (always-empty) key field untouched. The UI never sends `""`.

3. **Terminal `name` charset.** The UI only ever generates
   `^[a-z0-9][a-z0-9_-]{0,39}$` (`<session>-<shell>-<n>`, e.g. `web-claude-2`) so
   `tmuxSessionName()` is a no-op transform. The server should still validate and reject
   `4400` on anything else.

4. **`PUT /api/settings/ui` layout blob.** The UI stores
   `{ v: 1, savedAt: <epoch ms>, root: <GoldenLayout LayoutConfig> }` and keeps it under
   ~64 KB; it is written at most every 1.5 s (debounced). No terminal output is ever
   included. If the server wants a size cap, `413`/`validation_error` is fine — the UI
   swallows save failures silently.

5. **Polling cadence the UI uses** (so rate limits, if any, are sized for it):
   `GET /api/sessions` every 5 s while a browser tab is visible (30 s after three
   consecutive failures), `GET /api/images/jobs/:id?since=` every 1 s only while a job
   modal is open, `GET /api/sessions/:name/logs` only on demand.

6. **`GET /api/settings/vendor`** is used by QA as the vendor-mount smoke test; please keep
   `mounted:false` entries in the response rather than omitting them.
