# PorterClaude — backend design (`server/`)

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
