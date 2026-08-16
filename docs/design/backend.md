# PorterClaude — backend design (`server/`)

> **v0.2 (hosts + agents): the [v0.2 section](#v02--hosts-and-agents-authoritative-from-here-down)
> at the bottom supersedes every statement above that it contradicts.**

Companion to [`api.md`](api.md), which is the wire contract. This doc is the internal
design: module layout, ownership, key flows, error handling, and what QA should test.

Deviations from `PLAN.md` (product owner's call, they win): **Express 5 + `ws`** instead of
Fastify; the web UI is Bootstrap/jQuery/GoldenLayout ES modules, no bundler.

## 1. Monorepo layout

```
package.json            npm workspaces ["server","web"], root dev deps (typescript, eslint)
tsconfig.base.json      shared compilerOptions (ES2023, NodeNext, strict)
eslint.config.js        flat config, JS + TS recommended, no type-aware rules
server/
  package.json          @porterclaude/server, "type":"module"
  tsconfig.json         build config (rootDir src, outDir dist)
  tsconfig.test.json    typecheck-only, includes test/
  vitest.config.ts      node environment, test/**/*.test.ts
  src/…                 see §2
  test/core/…           B1 tests
  test/features/…       B2 tests
web/                    owned by the WEB topic (this topic only serves it statically)
docker/                 owned by the ORCHESTRATION topic (recipes/, tools/)
```

Root scripts: `dev` (tsx watch on the server), `build`, `start`, `typecheck`, `lint`,
`test` — all delegate to workspaces with `--if-present`.

**Module system**: ESM + `moduleResolution: NodeNext`. Every relative import **must end in
`.js`** (`import { x } from './util/slug.js'`) even from `.ts` files. Type-only imports
should use `import type` (`isolatedModules` is on).

**Test runner**: vitest (TS out of the box, no build step, familiar API). `npm test` runs
`vitest run` in the server workspace.

## 2. Module map and ownership

| Path | Owner | Purpose |
|---|---|---|
| `src/index.ts` | B1 | process entry: build context, HTTP+WS listen, shutdown |
| `src/app.ts` | B1 | Express app factory (middleware order documented in the file) |
| `src/env.ts` | B1 | zod-validated `process.env` |
| `src/logger.ts` | B1 | pino, with secret redaction |
| `src/vendor.ts` | **FROZEN** | `VENDOR_ROUTES` + `mountVendorRoutes` (B1 implements bodies) |
| `src/paths.ts` | **FROZEN** | every filesystem location, derived from `Env` |
| `src/context.ts` | **FROZEN** | `AppContext` / `ServiceDeps` types |
| `src/http/errors.ts` | **FROZEN** | `AppError`, `DockerApiError`, error codes (implemented) |
| `src/http/async.ts` | **FROZEN** | `asyncHandler` (implemented) |
| `src/http/validate.ts` | **FROZEN** | `parseBody/parseQuery/parseParams` (implemented) |
| `src/util/slug.ts` | **FROZEN** | slug rules, `tmuxSessionName`, `shQuote` (implemented) |
| `src/util/ids.ts` | **FROZEN** | `uuid`, `shortId` (implemented) |
| `src/config/schema.ts` | **FROZEN** | config.json shape + settings payload schemas (implemented) |
| `src/config/crypto.ts` | B1 | master secret, AES-GCM secret box, scrypt passwords |
| `src/config/store.ts` | B1 | atomic config store, env seeding, sessions storage |
| `src/auth/index.ts` | B1 | `AuthService`, `requireAuth`, `authenticateUpgradeRequest` |
| `src/auth/routes.ts` | B1 | `/api/auth` |
| `src/backends/types.ts` | **FROZEN** | `DockerBackend` + all DTOs |
| `src/backends/portainer.ts` | B1 | Portainer transport (fetch + `X-API-Key` + ws exec) |
| `src/backends/socket.ts` | B1 | dockerode transport + shared mapping helpers |
| `src/backends/index.ts` | B1 | `BackendManager` (cache, invalidate, test, endpoints) |
| `src/routes/index.ts` | **FROZEN** | the only mount table (implemented) |
| `src/routes/health.ts` | B1 | `/api/health` |
| `src/routes/settings.ts` | B1 | `/api/settings` |
| `src/routes/docker.ts` | B1 | `/api/docker` read-only helpers |
| `src/sessions/model.ts` | **FROZEN** | zod session model, labels, volume naming (implemented) |
| `src/sessions/container.ts` | B2 | `SessionConfig` → `CreateContainerSpec`, `specHash` |
| `src/sessions/service.ts` | B2 | lifecycle, reconcile, `requireRunningContainer` |
| `src/sessions/routes.ts` | B2 | `/api/sessions` |
| `src/terminals/protocol.ts` | **FROZEN** | WS wire protocol types + close codes (implemented) |
| `src/terminals/service.ts` | B2 | exec creation, tmux detection, command matrix |
| `src/terminals/ws.ts` | B2 | `attachTerminalWs(server, ctx)` |
| `src/images/recipes.ts` | **FROZEN** | recipe registry (implemented) |
| `src/images/tarContext.ts` | B2 | tar-fs build context + context hashing |
| `src/images/service.ts` | B2 | builds, jobs, tools volume, custom-image validation |
| `src/images/routes.ts` | B2 | `/api/images` |

**FROZEN** = written by the planner. Bodies marked `TODO(B1)` inside a frozen file are the
listed owner's job, but **no exported name, signature or type may change**. Anything else
is a cross-topic change: raise it, do not just edit.

Because `routes/index.ts` already imports both coders' routers and `index.ts` already
knows `attachTerminalWs`, B1 and B2 never touch the same file.

## 3. Boot sequence

1. `loadEnv()` — zod over `process.env` (dotenv loads `.env` in development only).
2. `createLogger(env)` — pino; pretty in dev, JSON in prod; redacts cookies, `apiKey`,
   `password`.
3. `resolvePaths(env)`; `mkdir -p paths.dataDir`.
4. `loadOrCreateMasterSecret(paths.secretFile, env.APP_SECRET)` → `new SecretBox(secret)`.
   No `APP_SECRET` → generate 32 random bytes, write `secret.key` with mode `0600`.
5. `new ConfigStore({paths, env, log, secrets})` → `await store.init()`:
   read/create `config.json`, migrate by `version`, then seed **only what is unset**:
   `APP_PASSWORD` → `auth.passwordHash` (when null), `PORTERCLAUDE_BACKEND`/`PORTAINER_*`
   → `backend.*` (when `backend.kind === 'none'`).
6. `new BackendManager({config, env, log})`; `config.on('change', () => backends.invalidateIfChanged())`
   — the instance is only rebuilt when the *backend* section actually changed (UI layout
   autosave, session writes and password changes must not tear down a transport that
   still carries running builds/pulls/execs).
7. `new SessionService(deps)`, `new ImageService(deps)`, `new TerminalService(deps, sessions)`.
8. `createAuthService(...)`, assemble `AppContext`.
9. `createApp(ctx)` → `http.createServer(app)`.
10. `attachTerminalWs(server, ctx)`.
11. `server.listen(env.PORT, env.HOST)`.
12. Best-effort `sessions.reconcile()` — failures are logged, never fatal. **The server must
    start with no backend configured**; that is the first-run state.
13. `SIGINT`/`SIGTERM` → `terminals.closeAll()`, `server.close()`, `backends.close()`,
    exit 0 (force-exit after 10 s).

## 4. Configuration

`<DATA_DIR>/config.json` (default `./data`, `/data` in the image) is the source of truth
after first boot; env vars only seed it. Shape: `config/schema.ts`.

* **Atomic writes**: serialise through an internal promise chain, write
  `config.json.<pid>.tmp` in the same directory, `fsync`, `rename`. A crash never leaves a
  partial file. Mode `0600`.
* **Secrets at rest**: `enc:v1:<ivB64>:<tagB64>:<ctB64>`, AES-256-GCM, key =
  `scrypt(masterSecret, "porterclaude:config:v1", 32)`. The JWT signing key is
  `hkdf(masterSecret, "porterclaude:jwt:v1")` — a rotated `APP_SECRET` therefore logs
  everyone out and makes the stored Portainer key undecryptable (surface that as
  `apiKeySet:false` + a warning, never a crash loop).
* **Passwords**: `scrypt:<N>:<r>:<p>:<saltB64>:<hashB64>` (N=16384, r=8, p=1), compared
  with `timingSafeEqual`. No native dependency.
* Sanitized projections (`ConfigStore.sanitized`) are the only thing the API returns.

## 5. Auth

Single user, single password. `POST /api/auth/login` verifies against
`auth.passwordHash`, then sets `pc_session`: a HS256 JWT `{sub:'admin', v:tokenVersion,
iat, exp}` with `SESSION_TTL_DAYS` (default 30), `httpOnly`, `sameSite:'lax'`, `path:'/'`,
`secure` per `COOKIE_SECURE` (`auto` = the request arrived over https, honouring
`X-Forwarded-Proto` since `trust proxy` is on).

`requireAuth` rejects with the canonical 401 envelope. Password change bumps
`auth.tokenVersion`, which invalidates every previously issued cookie (the JWT carries
`v`), and immediately re-issues one for the current browser. Login is rate limited
(`express-rate-limit`, 10 / 15 min / IP).

WebSocket upgrades reuse the same cookie via `authenticateUpgradeRequest(req, ctx)`; an
unauthenticated upgrade is answered with a raw `HTTP/1.1 401` and the socket destroyed —
the handshake is never completed.

Static files are **not** gated: the SPA loads, calls `GET /api/auth/session` and shows its
login screen. Nothing sensitive is in the static bundle.

## 6. Docker backends

`DockerBackend` (`backends/types.ts`) is the whole surface. Both implementations speak the
Docker Engine API; only transport, auth and the exec stream differ.

### PortainerBackend
* REST: `{url}/api/endpoints/{endpointId}/docker{enginePath}`, header `X-API-Key`.
  Global `fetch` (Node 22). `insecureTls` → a custom `undici` Agent / `https.Agent` with
  `rejectUnauthorized:false` (only when explicitly enabled).
* Build: `POST …/docker/build?t=<tag>&dockerfile=Dockerfile[&nocache=1&pull=1]`, body =
  the tar stream, `Content-Type: application/x-tar`; response is JSON-lines progress.
  Node's fetch needs `duplex: 'half'` when the body is a stream.
* Exec: `POST …/docker/containers/{id}/exec` → `{ Id }`, then connect
  `wss://<portainer-host>/api/websocket/exec?endpointId=<id>&id=<execId>` with the
  `X-API-Key` header (verified against Portainer EE 2.39 — this is why the terminal runs
  through our server and not the browser: browsers cannot set WS headers). Portainer
  starts the exec when the socket opens; **do not** also call `/exec/{id}/start`.
  Resize goes over REST: `POST …/docker/exec/{execId}/resize?h=<rows>&w=<cols>`.
* Endpoint picker: `GET {url}/api/endpoints` (Portainer's own API, not the docker proxy).

### SocketBackend
* dockerode over `socketPath` (default `/var/run/docker.sock`).
* Exec: `exec.start({hijack:true, stdin:true})` → duplex. With `Tty:true` the stream is raw;
  with `Tty:false` demultiplex the 8-byte header (`docker.modem.demuxStream`).
* `SocketBackend.isAvailable(path)` powers the "socket detected" hint in Settings.

### Shared rules
* Request/response mapping (`CreateContainerSpec` → docker JSON, docker `State` → our
  `ContainerState`, label filters → the `filters` query param) lives in `dockerMap` in
  `socket.ts` and is reused by the Portainer backend — write it once.
* Every API failure becomes `DockerApiError(message, dockerStatus, details)`; docker 404
  keeps status 404 so services can distinguish "missing" from "broken".
* `BackendManager.get()` throws `AppError.backendNotConfigured()` when settings are
  incomplete; `tryGet()` returns null (health, settings screen). The instance is cached and
  dropped only when the backend settings change (`invalidateIfChanged()`); `close()` on the
  old instance never destroys sockets that still carry in-flight requests.
* Nothing in this layer ever logs the API key or the raw `X-API-Key` header.

## 7. Sessions

Model, labels and volume names: `sessions/model.ts` (frozen).

Container layout produced by `buildContainerSpec`:

```
name        pc-<slug>                                  (general.containerPrefix)
labels      porterclaude.managed=true
            porterclaude.session=<slug>
            porterclaude.image-type=recipe|custom
            porterclaude.recipe=<name>                 (recipes only)
            porterclaude.spec-hash=<sha256>
            porterclaude.created-at=<iso>
mounts      porterclaude-claude        -> /home/dev/.claude
            porterclaude-claude-home   -> /home/dev/.claude-home
            <workspace>                -> /workspace          bind | porterclaude-ws-<slug>
            porterclaude-tools (ro)    -> /opt/porterclaude   (custom images only)
            porterclaude-hist-<slug>   -> /home/dev/.claude/projects   (shareHistory=false)
env         PORTERCLAUDE_SESSION=<slug>, TERM=xterm-256color, + user env
            custom images: PORTERCLAUDE_TOOLS=/opt/porterclaude, PORTERCLAUDE_HOME=/home/dev,
                           HOME=/home/dev,
                           PATH=/opt/porterclaude/bin:/home/dev/.local/bin:<image PATH>
custom      entrypoint ["/opt/porterclaude/entrypoint.sh"], cmd ["sleep","infinity"]
recipes     entrypoint/cmd from the image (sleep infinity)
workingDir  /workspace   init true   pidsLimit 4096
restart     autoStart ? unless-stopped : no
resources   cpus -> NanoCpus, memoryMb -> Memory
```

Flows
* **HOME for custom images**: docker inherits `HOME` from the image, which is `/root` for
  the root images people usually pick — claude would then write `~/.claude` and
  `~/.claude.json` to `/root`, outside the shared volumes, and "log in once, every session
  authenticated" would silently not hold. `buildContainerSpec` therefore pins
  `HOME=<containerHome>` for custom images (recipes already have it right). A user-supplied
  `env.HOME` still wins. A root custom image writes into the uid-1000 shared volume as
  root, so `validateCustomImage` warns about it.
* **non-root custom images** (session `user`, or an image with its own `USER`): docker
  creates the mountpoint parent `<containerHome>` in the container layer as `root:root`,
  so the tools entrypoint - which runs as that unprivileged uid - can write neither
  `/etc/profile.d/porterclaude.sh` nor `$HOME/.profile` / `.bashrc` (no PATH persistence)
  nor the `$HOME/.claude.json` symlink, and the root-only `/usr/local/bin/claude` wrapper
  is not installed either. Without help such a session has no usable `claude` at all.
  The contract is therefore:
  1. `buildContainerSpec` pins `PATH=<toolsMount>/bin:<containerHome>/.local/bin:<image
     PATH>` in the **container env** (the image PATH comes from `inspectImage`; the docker
     default is the fallback). Every `docker exec` inherits it, so no rc file is needed.
     `SessionView.needsRecreate` recomputes the spec with the image PATH recovered from the
     container env (`imagePathFromEnv`), otherwise custom sessions would flap.
  2. `afterStart` runs `chown <user> <containerHome>` (plus the shared claude dirs when they
     are still root-owned) as **uid 0** via exec - the only way in, since nothing inside the
     container runs as root before the entrypoint - and then re-runs
     `<toolsMount>/entrypoint.sh --porterclaude-bootstrap` as the session user, which now
     persists PATH and links `~/.claude.json`. Both steps are best effort.
  3. The same root exec installs the two files the re-bootstrap still cannot write,
     because it runs as the session user: `/etc/profile.d/porterclaude.sh` (sourced by
     every login shell *after* `/etc/profile` has hard-set PATH — alpine and debian both
     do — so `bash -l` terminals and tmux panes find `<toolsMount>/bin` even without an rc
     file in `$HOME`) and the `/usr/local/bin/claude` wrapper (so `claude` resolves in an
     exec that starts from the standard PATH). Both are marker-guarded
     (`# porterclaude (generated)`): a `claude` or profile snippet the image itself ships
     is never overwritten, and the PATH export is skipped when the prefix is already
     there. `start` and `restart` re-run all of this (idempotent), which is how a user
     applies a tools-volume update to a running session.
  4. `TerminalService.open` additionally passes `PATH` in the exec env and re-exports it
     inside the `sh -lc` command (see section 8), because a login shell re-sources
     `/etc/profile`, which on Debian & co overwrites PATH unconditionally.
* **private history**: `porterclaude-hist-<slug>` overlays `<home>/.claude/projects`, a
  path *inside* the shared claude volume. If that directory does not exist yet, docker
  creates it as `root:root` while wiring the mount and the fresh history volume is
  root-owned too — the session cannot write its own history and, worse, the root-owned
  `projects` directory stays behind in the SHARED volume and breaks history for every other
  session. `create`/`recreate` therefore run a one-shot root container first
  (`porterclaude-histinit-<rand>`, *not* labelled `porterclaude.managed`) which mounts the
  shared volume at its real path (so docker's empty-volume seeding still copies the image's
  uid-1000 ownership) plus the history volume at `/pc-hist`, creates `projects` and chowns
  both to the owner of the shared volume root. It is best effort: a failure becomes a
  session warning. In addition every start runs a root exec that re-creates/re-chowns
  `<home>/.claude/projects`, which self-heals volumes damaged by older builds.
* **create**: validate name free (config **and** container) → `ensureSharedVolumes()` →
  create the workspace/history volumes → resolve the image (recipe → `<ns>/<recipe>:latest`,
  must exist, else `409` "recipe not built"; custom → pull when missing) → `createContainer`
  → `startContainer` when `autoStart` → persist the config **after** a successful create
  (roll the container back if persisting fails).
* **update (edit)**: build the new spec, stop → remove container (volumes kept) → create →
  start if it was running or `autoStart`. Volumes and workspace survive by construction.
* **remove**: stop (5 s timeout) → remove container → optionally remove
  `porterclaude-ws-<slug>` / `porterclaude-hist-<slug>` (never the shared volumes) → drop
  the config entry.
* **reconcile**: list containers filtered by `porterclaude.managed=true`; match on the
  `porterclaude.session` label. Containers without a stored config are shown as
  `orphan:true` views whose definition is reconstructed from labels + inspect, so losing
  `/data` does not lose your sessions. The reconstruction is **lossless as far as docker
  remembers**: name/image/workspace/shareHistory/user plus `env` (Config.Env minus the
  image's own env and minus everything `buildContainerSpec` sets), `ports`
  (HostConfig.PortBindings, runtime bindings as fallback), `extraMounts` (every mount that
  is not one of ours), `limits` (NanoCpus/Memory), `network` (NetworkMode) and `autoStart`
  (RestartPolicy) - because that definition is what a later Recreate/Edit rebuilds from.
  **Adoption** (persisting it) only happens on an explicit user action: `POST
  /api/sessions/reconcile` (`reconcile({adopt:true})`), or the first
  `start`/`recreate`/`PUT` on the session. The startup `reconcile()` deliberately does not
  adopt, so an orphan stays visible as `orphan:true` instead of being silently rewritten
  into a reconstructed definition. A freshly adopted session does not report
  `needsRecreate` (its definition describes that container by construction). Stored
  sessions with no container get `status:'absent'`. `needsRecreate` = the container's
  `spec-hash` label differs from the hash of the spec the current config would produce.
* **git workspace**: the volume is seeded on first start with a `git clone` exec inside the
  container (the recipe images ship git); failures become a `warnings[]` entry, not a 500.

`list()` must degrade gracefully: if the backend is unreachable, return the stored configs
with `status:'absent'` and a warning instead of failing the whole page.

## 8. Terminals

`TerminalService.open()` → `ExecStream`; `attachTerminalWs` bridges it to the socket. The
wire protocol is in `terminals/protocol.ts` and documented in `api.md` §WebSocket.

Command matrix (`buildTerminalCommand`):

| tmux | shell | command |
|---|---|---|
| yes | bash | `sh -lc "exec tmux new-session -A -s pc_<name> <login> -l"` |
| yes | claude | `sh -lc "exec tmux new-session -A -s pc_<name> sh -lc 'claude; exec <login> -l'"` |
| yes | sh | `sh -lc "exec tmux new-session -A -s pc_<name> sh -l"` |
| no | bash | `["bash","-l"]` (→ `["sh","-l"]` when bash is missing) |
| no | claude | `["sh","-lc","claude; exec <login> -l"]` |
| no | sh | `["sh","-l"]` |

`<login>` is `bash` when the container has bash and `sh` otherwise. The fallback applies to
the **tmux rows too**: the tools entrypoint installs tmux into images that ship no bash
(alpine & co), where `tmux new-session … bash -l` cannot spawn its pane command and the
exec exits immediately. `command -v bash` is therefore probed on every open (cached like
the tmux probe), not only when tmux is missing.

* `tmux new-session -A` attaches when `pc_<name>` exists and creates it otherwise — that is
  the entire reconnect story. `reattached` in the `ready` message comes from a
  `tmux has-session -t pc_<name>` probe **before** starting the exec.
* tmux presence is probed with `command -v tmux` through `runExec`, cached ~60 s per
  container id (a `tools` sync or a package install can change it).
* Exec env: `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG=C.UTF-8`; `workingDir`
  `/workspace`; `user` from the session config when set. **Custom images** additionally get
  `PATH=<toolsMount>/bin:<containerHome>/.local/bin:<container PATH>` (read from
  `inspectContainer`, cached per container like the probes), and every `sh -lc` row is
  prefixed with `PATH='<toolsMount>/bin:<containerHome>/.local/bin':$PATH; export PATH; `.
  The prefix runs *after* `sh -l` sourced `/etc/profile`, which is what makes `claude`
  resolvable in an image that resets PATH there and cannot write an rc file (section 7).
* Resize: `{type:'resize'}` → `stream.resize()` → `execResize` (REST on both backends).
* Backpressure: drop the socket when `ws.bufferedAmount` exceeds 4 MiB.
* Shutdown: `terminals.closeAll()` closes every exec stream and socket with code 1000.

Known caveat (documented, accepted): with no tmux in a custom image, a browser reload
starts a fresh shell and kills a running `claude`. The `ready.tmux:false` flag lets the UI
warn.

## 9. Images

* `RECIPES` (frozen) names must equal the directories `docker/recipes/<name>/`.
  Tag: `<general.imageNamespace>/<name>:latest`, i.e. `porterclaude/node:latest`.
* Build: `createTarContext({dir: <recipesDir>/<name>, extraFiles:[common.sh]})` streamed to
  `backend.buildImage`, with labels `porterclaude.recipe`, `porterclaude.context-hash`,
  `porterclaude.built-at` (and `porterclaude.claude-version` when the Dockerfile emits one
  as a build arg/label). `outdated` = stored `context-hash` ≠ freshly computed hash. This
  needs no network, so it works offline and on arm64 alike.
* Jobs are in-memory only (`Map<string, Job>`, ≤50 jobs, ≤2000 log lines each, older jobs
  evicted). They are lost on restart — the UI polls and simply shows "no job".
  A build for a recipe that is already building → `409 conflict`.
* Tools volume: build `<ns>/tools:latest` from `docker/tools/` → ensure the volume →
  run a one-shot container with the volume mounted rw at `/out` → `waitContainer` →
  non-zero exit fails the job → remove the container. The image's `CMD` writes the native
  `claude` binaries (glibc + musl) and `entrypoint.sh` into `/out`.
  **Contract with the orchestration topic**: `docker/tools/Dockerfile` exists, its default
  command populates `/out`, and the result contains an executable `entrypoint.sh`.
* Custom image validation: `inspectImage` → pull when absent → report architecture, image
  user, and warnings (no tmux → no reconnect persistence; no package manager → degraded).

## 10. Error handling

* Handlers use `asyncHandler` so rejections reach the terminal error middleware.
* `AppError` → `err.status` + `err.toBody()`. Unknown errors → `500 {code:'internal',
  message:'internal error'}` with the real error logged at `error` level.
* Unmatched `/api/**` → `404 {code:'not_found'}`; unmatched non-API GET → `index.html`.
* Express 5 note: path-to-regexp v8 rejects a bare `'*'` route — the SPA fallback is a
  terminal `app.use()` handler, not `app.get('*')`.
* Never leak stack traces, docker raw error bodies with credentials, or the API key.

## 11. Environment variables

| Var | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | listen address |
| `DATA_DIR` | `./data` (`/data` in the image) | config + secret key |
| `APP_PASSWORD` | – | first-run password seed |
| `APP_SECRET` | auto (`<DATA_DIR>/secret.key`) | encryption + JWT key material |
| `PORTERCLAUDE_BACKEND` | – | `socket` / `portainer` seed |
| `PORTAINER_URL` / `PORTAINER_API_KEY` / `PORTAINER_ENDPOINT_ID` | – | Portainer seed |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | socket path |
| `LOG_LEVEL` | `info` | pino level |
| `COOKIE_SECURE` | `auto` | `auto` / `true` / `false` |
| `TRUST_PROXY` | `1` | Express `trust proxy` value |
| `SESSION_TTL_DAYS` | `30` | cookie lifetime |
| `PORTERCLAUDE_DOCKER_DIR` | `<repo>/docker` | recipes + tools contexts |
| `WEB_DIR` | `<repo>/web/public` | static root |
| `ENABLE_REQUEST_LOG` | `true` | pino-http on/off |

## 12. Test plan hints (for QA)

Unit / integration (vitest, no docker host required):
* `SecretBox` round-trip; wrong master secret fails cleanly.
* `hashPassword`/`verifyPassword`; malformed hash → `false`, never a throw.
* `ConfigStore`: fresh `DATA_DIR` → defaults + `APP_PASSWORD` seeded; re-init keeps the
  hash; `update()` is atomic (kill mid-write leaves valid JSON) and emits `change`;
  `sanitized()` never contains the api key (grep the JSON for the key string).
* Auth: `/api/health` without a cookie → 200; `/api/settings` without a cookie → 401;
  login → cookie; password change → the old cookie stops working (supertest agent).
* `buildContainerSpec`: labels, mounts, custom-image entrypoint, `shareHistory:false`
  extra volume, cpu/memory translation, restart policy. `specHash` stability.
* `buildTerminalCommand`: all six combinations; a terminal name with quotes/spaces is
  shell-quoted and cannot break out.
* `SessionService` with a stubbed `DockerBackend`: create/update/remove call the expected
  backend methods in the expected order; `list()` marks orphans and `needsRecreate`.
* `hashContext` determinism.
* Route table: every path in `api.md` exists (a 404-sweep test is cheap and catches typos).

Manual / integration against a real engine (integration QA):
* Socket mode on a Linux docker host, Portainer mode against the reference instance:
  Settings → test connection → endpoint list → save → containers list.
* Create a session from the `node` recipe → start → open a `bash` terminal → `claude` →
  `/login` → open a second session → `claude` is already authenticated.
* Reload the browser mid-`claude`: the pane reattaches (tmux) and output continues.
* Resize the pane → `stty size` inside the container matches.
* Edit a session (change env/ports) → recreate → the workspace volume still has its files.
* Kill the container from outside → the Sessions tab shows `exited`; `reconcile` recovers a
  container after deleting `config.json`.
* Build a recipe from Settings → Images: log lines stream via polling, `built` flips to
  true, `outdated` flips after touching the Dockerfile.

---

# v0.2 — hosts and agents (AUTHORITATIVE from here down)

Sections 1–12 above describe v0.1. Where they disagree with this section, **this section
wins**. The wire contract is `api.md` §"v0.2 — hosts and agents".

## 11.1 What v0.2 changes, in one paragraph

The single global docker backend becomes **N hosts**; Claude Code becomes **N agents**.
Both are data, not code paths: a host is `{id, name, connection}` and a `HostManager` hands
out one `DockerBackend` per host; an agent is an `AgentDefinition` and everything that used
to be claude-specific (installation, shared volume, terminal command, images panel) is
driven by that definition. Nothing is shared between hosts — no volumes, no images, no
logins, no sync.

## 12 Module map (v0.2 delta)

| Path | Owner | Purpose |
|---|---|---|
| `src/config/fields.ts` | **FROZEN** | the shared field validators + `GENERAL_FIELD_SCHEMAS` (leaf module: breaks the schema↔hosts import cycle) |
| `src/config/schema.ts` | **FROZEN** | config v2: `hosts[]`, `defaultHostId`, `credentials`, `agents.custom`, `general.volumePrefix` |
| `src/config/store.ts` | B1 | + host/credential/agent accessors, **v1→v2 migration**, new env seeds, new `sanitized()` |
| `src/hosts/model.ts` | **FROZEN** | `HostConfig`, `HostConnection` (socket/portainer + reserved tcp/ssh), `HostView`, credential shapes, `slugifyHostId`/`uniqueHostId`/`connectionLabel` |
| `src/hosts/manager.ts` | B1 | `HostManager`: per-host backend cache, `settingsFor`, CRUD, probe/views, portainer import, `legacyAccess()` |
| `src/hosts/credentials.ts` | B1 | `CredentialStore`: portainer credentials, the ONLY place the api key is decrypted |
| `src/hosts/routes.ts` | B1 | `/api/hosts` |
| `src/hosts/credentialRoutes.ts` | B1 | `/api/credentials` |
| `src/agents/model.ts` | **FROZEN** | `AgentDefinition` + the pure layout helpers (volume names, links, history target, slugs) |
| `src/agents/builtin.ts` | **FROZEN** | the five built-in agents + `DEFAULT_ENABLED_AGENT_IDS` |
| `src/agents/registry.ts` | B1 | `AgentRegistry`: built-in ∪ custom, per-host/-session resolution, install specs |
| `src/agents/routes.ts` | B1 | `/api/agents` **and** `/api/hosts/:hostId/agents` |
| `src/backends/index.ts` | B1 | `createBackend(ResolvedConnection)` + `testConnection` + `listPortainerEndpoints` (BackendManager is gone) |
| `src/routes/docker.ts` | B1 | host-scoped (`mergeParams`) |
| `src/routes/settings.ts` | B1 | general/ui/password/vendor only |
| `src/routes/health.ts` | B1 | `hosts` summary |
| `src/sessions/*` | B2 | `hostId` + `agents` everywhere (see §13) |
| `src/terminals/*` | B2 | `shell: 'agent'`, host routing (see §14) |
| `src/images/*` | B2 | host-scoped, agent-aware tools sync (see §15) |

`routes/index.ts` (FROZEN) mounts the host-scoped routers **before** `/api/hosts`, so a host
id can never shadow `/images`, `/docker` or `/agents`.

### Import DAG (must stay acyclic)

```
config/fields.ts ─┬─> hosts/model.ts ─┐
                  ├─> agents/model.ts ─┼─> config/schema.ts ─> config/store.ts ─> hosts/manager.ts
                  └─> sessions/model.ts┘                                   └─> agents/registry.ts
```

`hosts/model.ts` must never import `config/schema.ts` (that is why `GENERAL_FIELD_SCHEMAS`
lives in `fields.ts`); `agents/model.ts` imports nothing but zod.

## 12.1 Hosts

```ts
HostConfig = { id, name, connection, overrides: Partial<GeneralConfig>,
               agents: { enabled: string[] }, notes, createdAt, updatedAt }
HostConnection = { type:'socket', socketPath }
               | { type:'portainer', credentialId, endpointId }
               | { type:'tcp', url, credentialId, insecureTls }    // reserved, 501
               | { type:'ssh', url, credentialId, socketPath }     // reserved, 501
```

* **Effective settings** — `hosts.settingsFor(hostId) = { ...config.general, ...host.overrides }`.
  Every B2 call site that used `config.general()` uses this instead. `config.general()` stays
  as the *global defaults* the settings page edits.
* **Backend cache** — `Map<hostId, {backend, fingerprint}>`. The fingerprint covers the
  connection AND the referenced credential blob, so rotating a Portainer key rebuilds exactly
  the hosts that use it. `invalidateChanged()` (wired to `ConfigStore.on('change')`) drops
  only what changed; `close()` closes everything.
* **At most one socket host.** The app process has exactly one `/var/run/docker.sock`;
  a second socket host is a `409`.
* **Two hosts may point at the same engine** (a socket host and a portainer endpoint of the
  same machine). That is allowed and shares volumes/images by construction — document it in
  the UI, and let an operator separate them with `overrides.volumePrefix` /
  `overrides.containerPrefix` if they really want two independent installs on one engine.
* **`status`** in `HostView` comes from a ≤15 s cached probe; the host list must render for a
  dead engine (`status:'unreachable'`, `error` set) instead of 502ing.
* **Deleting a host never touches the engine.** Containers, volumes and images stay; only
  PorterClaude forgets them. `409` while sessions reference it, `force=1` overrides and
  leaves those sessions with `hostMissing:true`.

## 12.2 Credentials

`credentials.portainer[]` holds `{id, name, url, apiKeyEnc, insecureTls}`. `CredentialStore`
is the only decryption point (`apiKeyFor`), warns ONCE per process when a rotated
`APP_SECRET` makes the blob undecryptable, and never logs the plaintext. Deleting a
credential that a host references is a `409`.

`HostManager.importPortainerEndpoints(credentialId)` turns the endpoint list into hosts (see
api.md for the exact rules). It is the only place that creates several hosts at once.

## 12.3 Agents

```ts
AgentDefinition = { id, name, command, args, versionCommand, install,
                    sharedPaths: {path, kind}[], historyPath, env, loginHint, homepage }
```

**Registry** — `BUILTIN_AGENTS` ∪ `config.agents.custom`, ids unique across both. A custom
definition with a duplicate `agentPathSlug()` is rejected (both paths would land in the same
directory of the auth volume).

**Storage layout (the core decision).** One volume per agent per host:

```
<volumePrefix>auth-<agentId>   mounted at   <containerHome>/.porterclaude/agents/<agentId>
```

and the bootstrap symlinks every shared path into it:

```
~/.claude       ->  <agentDir>/claude          (dir)
~/.claude.json  ->  <agentDir>/claude.json     (file)
~/.config/opencode -> <agentDir>/config-opencode
```

Why not mount the shared paths directly, as v0.1 did for `~/.claude`:
1. an agent may share **several** directories (opencode: `~/.local/share/opencode` **and**
   `~/.config/opencode`) and one volume cannot be mounted twice with different contents;
2. single-file paths cannot be bind mounted at all — agents rewrite them atomically via
   `rename(2)`, which replaces a file bind and breaks sharing (this is why v0.1 already used
   a second volume + symlink for `~/.claude.json`);
3. one rule for every agent means the entrypoint, the ownership repair and the UI have one
   code path instead of a per-agent special case.

Consequence for private history: the overlay volume mounts at `agentHistoryTarget(def, home)`
— a path **inside** the agent volume (`<agentDir>/claude/projects`) — never at the `~/…`
symlink, because docker resolves mount targets before the bootstrap runs. Docker sorts mounts
by target depth, so the nested mount on top of the agent volume is well defined (same
mechanism v0.1 used for `~/.claude/projects` inside the shared claude volume).

**Delivery is uniform** (product owner's call): recipes stop baking claude in; **every**
session mounts the tools volume read-only at `<toolsMount>` and gets
`entrypoint ["<toolsMount>/entrypoint.sh"]`. Recipes keep their image `CMD` (the php recipe
must still start supervisord) — docker only replaces what the create request sets, so
overriding the entrypoint alone preserves `Cmd`. Custom images keep `cmd ["sleep","infinity"]`.

**Contract with the ORCHESTRATION topic** (docker/tools):

| Direction | Item | Meaning |
|---|---|---|
| server → tools container | env `PORTERCLAUDE_AGENTS` | JSON `AgentInstallSpec[]` (id, command, install, versionCommand) |
| tools → volume | `<toolsMount>/AGENTS.json` | `{ syncedAt, agents:[{id,command,installed,version,error}] }` |
| tools → volume | `<toolsMount>/agents/<id>/…` | the agent's files; `<toolsMount>/bin/<command>` is the shim on PATH |
| tools → volume | `<toolsMount>/runtime/node/bin/node`, `<toolsMount>/runtime/python` | runtimes for `npm` / `pip` agents |
| server → session container | env `PORTERCLAUDE_AGENT_IDS` | comma separated ids mounted into this container |
| server → session container | env `PORTERCLAUDE_AGENT_LINKS` | `target|source|kind;…` — the symlinks to create |
| server → session container | env `PORTERCLAUDE_HOST` | the host id (diagnostics) |

The entrypoint SHOULD create the links itself at start (best effort, POSIX sh); the server
re-runs the same repair from the outside in `afterStart` (root exec), which is what makes it
work for containers created by an older tools volume and for non-root images.

**Terminals**: `shell=agent:<id>` runs `agentCommandLine(def)` = `command` + `args`, every
element shell-quoted. An agent that is not in the session's `resolvedAgents` is refused with
`agent_not_available` / close 4410 — starting it anyway would run an *unauthenticated* agent
with no auth volume and confuse the user.

## 12.4 Migration (v1 → v2) and the legacy claude login

`ConfigStore.migrate()` (B1) rewrites the raw JSON before it is parsed. It is lossless and
writes `config.json.v1.bak` first. Rules are listed in the code and in api.md §Config file.

The *data* migration is separate and happens on the first `tools/sync` of a migrated host:
copy `general.sharedClaudeVolume` → `<volumePrefix>auth-claude/claude/` and the
`.claude.json` from `general.sharedClaudeHomeVolume` → `<volumePrefix>auth-claude/claude.json`,
chown to the volume owner, drop the marker `.pc-import-v1`. The old volumes are **never**
deleted, so a rollback to v0.1 keeps working and the import can be re-run by deleting the
marker. Without this the deployed instance would silently ask for `/login` again.

## 13 Sessions (v0.2 delta)

* `SessionConfig` gains `hostId` (immutable after create) and `agents: string[] | null`
  (null = the host's enabled set, resolved at create/recreate time).
* Session **names are unique across hosts** — that is what lets the terminal WS route
  `session → host`. `create()` checks the stored sessions of every host plus the containers
  of the target host.
* `list()` merges every host: one `listManagedContainers` per host, in parallel, each failure
  degrading only that host's sessions to `status:'absent'` + a warning. `opts.hostId` filters.
* `SessionView` gains `hostId`, `hostName`, `hostMissing`, `resolvedAgents`.
* Volume names are prefixed with `general.volumePrefix` (default `porterclaude-`, i.e. the
  v0.1 names): `<prefix>ws-<slug>`, `<prefix>hist-<slug>` (claude) /
  `<prefix>hist-<slug>-<agentId>`, `<prefix>auth-<agentId>`.
* `ensureAgentVolumes` replaces `ensureSharedVolumes`: create one auth volume per resolved
  agent (labels `porterclaude.managed=true`, `porterclaude.agent=<id>`).
* The ownership repairs of v0.1 §7 stay, but operate on `<containerHome>/.porterclaude` and
  the agent dirs instead of `~/.claude`: docker creates the mountpoint parents as `root:root`,
  so a non-root image still needs the root exec that chowns them and re-runs the bootstrap.
* `reconcile()`/adoption reads `porterclaude.host` and `porterclaude.agents` back from the
  labels; an adopted container without a host label falls back to the host whose backend
  listed it.
* Changing a host's enabled agents makes its sessions report `needsRecreate` (the mounts are
  part of the spec hash). That is intended and documented in the UI.

## 14 Terminals (v0.2 delta)

* `TerminalService.open({session, shell, agentId, name, cols, rows})` resolves the session's
  host first (`requireRunningContainer` now returns `hostId`) and uses that host's backend
  and settings.
* The command matrix keeps its six rows; the `claude` row became the `agent` row and takes
  the agent argv.
* The tools PATH prefix now applies to **every** image (recipes included), because the agents
  live in the tools volume for both.
* New close codes 4410 (`agent_not_available`) and 4411 (`host_unavailable`); both are
  terminal, the client must not reconnect.

## 15 Images and the tools volume (v0.2 delta)

* Every public `ImageService` method takes `hostId` first; jobs carry `hostId`, are listed per
  host and their "already running" checks are per host.
* `ToolsStatus.agents` is read from `<toolsMount>/AGENTS.json` with a one-shot container
  (same trick as `readClaudeVersion`), cached per host and invalidated after a sync.
* `syncTools(hostId)` = build `<ns>/tools:latest` when missing/outdated → ensure the volume →
  run the populate container **with `PORTERCLAUDE_AGENTS`** → legacy claude import (once) →
  invalidate the cached manifest. A single agent failing to install is a job warning, not a
  failed job.
* Recipes no longer ship claude, so `RecipeStatus.claudeVersion` is only about the tools
  volume now; it is kept in the response for compatibility and mirrors the `claude` entry of
  `ToolsStatus.agents`.

## 16 Test plan (v0.2 additions)

Unit (vitest, no docker host):
* `config/fields.ts` + `GeneralSettingsInputSchema` parity guard still compiles (it is a
  compile-time assertion, so a missing validator fails the build).
* **Migration**: v1 portainer file, v1 socket file, v1 with sessions (incl.
  `shareHistory:false`), empty v1 → hosts/credentials/defaultHostId/sessions[].hostId, the
  `.v1.bak` file exists, and the migrated api key still decrypts.
* `HostManager`: default resolution, per-host cache identity, `invalidateChanged()` drops
  only the changed host, `settingsFor` merge, socket-host uniqueness, delete rules,
  `importPortainerEndpoints` (create/update/skip).
* `CredentialStore`: `sanitize()` never contains the key (grep the JSON), omitted `apiKey`
  keeps the stored one, delete-while-referenced is a 409.
* `AgentRegistry`: built-in ∪ custom, id collision 409, duplicate path slug 422,
  `resolveForSession` (null → host set, explicit list, unknown id dropped).
* `agents/model.ts` pure helpers: `agentPathSlug` table (`~/.claude`, `~/.claude.json`,
  `~/.local/share/opencode`, `~/.config/opencode`), `agentLinks`, `agentHistoryTarget`,
  `encode/decodeAgentLinks` round trip.
* `buildContainerSpec` v0.2: one auth mount per agent, private history nested inside it,
  tools volume in a recipe session, entrypoint set + `cmd` only for custom, the new labels,
  `PORTERCLAUDE_AGENT_LINKS`, and spec-hash stability vs. change when the agent set changes.
* `buildTerminalCommand`: the agent rows with a multi-word `agentCommand` and with a hostile
  agent name (quoting).
* `parseTerminalShell`: `bash`, `sh`, `agent:claude`, legacy `claude`, garbage → null.
* Routes: a 404-sweep over every path in api.md v0.2 (host-scoped ones included), plus
  `/api/hosts/:hostId/...` with an unknown host → 404 and with an incomplete connection → 409.

Integration (real engines — the reference instance is socket mode; add a Portainer host):
1. Upgrade path: start v0.2 against the existing `/data`, confirm the host `default` appears,
   the sessions still list, `config.json.v1.bak` exists, and a `tools/sync` imports the
   claude login (open a terminal: no `/login` prompt).
2. Add a Portainer credential → import endpoints → a host per endpoint → create a session on
   the new host → terminal works, and the session list shows both hosts.
3. Enable `opencode` on one host → sync tools → Images panel shows it installed with a
   version → recreate a session → `agent:opencode` terminal starts it → login → a SECOND
   session on the SAME host is authenticated → a session on the OTHER host is NOT.
4. `shareHistory:false` session on a host with two agents → two history volumes, both
   writable, and the shared auth volume is untouched.
5. Delete a host with sessions → 409; with `force=1` → the sessions show `hostMissing` and the
   containers are still running on the engine.
6. Kill a host's engine → the host list still renders (`unreachable`), the other host's
   sessions still work, and a terminal on the dead host closes 4411.
