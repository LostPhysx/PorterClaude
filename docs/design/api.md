# PorterClaude HTTP + WebSocket API — THE contract

> **v0.2 (hosts + agents): jump to the [v0.2 section](#v02--hosts-and-agents-authoritative-from-here-down)
> at the bottom. It supersedes every v0.1 statement it contradicts.**

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
                                                  // hostPath: absolute = any host path;
                                                  // relative = under `workspacesRoot`.
                                                  // `.`/`..` segments, `\` and NUL are
                                                  // rejected (422) and a relative path
                                                  // that still resolves outside
                                                  // `workspacesRoot` is a 400.
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
  "resolvedImage": "porterclaude/node:latest",   // STABLE ref: <ns>/<recipe>:latest, or
                                                 // image.ref for a custom image
  "containerImage": "sha256:8d4d875a6431",       // what docker says the container runs
                                                 // (a bare digest after a rebuild); null
                                                 // when there is no container
  "imageOutdated": true,                         // the container runs an older image than
                                                 // resolvedImage points at today
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
* `resolvedImage` is never the raw docker value: a recipe rebuild retags
  `<ns>/<recipe>:latest`, after which docker reports a bare `sha256:…` for every container
  created before it. That digest is `containerImage`; `imageOutdated` says whether
  recreating the session would pick up a newer image (`false` without a container, and
  `false` while the image ref cannot be inspected).
* `PUT` = edit = **recreate**: stop → remove container (volumes kept) → create → start if
  it was running or `autoStart`. `name` is immutable; a rename is a new session.
* `DELETE` removes the container and the stored definition; `removeVolumes=1` also deletes
  `porterclaude-ws-<name>` and `porterclaude-hist-<name>` (never the shared volumes).
* `409 conflict` when creating a name that already exists (config or container).
* `409 conflict` with `details.reason: "tools_not_synced"` when the target host's tools
  volume carries no `<toolsMount>/entrypoint.sh`: every container runs that bootstrap as its
  entrypoint, so the session could only crash-loop. The message names the fix (run the tools
  sync for that host). The check never blocks on a maybe — an unreachable host or a volume
  that cannot be read lets the create through as before. `POST …/start` and `…/restart` of an
  EXISTING container do not refuse; they report the same sentence in `warnings`.
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
  "claudeVersion": "2.1.233", "claudeChannel": "stable",
  "outdated": false, "building": false, "jobId": null } ] }
```
`outdated` = the image's `porterclaude.context-hash` label differs from the hash of the
current `docker/recipes/<name>` context (plus `common.sh`).

`builtAt` is the image's **Created** timestamp, i.e. when the build finished.

`claudeVersion` is the Claude Code version the image really ships, read out of
`/etc/porterclaude/claude-version` inside it (the tools image: `/payload/VERSION`);
`claudeChannel` is what the build *asked* for (`stable`, `latest` or an exact version, from
the `porterclaude.claude-version` label) and is never a real version. Reading the file
needs a one-shot container, so `claudeVersion` may be `null` on the first call after a
server restart and is filled in for the next poll — treat `null` as "not known yet", not as
"no claude".

### `POST /api/images/recipes/:name/build`
Body `{ "noCache"?: boolean, "pull"?: boolean, "force"?: boolean }` → `202 { "job": JobSummary }`.
`409 conflict` when a build for that recipe is already running.

A build whose context hash still matches the built image is **skipped** (the job succeeds
and logs `… is up to date`): rebuilding an unchanged recipe would only produce a new image
id, untag the image every existing session runs and leave those sessions on an
orphaned image. `force`, `noCache` or `pull` build unconditionally — that is how a new base
image is picked up.

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
              "present": true, "lastSyncedAt": "…", "claudeVersion": "2.1.233",
              "claudeChannel": "stable",
              "contextHash": "9f86d081…", "outdated": false,
              "syncing": false, "jobId": null } }
```
`contextHash` is the hash of the current `docker/tools` context; `outdated` = the image's
stored `porterclaude.context-hash` differs from it (or the volume is populated from an image
that no longer exists) — the same rule as `RecipeStatus.outdated`. `claudeVersion` /
`claudeChannel` / `lastSyncedAt` follow the `RecipeStatus` rules above (`lastSyncedAt`
falls back to the image's Created timestamp until this process has run a sync).

`POST /api/images/tools/sync` body `{ "force"?: boolean }` → `202 { "job": JobSummary }`.
The sync **rebuilds `<ns>/tools:latest` whenever it is missing or outdated** and only then
re-populates the volume, so upgrading PorterClaude replaces the entrypoint of every session
without any extra step.

`force: true` means **upgrade**, and does two things:

* the image is rebuilt unconditionally, pulling the base image and ignoring the layer cache;
* `PORTERCLAUDE_TOOLS_FORCE=1` goes into the populate container, which turns off the
  carry-over of an installed agent and reinstalls every enabled agent and bundled runtime
  from source (v0.2 — see the Agents section below).

`force: false` (the default) is the cheap path: rebuild only when outdated, install only what
is missing or whose definition changed.

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
{ "type": "kill" }
```

`kill` = **the user closed this pane**. The server runs `tmux kill-session -t pc_<name>`
and closes the socket with `1000`, so the pane's shell (and everything running in it) does
not stay alive in the container forever. Closing the socket with code `4001` does the same
thing and is the fallback for a pane teardown that cannot send a frame first. Nothing else
ever kills a tmux session: a reload, a lost connection or a normal close (`1000`) leave it
running, which is what makes reconnecting re-attach.

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

**Deciding which one it was (INT-05).** Stopping a session kills the exec within ~60 ms while
the engine needs longer (~170 ms, more through Portainer) to report the container as exited, so
a single state check right after the exec died still answers "running". When the exit status
is `137`/`143` (128+SIGKILL / 128+SIGTERM, what stopping a container produces) or cannot be
read at all, the server therefore re-inspects the container every 250 ms for up to 3 s and
closes `4409`/`4404` as soon as the stop shows up; only if the container is still running at
the end of that window does it send `exit` and close `1000`. Any other status (`0` & co) is
answered on the first check, as before — a normal shell exit is never delayed.

Client rule for the same reason: a pane must **not** print "[process exited] press Enter to
restart" for `exit.code` `137`/`143` or after a `4409` close — it shows the "session … is not
running" note with its **Start session** action instead (and replaces an exit line it had
already printed when a late `4409` / session-state answer contradicts it).

### Close codes

| code | meaning |
|---|---|
| 1000 | normal (the shell itself exited, or the client closed the socket) |
| 4001 | client → server: the user closed the pane — kill `pc_<name>` (same as `{"type":"kill"}`) |
| 4400 | bad request (invalid query) |
| 4401 | unauthorized — the upgrade is rejected with an HTTP `401` before the handshake |
| 4404 | session not found |
| 4409 | session exists but is not running |
| 4502 | backend error (Docker/Portainer) |
| 4500 | internal error |

Client side (INT-06): `TerminalPane.dispose({ kill: true })` sends the `kill` frame and then
closes with `4001`. `code.js` passes `kill: true` **only** for an explicit pane close (the
tab close button, the "Close pane" note action); a layout restore, a `resetLayout()` and the
auth-loss teardown dispose without it, so those panes reattach when they come back. Nothing
is sent when the socket is not open — there is no live exec to kill from the client's side.

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

7. **`SessionView` image identity (INT-01).** The UI no longer renders `resolvedImage` when
   it is a bare `sha256:…` digest — that happens for every session created before a recipe
   rebuild and reads as noise. It renders the *recipe ref* instead plus an
   "image updated — recreate" badge. It reads, in order of preference and all optional:

   * `SessionView.imageRef` — the ref the session's image spec points at *now*
     (`RecipeStatus.imageRef` for `image.type === 'recipe'`, `image.ref` for custom).
   * `SessionView.imageOutdated` (aliases accepted: `imageUpdated`, `imageStale`,
     `resolvedImageOutdated`) — `true` when the container runs an image id that is no longer
     what `imageRef` resolves to, i.e. recreating the container would pick up a newer build.

   **Answered (backend, 2026-08-16).** `resolvedImage` IS that stable ref now — it is never
   a digest — so the requested `imageRef` is not added as a second name for the same value.
   `SessionView.imageOutdated` exists exactly as described, and `SessionView.containerImage`
   carries the raw docker value (the bare digest) for anyone who wants to show it. The
   client-side derivation ("`resolvedImage` looks like a digest") no longer fires and can be
   dropped. A cached rebuild also no longer moves the tag at all
   (`POST /api/images/recipes/:name/build` skips it), so the flag only appears after a
   build that really changed something.

   **Confirmed (frontend, 2026-08-16).** The UI renders `resolvedImage` plus an
   "image updated — recreate" badge driven by `imageOutdated`, in the Sessions table and as
   a ⟳ marker in the Code tab's session rail; it never renders `containerImage`. The
   digest-looking-`resolvedImage` derivation is kept only as an inert fallback for an older
   server, so the two sides can ship independently.

---

# v0.2 — hosts and agents (AUTHORITATIVE from here down)

Everything above describes v0.1 and is kept for reference. **Where the two disagree, this
section wins.** v0.2 is allowed to break the v0.1 API; every change is listed below.

## v0.2 change list (one line each)

| # | Change | v0.1 | v0.2 |
|---|---|---|---|
| 1 | Docker connections | one global backend in settings | N **hosts**, `/api/hosts` CRUD |
| 2 | Portainer key | inline in `settings.backend.portainer` | a **credential** at `/api/credentials/portainer`, referenced by hosts |
| 3 | Endpoint picker | `POST /api/settings/backend/endpoints` | `GET /api/credentials/portainer/:id/endpoints` + `POST …/import` (one host per endpoint) |
| 4 | Backend settings routes | `PUT /api/settings/backend`, `POST /api/settings/backend/test` | **REMOVED** → `POST/PUT /api/hosts`, `POST /api/hosts/test`, `POST /api/hosts/:hostId/test` |
| 5 | Docker helpers | `/api/docker/*` | `/api/hosts/:hostId/docker/*` |
| 6 | Images / recipes / jobs / tools | `/api/images/*` | `/api/hosts/:hostId/images/*` |
| 7 | Sessions | flat, one engine | still flat (names are globally unique) **+ `hostId` in the body (create only) and in every `SessionView`**, `GET /api/sessions?hostId=` filter |
| 8 | Agents | Claude Code hard-wired | `AgentDefinition` registry: `/api/agents` (built-in + custom), `/api/hosts/:hostId/agents` (enable + install state) |
| 9 | Terminal `shell` | `bash \| claude \| sh` | `bash \| sh \| agent:<agentId>` (`claude` still accepted = `agent:claude`) |
| 10 | `ready` frame | – | adds `hostId` and `agentId` |
| 11 | Close codes | – | adds `4410 agent_not_available`, `4411 host_unavailable` |
| 12 | `GET /api/health` | `backend: {kind, configured}` | `hosts: {count, configured, defaultHostId}` |
| 13 | `GET /api/settings` | had a `backend` section | `general` + `ui` + `auth` + `hosts` summary only |
| 14 | Volumes | `porterclaude-claude`, `porterclaude-claude-home` | one **auth volume per agent per host**: `<volumePrefix>auth-<agentId>` |
| 15 | Config file | version 1 | version 2, migrated losslessly on first boot (`config.json.v1.bak` kept) |

Unchanged: auth (`/api/auth/*`, cookie, rate limit), the error envelope and codes, the
static/vendor mounts, `PUT /api/settings/general|ui`, `POST /api/settings/password`,
`GET /api/settings/vendor`, the terminal frame protocol and every other close code.

## Vocabulary

* **Host** — one docker engine PorterClaude manages. `{ id, name, connection }` with
  `connection.type ∈ socket | portainer` (`tcp`, `ssh` are reserved: the schema accepts them,
  every operation answers `501 not_implemented`). At most **one** socket host per install.
  Per host: its own transport, images, recipes, tools volume, agent auth volumes, shared
  volumes and optional overrides of the general settings. **Nothing is ever synced between
  hosts** — an agent login on host A says nothing about host B.
* **Credential** — a stored Portainer `{id, name, url, apiKey(encrypted), insecureTls}`. Any
  number of hosts (one per endpoint) reference it.
* **Agent** — a coding agent (`claude`, `opencode`, `gemini`, `codex`, `aider`, or a custom
  one). Installed into a host's tools volume by the tools sync; its shared state lives in the
  per-host volume `<volumePrefix>auth-<agentId>`.
* **Default host** — `defaultHostId`; used when a request omits a host (session create).

## Host-scoped URLs

`:hostId` is a slug (`^[a-z0-9][a-z0-9-]{0,31}$`). An unknown id is `404 not_found`; a host
whose connection is incomplete (missing credential/api key) is `409 backend_not_configured`;
an unsupported connection type is `501 not_implemented`.

```
/api/hosts/:hostId/docker/{info,containers,volumes,networks}
/api/hosts/:hostId/images/...        (everything the v0.1 /api/images had)
/api/hosts/:hostId/agents            (per-host agent state)
```

Sessions deliberately stay flat at `/api/sessions/:name`: **session names are unique across
hosts**, which is also what lets the terminal websocket route `session → host` with nothing
but the name. Creating a name that exists on any host is `409 conflict`.

---

## Hosts

`HostView`:

```json
{
  "id": "default", "name": "Local docker",
  "connection": { "type": "socket", "socketPath": "/var/run/docker.sock" },
  "connectionLabel": "socket: /var/run/docker.sock",
  "credentialName": null,
  "isDefault": true,
  "supported": true,
  "status": "ok",                       // ok | unreachable | not_configured | unknown
  "info": { "name": "docker-host", "serverVersion": "29.1.3", "architecture": "aarch64",
            "ncpu": 4, "memTotalBytes": 24696061952, "containers": 12,
            "containersRunning": 9, "images": 30, "os": "Ubuntu 24.04" },
  "error": null,
  "settings": { "...": "effective general settings of this host (general + overrides)" },
  "overrides": { "workspacesRoot": "/srv/other" },
  "agents": { "enabled": ["claude"] },
  "sessionCount": 3,
  "notes": null,
  "createdAt": "…", "updatedAt": "…"
}
```

`HostInput` (POST) / `HostUpdateInput` (PUT, all fields optional):

```json
{ "id": "prod",                       // optional; slugified from `name` when omitted
  "name": "Prod (portainer)",
  "connection": { "type": "portainer", "credentialId": "portainer-1", "endpointId": 2 },
  "overrides": { "workspacesRoot": "/srv/porterclaude/ws" },   // any general field
  "agents": ["claude", "opencode"],   // enabled agent ids (default: ["claude"])
  "notes": null,
  "makeDefault": false }
```

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/hosts?probe=1` | – | `{ "hosts": HostView[], "defaultHostId": string\|null }` |
| POST | `/api/hosts` | `HostInput` | `201 { "host": HostView }` |
| POST | `/api/hosts/test` | `{ "connection": …, "apiKey"?: "…" }` | `BackendTestResult` (always 200, nothing saved) |
| GET | `/api/hosts/:hostId` | – | `{ "host": HostView }` (probes) |
| PUT | `/api/hosts/:hostId` | `HostUpdateInput` | `{ "host": HostView }` |
| DELETE | `/api/hosts/:hostId?force=1` | – | `204` |
| POST | `/api/hosts/:hostId/default` | – | `{ "host": HostView, "defaultHostId": "…" }` |
| POST | `/api/hosts/:hostId/test` | – | `BackendTestResult` (always 200) |
| GET | `/api/hosts/:hostId/info` | – | `{ "info": DockerInfo }` |

Rules
* `id` is immutable. A second **socket** host is `409 conflict` ("the app runs on exactly one
  machine"). A portainer connection whose `credentialId` is unknown is `404`.
* `GET /api/hosts` without `probe=1` answers from a ≤15 s cached probe and never blocks on a
  dead engine; `probe=1` refreshes every host in parallel. A host that has not been probed yet
  therefore reports `status: "unknown"` with `info: null` — that is the first-render state,
  not an error; the UI resolves it with a probe.
* `DELETE` is `409 conflict` while sessions still reference the host; `force=1` deletes the
  host only — **containers, volumes and images on that engine are never touched**.
* Deleting the default host promotes the first remaining host; the last host leaves
  `defaultHostId: null` (first-run state).
* `BackendTestResult` is the v0.1 shape: `{ ok, info?, endpoints?, error? }`.

## Portainer credentials

`SanitizedPortainerCredential`:

```json
{ "id": "portainer-1", "name": "portainer.example.com",
  "url": "https://portainer.example.com", "insecureTls": false,
  "apiKeySet": true, "apiKeyHint": "…a1b2",
  "hostIds": ["prod", "staging"], "createdAt": "…", "updatedAt": "…" }
```

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/credentials/portainer` | – | `{ "credentials": SanitizedPortainerCredential[] }` |
| POST | `/api/credentials/portainer` | `{ name, url, apiKey, insecureTls? }` | `201 { "credential": … }` |
| PUT | `/api/credentials/portainer/:id` | partial (**omit `apiKey` to keep it**) | `{ "credential": … }` |
| DELETE | `/api/credentials/portainer/:id` | – | `204` (`409` while a host references it) |
| POST | `/api/credentials/portainer/test` | `{ url, apiKey, insecureTls? }` | `BackendTestResult` (unsaved) |
| POST | `/api/credentials/portainer/:id/test` | `{ url?, apiKey?, insecureTls? }` | `BackendTestResult` |
| GET | `/api/credentials/portainer/:id/endpoints` | – | `{ "endpoints": PortainerEndpoint[] }` |
| POST | `/api/credentials/portainer/:id/import` | `{ endpointIds?, nameTemplate?, update? }` | `{ "result": PortainerImportResult }` |

The api key is write-only exactly like in v0.1: it can be set and replaced, never read back,
and never appears in any response or log.

A credential **test** decides `ok` from the Portainer **endpoint listing** (`/api/endpoints`):
that call is what proves the url and the api key. `endpoints` is therefore always present on
`ok: true`, while `info` is best effort — it is the docker `/info` of the first docker
endpoint and stays `null` when the credential can reach Portainer but no endpoint answers.
A test never probes a fixed endpoint id.

`PortainerImportResult`:

```json
{ "created": ["prod", "staging"], "updated": [],
  "skipped": [ { "endpointId": 7, "name": "kube", "reason": "not a docker endpoint" } ],
  "hosts": [ HostView, … ] }
```

Import rules: one host per endpoint, `id = uniqueHostId(slugify(endpoint.name))`, name from
`nameTemplate` (`{name}` placeholder, default `{name}`); an existing host with the same
`credentialId` + `endpointId` is **updated, never duplicated** (`update: false` skips it);
non-docker endpoints are skipped with a reason; on an install without hosts the first
imported host becomes the default.

## Agents

`AgentDefinition` (and `AgentView` = definition + `builtin: boolean`):

```json
{
  "id": "claude", "name": "Claude Code",
  "description": "Anthropic's terminal coding agent",
  "command": "claude", "args": [],
  "versionCommand": ["claude", "--version"],
  "install": { "kind": "script", "url": "https://claude.ai/install.sh", "binPath": "bin/claude" },
  "sharedPaths": [ { "path": "~/.claude", "kind": "dir" },
                   { "path": "~/.claude.json", "kind": "file" } ],
  "historyPath": "~/.claude/projects",
  "env": {},
  "loginHint": "Open an agent terminal and run /login once per host.",
  "homepage": "https://claude.com/claude-code",
  "builtin": true
}
```

`install` is a discriminated union on `kind`:

| kind | fields | notes |
|---|---|---|
| `script` | `url`, `args?`, `binPath?`, `env?` | curl \| sh with the tools payload as prefix (claude, opencode) |
| `npm` | `package`, `version?`, `bin?` | uses the Node runtime the tools volume ships (gemini, codex) |
| `pip` | `package`, `version?`, `bin?`, `preferUv?` | uv/pipx inside the tools volume (aider) |
| `binary` | `urls{linux-x64,linux-arm64,linux-x64-musl,linux-arm64-musl}`, `archive`, `path?` | explicit per-target downloads |

Built-ins: `claude`, `opencode`, `gemini`, `codex`, `aider` (server/src/agents/builtin.ts).
Ids are part of the API (volume names, `shell=agent:<id>`) and never change.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/agents` | – | `{ "agents": AgentView[] }` |
| POST | `/api/agents` | `AgentDefinition` | `201 { "agent": AgentView }` |
| GET | `/api/agents/:id` | – | `{ "agent": AgentView }` |
| PUT | `/api/agents/:id` | `AgentDefinition` | `{ "agent": AgentView }` (custom only) |
| DELETE | `/api/agents/:id?force=1` | – | `204` (custom only) |

* A custom id that collides with a built-in is `409 conflict`; a built-in is never editable
  or deletable (`409`).
* Two `sharedPaths` of one definition that produce the same slug (see below) are a
  `422 validation_error` — they would be the same directory in the auth volume.
* Every `sharedPaths[].path` and `historyPath` must start with `~/` or `/` and must not
  contain a `..` segment (`422 validation_error`): the bootstrap turns them into symlinks
  inside the session container, so a traversal would point the link — and everything the
  agent writes through it — outside that agent's auth volume.
* `DELETE` is `409` while a host enables the agent or a session pins it; `force=1` also
  strips the id from those hosts/sessions (their containers keep the mount until recreated).

### Per host

```
GET /api/hosts/:hostId/agents  -> { "agents": HostAgentView[], "enabled": ["claude"] }
PUT /api/hosts/:hostId/agents  { "enabled": ["claude","opencode"] } -> same shape
```

`HostAgentView` = `AgentView` + `{ enabled, installed, version, installedAt, error,
authVolume }`. `installed`/`version` come from `<toolsMount>/AGENTS.json` inside that host's
tools volume (written by the last tools sync); an unreachable host answers `installed:false`
plus an `error` string instead of a 502.

Enabling an agent does **not** install it: run `POST /api/hosts/:hostId/images/tools/sync`
afterwards (the UI offers it right there), and recreate the sessions that should mount it.

**Upgrading an installed agent needs `{"force": true}`.** The tools sync carries an agent
over whenever its install spec is unchanged, and a spec does not change when upstream ships a
new release — so a plain sync leaves `version` where it is forever. `force:true` passes
`PORTERCLAUDE_TOOLS_FORCE=1` into the populate container: no carry-over, every enabled agent
(and the bundled Node/Python runtime) is reinstalled, resolving its channel / `latest` again.
Sessions that are running keep the payload they started with until they are restarted.

## Sessions

`SessionInput` gains two fields; everything else is unchanged:

```json
{ "name": "web",
  "hostId": "prod",        // optional on create (=> defaultHostId); IMMUTABLE afterwards
  "agents": null,          // null = every agent enabled on the host; or an explicit id list
  "...": "image, workspace, env, ports, extraMounts, limits, shareHistory, autoStart, network, user" }
```

`SessionView` gains:

```json
{ "hostId": "prod", "hostName": "Prod (portainer)", "hostMissing": false,
  "agents": null, "resolvedAgents": ["claude", "opencode"] }
```

* `PUT /api/sessions/:name` with a different `hostId` is `422 validation_error`
  ("the host of a session is immutable"). Moving = create the session on the other host.
* An `agents` list naming an id the registry does not know is `422 validation_error`
  ("unknown agent id(s): …") on create and update — the same rule as
  `PUT /api/hosts/:hostId/agents`. `null` (inherit the host) and `[]` stay legal.
* `GET /api/sessions?hostId=<id>` filters; without it every host's sessions are returned
  (sorted by name). A host that is unreachable does not fail the call: its sessions come back
  with `status:"absent"` and a warning.
* `hostMissing: true` marks a session whose host was deleted with `force=1`: it is read-only
  until it is deleted or a host with that id exists again.
* `resolvedAgents` is what the container really mounts. Changing the host's enabled set makes
  the stored sessions report `needsRecreate: true` (the spec hash covers the agent mounts) —
  that is intentional: the new agent only appears after a recreate.
* `shareHistory: false` now gives the session one private history volume **per agent that
  declares a `historyPath`**: `<volumePrefix>hist-<slug>` for claude (the v0.1 name, so an
  upgraded session keeps its history) and `<volumePrefix>hist-<slug>-<agentId>` for the rest.
* `DELETE …?removeVolumes=1` removes the workspace volume and those history volumes — never
  an auth volume (that would delete the login of every session on the host).

## Images, jobs and the tools volume (per host)

Every v0.1 `/api/images/...` route moved verbatim under `/api/hosts/:hostId/images/...`:

```
GET  /api/hosts/:hostId/images                      { images }
GET  /api/hosts/:hostId/images/recipes              { recipes }
POST /api/hosts/:hostId/images/recipes/:name/build  202 { job }
GET  /api/hosts/:hostId/images/jobs                 { jobs }        (this host only)
GET  /api/hosts/:hostId/images/jobs/:id?since=<n>   { job, lines, nextIndex }
POST /api/hosts/:hostId/images/jobs/:id/cancel      { job }
GET  /api/hosts/:hostId/images/tools                { status }
POST /api/hosts/:hostId/images/tools/sync           202 { job }
POST /api/hosts/:hostId/images/custom/validate      { result }
POST /api/hosts/:hostId/images/pull                 202 { job }
```

* `JobSummary` gains `"hostId"`. Job ids stay globally unique, so `…/jobs/:id` is still a
  direct lookup; a job of another host answers `404`.
* "already running" conflicts are per host: building `node` on host A never blocks host B.
* `ToolsStatus` gains `hostId` and `agents`:

```json
{ "status": { "hostId": "prod", "volume": "porterclaude-tools",
              "imageRef": "porterclaude/tools:latest", "present": true,
              "lastSyncedAt": "…", "contextHash": "9f86…", "outdated": false,
              "syncing": false, "jobId": null, "error": null,
              "claudeVersion": "2.1.233", "claudeChannel": "stable",
              "agents": [ { "id": "claude", "installed": true, "version": "2.1.233",
                            "installedAt": "…", "error": null },
                          { "id": "opencode", "installed": false, "version": null,
                            "installedAt": null, "error": "download failed: 404" } ] } }
```

  `claudeVersion`/`claudeChannel` are kept for compatibility and mirror the `claude` entry of
  `agents`. `error` says why the status is incomplete (no usable transport, or reading the
  volumes / tools image / `AGENTS.json` failed) and is `null` when everything could be read —
  that is what separates "nothing was ever synced here" from "the engine did not answer"; the
  same string is what an unreachable host puts into every `HostAgentView.error`. A read that
  FAILED is never cached, so a host that comes back reports the truth on the next poll.
* `POST …/tools/sync` installs **every agent enabled on that host** into the volume and
  writes `AGENTS.json`. A single agent that fails to install is a warning in the job log and
  `installed:false` in the manifest — the job still succeeds.
* The same sync performs the **one-time legacy claude import** on a migrated host: the
  content of the v0.1 `sharedClaudeVolume` / `sharedClaudeHomeVolume` is copied into
  `<volumePrefix>auth-claude` (marker `.pc-import-v1`). The old volumes are never deleted.

## WebSocket: terminals

```
GET /api/terminals?session=<slug>&shell=bash|sh|agent:<agentId>&name=<terminal>&cols=<n>&rows=<n>
```

* No host parameter: the server resolves `session → hostId → backend`.
* `shell=claude` is still accepted and means `agent:claude` (deprecated; the UI must send
  `agent:claude`).
* An unknown `shell` value is close `4400`.

`ready` (first text frame) gains two fields:

```json
{ "type": "ready", "terminalId": "8f…", "session": "web", "hostId": "prod",
  "shell": "agent", "agentId": "claude", "name": "main",
  "tmux": true, "reattached": false, "cols": 120, "rows": 32 }
```

New error codes / close codes:

| code | close | when |
|---|---|---|
| `agent_not_available` | `4410` | the agent is unknown, not mounted into this session, or mounted but missing from the host's tools volume (`AGENTS.json` says not installed — run the tools sync) |
| `host_unavailable` | `4411` | the session's host is gone or its connection type is unsupported |

Both are **terminal** conditions: the client must not auto-reconnect on 4410/4411 (same rule
as 4401), it shows the reason and offers "open a bash terminal" / "check the host".

## Container contract (what the UI can rely on)

```
labels   porterclaude.managed=true
         porterclaude.session=<slug>
         porterclaude.host=<hostId>            (v0.2)
         porterclaude.agents=<id,id,…>          (v0.2)
         porterclaude.image-type=recipe|custom
         porterclaude.recipe=<name>            (recipes only)
         porterclaude.spec-hash=<sha256>
         porterclaude.created-at=<iso>
mounts   <volumePrefix>auth-<agentId> -> <containerHome>/.porterclaude/agents/<agentId>
         <volumePrefix>hist-<slug>[-<agentId>] -> <agentDir>/<sharedPathSlug>/…  (shareHistory=false)
         workspace                    -> <workspaceMount>
         <toolsVolume> (read-only)    -> <toolsMount>          (EVERY session in v0.2)
env      PORTERCLAUDE_SESSION, PORTERCLAUDE_HOST, PORTERCLAUDE_TOOLS, PORTERCLAUDE_HOME,
         HOME, PATH, PORTERCLAUDE_AGENT_IDS, PORTERCLAUDE_AGENT_LINKS, TERM
entrypoint ["<toolsMount>/entrypoint.sh"]      (recipes keep their image CMD)
```

The agent's own paths are **symlinks** into its auth volume, created by the bootstrap:
`~/.claude -> <agentDir>/claude`, `~/.claude.json -> <agentDir>/claude.json`. The slug of a
shared path is the whole path with `~/` and leading dots stripped and `/` replaced by `-`
(`~/.local/share/opencode` → `local-share-opencode`).

## Config file (v2)

```json
{ "version": 2,
  "auth": { "...": "unchanged" },
  "hosts": [ HostConfig ],
  "defaultHostId": "default",
  "credentials": { "portainer": [ PortainerCredentialConfig ] },
  "agents": { "custom": [ AgentDefinition ] },
  "general": { "...": "+ volumePrefix; sharedClaude*Volume are legacy-only now" },
  "sessions": [ "SessionConfig + hostId + agents" ],
  "ui": { "...": "unchanged" } }
```

Migration v1 → v2 runs on first boot, is lossless, and writes `config.json.v1.bak` before the
first v2 write: the single backend becomes the host `default` (+ a `portainer-1` credential
when it was a Portainer backend, re-using the already-encrypted key), every session gets
`hostId: "default"` and `agents: null`, and `general` is carried over unchanged.

Env seeds keep their v0.1 names (`PORTERCLAUDE_BACKEND`, `PORTAINER_URL`,
`PORTAINER_API_KEY`, `PORTAINER_ENDPOINT_ID`, `DOCKER_SOCKET`) but now create the first host
instead of a global backend, and only while no host exists.
