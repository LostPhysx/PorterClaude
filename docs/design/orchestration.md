# PorterClaude — orchestration / CI / CD design (`docker/`, `deploy/`, `.github/`)

Companion to [`api.md`](api.md) (wire contract) and [`backend.md`](backend.md) (server
internals). This topic owns everything that *produces or ships images and deployments*:
the session recipe images, the tools volume payload, the PorterClaude app image, the
generic compose file, the reference deployment script and the GitHub workflows.

Nothing here runs on the dev box: **there is no docker CLI on the Windows machine.** All
images are built *remotely* — by the server through the Docker Engine `/build` API
(recipes, tools), by `deploy/deploy.sh` through Portainer's Docker proxy (app image), or
by GitHub Actions + buildx (releases). Every artifact in this topic must therefore be
verifiable statically (`bash -n`, `sh -n`, python parse, `--dry-run`).

Work split: **O1** = images (`docker/**`, `.dockerignore`, root `docker-compose.yml`),
**O2** = delivery (`deploy/**`, `.github/workflows/**`, deployment docs). The two sets of
files are disjoint; every contract between them is written down below.

---

## 1. Directory layout (this topic)

```
.dockerignore                      O1  build-context filter (app image + deploy.sh)
docker-compose.yml                 O1  generic, vendor-neutral compose (socket + portainer)
docker/
  Dockerfile                       O1  the PorterClaude app image (multi-stage)
  README.md                        O1  how images are built / what each one is for
  recipes/
    common.sh                      O1  shared provisioning, injected into EVERY context
    node/Dockerfile                O1
    dotnet/Dockerfile              O1
    php/Dockerfile + nginx.conf + supervisord.conf + www/index.php   O1
    python/Dockerfile              O1
    go/Dockerfile                  O1
    base/Dockerfile                O1
  tools/
    Dockerfile                     O1  builds the payload for the shared tools volume
    fetch-claude.sh                O1  downloads the native claude binaries (4 targets)
    entrypoint.sh                  O1  runtime bootstrap for CUSTOM session images
    populate.sh                    O1  container CMD: copies the payload into /out
    README.md                      O1
deploy/
  deploy.sh                        O2  build + stack create/update + health poll
  lib/dockerignore.py              O2  .dockerignore-aware file lister (NUL separated)
  lib/render_compose.py            O2  ${VAR} substitution with a secret keep-list
  lib/portainer.py                 O2  JSON helpers: build-stream printer, stack lookup
  docker-compose.yml               O2  reference stack (nginx-proxy + acme-companion)
  .env.example                     O2  documented keys (deploy/.env is gitignored)
  README.md                        O2
.github/workflows/
  ci.yml                           O2  typecheck + lint + test + shell/python + image build
  release.yml                      O2  multi-arch buildx to ghcr.io on tags
docs/DEPLOYMENT.md                 O2  operator documentation (updated)
README.md                          O2  repo table + quick start (updated)
```

`docs/design/orchestration.md` (this file) is planner-owned: **do not edit it**. If reality
forces a change, report it instead of rewriting the contract.

---

## 2. Contracts inherited from the backend topic (do not renegotiate)

From `docs/design/backend.md` §7/§9 and the backend planner's handoff. Hard requirements:

| Contract | Value |
|---|---|
| Recipe directories | `docker/recipes/<name>/Dockerfile` for exactly `node, dotnet, php, python, go, base` |
| Shared script | `docker/recipes/common.sh`, injected by the server **at the tar root** of every recipe context, so `COPY common.sh /tmp/common.sh` works — and **no other shared file is available** in a recipe context |
| Recipe tags | `porterclaude/<name>:latest` (namespace = `general.imageNamespace`) |
| Image labels | `porterclaude.recipe`, `porterclaude.claude-version` set by the Dockerfile; `porterclaude.context-hash`, `porterclaude.built-at` added by the server at build time — Dockerfiles must not set the latter two |
| Recipe runtime | user `dev` **uid 1000**, `HOME=/home/dev`, `WORKDIR /workspace`, idles via `sleep infinity`, ships `git tmux ripgrep jq curl` (+ `gh`, `unzip`) |
| Session mounts | `porterclaude-claude` → `/home/dev/.claude`, `porterclaude-claude-home` → `/home/dev/.claude-home`, workspace → `/workspace`, `porterclaude-tools` (ro) → `/opt/porterclaude`, `porterclaude-hist-<slug>` → `/home/dev/.claude/projects` |
| Tools image | `docker/tools/Dockerfile`, tagged `porterclaude/tools:latest`; its default `CMD` populates `/out` and exits 0; the result contains an **executable** `entrypoint.sh` |
| Custom sessions | entrypoint `["/opt/porterclaude/entrypoint.sh"]`, cmd `["sleep","infinity"]`, env `PORTERCLAUDE_TOOLS=/opt/porterclaude`, `PORTERCLAUDE_HOME=/home/dev`, `HOME=/home/dev` (pinned so exec'ed terminals do not inherit the image's `/root`), `PORTERCLAUDE_SESSION=<slug>` |
| App image | start command `node server/dist/index.js`, `PORT=8080`, `DATA_DIR=/data`, healthcheck `GET /api/health`, `docker/` copied next to `server/` (`PORTERCLAUDE_DOCKER_DIR` defaults to `<repoRoot>/docker`, and `repoRoot = dirname(serverRoot)`), `web/public` present, `node_modules` present (vendor assets are served out of it) |
| Builds | classic Docker Engine `/build` API — **no BuildKit syntax, no `RUN --mount`, no heredoc `COPY <<EOF`, no `--platform`**. Native-arch builds only; the same Dockerfile must work on amd64 and arm64 |

### 2.1 New contracts this topic adds (additive; backend may consume them)

| Path | Produced by | Meaning |
|---|---|---|
| `/etc/porterclaude/claude-version` | recipe images (`common.sh`) | exact installed Claude Code version (trimmed `claude --version`) |
| `/etc/porterclaude/recipe` | recipe images | recipe name |
| `/usr/local/bin/pc-entrypoint.sh` | recipe images (`common.sh`) | recipe entrypoint: links `~/.claude.json`, then `exec "$@"` |
| `<toolsMount>/VERSION` | tools volume | claude version string |
| `<toolsMount>/bin/claude` | tools volume | arch/libc dispatcher script → the right native binary |
| `<toolsMount>/bin/claude-linux-{x64,arm64}[-musl]` | tools volume | native binaries |
| `<toolsMount>/entrypoint.sh` | tools volume | custom-image bootstrap (contract above) |

The `porterclaude.claude-version` **label** carries the *requested* version (build arg,
default `latest`/`stable`); the *actual* version is the file above. The classic builder
cannot turn `RUN` output into a label, so the UI treats the label as a hint.

---

## 3. Recipe images

### 3.1 `common.sh` — the one shared provisioning script

Runs as `RUN bash /tmp/common.sh` from every recipe Dockerfile. All six bases are Debian
bookworm derivatives, so `bash`, `apt-get` and `dpkg --print-architecture` exist
everywhere. The script must be **idempotent, arch-neutral and non-interactive**.

Responsibilities, in order:

1. `set -eu`, `export DEBIAN_FRONTEND=noninteractive`.
2. `apt-get update` + install: `ca-certificates curl wget git tmux ripgrep jq unzip zip
   less procps psmisc openssh-client gnupg nano file xz-utils`
   (**no `sudo`** — sessions are unprivileged by design). Keep the list short; heavy
   toolchains belong in the per-recipe Dockerfile. `rm -rf /var/lib/apt/lists/*` at the end.
3. `gh` (GitHub CLI) from the official apt repo, using `$(dpkg --print-architecture)` in the
   sources line so amd64/arm64 both resolve. If the repo is unreachable: warn and continue —
   `gh` is a nicety and must not fail the build.
4. Locale: `C.UTF-8` (no `locale-gen` needed on bookworm; `ENV LANG` is set in the Dockerfile).
5. **User `dev`, uid 1000, home `/home/dev`, shell `/bin/bash`**:
   * if `getent passwd 1000` exists and is not `dev` (node:22-bookworm ships `node`),
     rename it: `usermod -l dev -d /home/dev -m <old>` (+ `groupmod -n dev <oldgroup>` when
     gid 1000 exists) — do **not** delete it;
   * else `groupadd -g 1000 dev` (skip when gid 1000 is taken) +
     `useradd -m -u 1000 -g dev -s /bin/bash dev`;
   * `mkdir -p /home/dev/.claude/projects /home/dev/.claude-home /workspace` and
     `chown -R 1000:1000` (`chmod 0700` on `projects`). `projects` **must** ship in the
     image: when a `shareHistory:false` session mounts `porterclaude-hist-<slug>` at
     `/home/dev/.claude/projects`, docker creates a missing mountpoint inside the shared
     volume as `root:root` and every uid-1000 session then gets `EACCES` on
     `~/.claude/projects`. Shipping it lets docker's copy-up seed both the shared volume
     and each fresh history volume with the right owner; the server repairs volumes that
     already exist (`backend.md` §7, `prepareHistoryVolume`/`ensureProjectsDir`).
     them. Docker copies image content + ownership into an *empty* named volume on first
     use, which is exactly what makes uid 1000 own the shared login volume.
6. **Claude Code via the native installer**, installed *outside* `$HOME` because
   `/home/dev/.claude` is replaced by a shared volume at runtime:
   ```
   export CLAUDE_INSTALL_ROOT=/opt/claude
   mkdir -p "$CLAUDE_INSTALL_ROOT"
   HOME="$CLAUDE_INSTALL_ROOT" bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
   ```
   then locate the launcher (`$CLAUDE_INSTALL_ROOT/.local/bin/claude`, else
   `find "$CLAUDE_INSTALL_ROOT" -type f -name claude -perm -u+x | head -1`), resolve
   symlinks and expose it as `/usr/local/bin/claude`. `chmod -R a+rX /opt/claude`.
   Verify with `claude --version`; write the trimmed result to
   `/etc/porterclaude/claude-version`. A failure here **fails the build** (a recipe without
   `claude` is useless).
7. `/etc/profile.d/porterclaude.sh`: `export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"`,
   `export TERM="${TERM:-xterm-256color}"`, `export COLORTERM=truecolor`. Terminals start
   login shells (`bash -l`), so `profile.d` is the correct hook.
8. Write `/usr/local/bin/pc-entrypoint.sh` (heredoc inside `common.sh`, `chmod 0755`),
   POSIX `sh`:
   `HOME=${HOME:-/home/dev}`; `mkdir -p "$HOME/.claude" "$HOME/.claude-home"`;
   seed `"$HOME/.claude-home/.claude.json"` with `{}` when absent; make `$HOME/.claude.json`
   a symlink to it (move an existing regular file into the volume first — never delete user
   data); then `exec "$@"`, falling back to a portable idle loop when no arguments are given
   or when the CMD is exactly `sleep infinity` and `sleep` rejects it.
   Every step is best-effort: failures log to stderr and continue to `exec "$@"`.
9. `chmod -R a+rX /etc/porterclaude`.

`common.sh` must pass `bash -n`; it is the largest piece of logic in this topic and every
recipe depends on it. Changing it re-hashes every recipe context (`outdated` flips for all
six) — that is intended.

### 3.2 Per-recipe Dockerfiles

Frozen skeleton (only `FROM`, the extra `RUN` layer and env differ):

```dockerfile
FROM <base>
ARG CLAUDE_VERSION=latest
LABEL porterclaude.recipe="<name>" \
      porterclaude.claude-version="${CLAUDE_VERSION}"
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 PORTERCLAUDE_RECIPE=<name>
COPY common.sh /tmp/common.sh
RUN bash /tmp/common.sh && rm -f /tmp/common.sh
# ... recipe-specific tooling here (still root) ...
USER dev
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/pc-entrypoint.sh"]
CMD ["sleep", "infinity"]
```

| Recipe | Base | Extra layer |
|---|---|---|
| `node` | `node:22-bookworm` | `corepack enable` (pnpm/yarn shims); `ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false`; uid 1000 is the pre-existing `node` user → renamed by `common.sh` |
| `dotnet` | `mcr.microsoft.com/dotnet/sdk:9.0` | `ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 NUGET_PACKAGES=/home/dev/.nuget/packages DOTNET_CLI_HOME=/home/dev`; pre-create + chown those dirs |
| `php` | `php:8.3-fpm-bookworm` | nginx + supervisor via apt; composer via `getcomposer.org/installer` (arch-neutral, verify the installer hash); `docker-php-ext-install pdo_mysql opcache zip intl` (keep it cheap); `COPY nginx.conf /etc/nginx/nginx.conf`, `COPY supervisord.conf /etc/supervisor/supervisord.conf`, `COPY www/index.php /workspace/public/index.php`; `EXPOSE 80`; `CMD ["supervisord","-n","-c","/etc/supervisor/supervisord.conf"]` (still behind `pc-entrypoint.sh`) |
| `python` | `python:3.13-bookworm` | `pip install --no-cache-dir uv pipx`; `ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1 UV_LINK_MODE=copy` |
| `go` | `golang:1.23-bookworm` | `ENV GOPATH=/home/dev/go GOCACHE=/home/dev/.cache/go-build GOFLAGS=-buildvcs=false`; pre-create + chown |
| `base` | `debian:bookworm-slim` | nothing beyond `common.sh` |

**php specifics** (the only recipe that serves traffic):
* nginx and php-fpm both run as `dev`, so every writable path must be under `/tmp` or
  `/home/dev`: `pid /tmp/nginx.pid;`, `error_log /dev/stderr;`, `access_log /dev/stdout;`,
  and the `client_body_temp_path` / `proxy_temp_path` / `fastcgi_temp_path` family under
  `/tmp/nginx`. php-fpm: `pid = /tmp/php-fpm.pid`, `error_log = /dev/stderr`,
  `listen = 127.0.0.1:9000`, `daemonize = no`.
* nginx `root /workspace/public;` with the front-controller
  `try_files $uri $uri/ /index.php$is_args$args;` and the standard `fastcgi_pass 127.0.0.1:9000`.
* `listen 80;` works for uid 1000 because dockerd sets
  `net.ipv4.ip_unprivileged_port_start=0` inside containers. Where it does not, the php
  entrypoint honours `PC_HTTP_PORT` (default 80) by writing a patched copy of the config to
  `/tmp` before supervisord starts. Document both in `docker/README.md`.
* supervisord: `nodaemon=true`, `logfile=/dev/null`, `pidfile=/tmp/supervisord.pid`,
  `[program:php-fpm]` + `[program:nginx]`, both `autorestart=true`, stdout/stderr to fd 1/2.

**Arch neutrality rules (all recipes):** never hardcode `amd64`/`x86_64`/`aarch64`; use
`dpkg --print-architecture` or `uname -m` in a `case`; prefer apt/pip/npm over tarball
downloads.

---

## 4. Tools volume (`docker/tools/`) — bootstrap for custom images

### 4.1 What the volume must contain

```
/opt/porterclaude/entrypoint.sh                 0755  bootstrap (container entrypoint)
/opt/porterclaude/VERSION                       0644  claude version string
/opt/porterclaude/bin/claude                    0755  dispatcher (arch + libc detection)
/opt/porterclaude/bin/claude-linux-x64          0755  glibc  amd64
/opt/porterclaude/bin/claude-linux-arm64        0755  glibc  arm64
/opt/porterclaude/bin/claude-linux-x64-musl     0755  musl   amd64
/opt/porterclaude/bin/claude-linux-arm64-musl   0755  musl   arm64
```

Everything is world-readable/executable (`chmod -R a+rX`) because sessions mount the volume
**read-only** and run as arbitrary uids.

### 4.2 `fetch-claude.sh` (build time)

Downloads the native binaries into `/payload/bin`. Resolution order:

1. `BASE=${CLAUDE_DIST_BASE:-https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases}`;
   `VERSION=${CLAUDE_VERSION:-stable}`; when `VERSION` is `stable`/`latest`, resolve it with
   `curl -fsSL "$BASE/stable"`.
2. For each `plat` in `linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl`:
   `curl -fsSL --retry 3 -o /payload/bin/claude-$plat "$BASE/$VERSION/$plat/claude"` +
   `chmod 0755`. Best-effort checksum verification against `$BASE/$VERSION/manifest.json`
   when that file is fetchable.
3. **Fallback** when a download fails: run the official installer for the *native* arch
   (`HOME=/tmp/pcinstall bash -c 'curl -fsSL https://claude.ai/install.sh | bash'`), copy the
   resulting binary to the matching `claude-linux-<arch>` name and print a loud warning that
   cross-arch binaries are unavailable. The build succeeds when **at least the host
   architecture** is covered; it fails only when nothing could be obtained.
4. Write the resolved version to `/payload/VERSION`, generate `/payload/bin/claude`
   (dispatcher), `chmod -R a+rX /payload`.

Dispatcher (`bin/claude`), POSIX `sh`: `case $(uname -m)` → `x86_64|amd64 → x64`,
`aarch64|arm64 → arm64`; musl detection via `ls /lib/ld-musl-* >/dev/null 2>&1` or
`ldd --version 2>&1 | grep -qi musl` → suffix `-musl`; `exec "$dir/claude-linux-$arch$suffix" "$@"`
with a clear error message when that file is missing.

### 4.3 `docker/tools/Dockerfile`

```dockerfile
FROM debian:bookworm-slim
ARG CLAUDE_VERSION=stable
LABEL porterclaude.claude-version="${CLAUDE_VERSION}"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY fetch-claude.sh entrypoint.sh populate.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/fetch-claude.sh /usr/local/bin/entrypoint.sh /usr/local/bin/populate.sh \
 && mkdir -p /payload/bin \
 && cp /usr/local/bin/entrypoint.sh /payload/entrypoint.sh \
 && CLAUDE_VERSION="${CLAUDE_VERSION}" /usr/local/bin/fetch-claude.sh
CMD ["/usr/local/bin/populate.sh"]
```

`populate.sh`: `set -eu`; require `/out` to exist and be writable; then **stage and
rename** — `cp -a /payload/. /out/.pc-stage.$$/`, `chmod -R a+rX` + `0755` on
`entrypoint.sh` and `bin/*` inside the staging directory, and finally `mv -f` every staged
file over its target in `/out` (creating missing directories first). Print what it wrote;
`exit 0`. The server runs this container once with the tools volume mounted rw at `/out`
and treats a non-zero exit as a failed job (`backend.md` §9).

> Why not a plain `cp -a /payload/. /out/`: re-syncing while a session is running `claude`
> straight off the volume overwrites a **busy executable** and fails with `ETXTBSY`
> ("Text file busy"), leaving the volume half-updated. `rename(2)` has no such restriction —
> the running process keeps the old (now unlinked) inode and the next start picks up the new
> binary, which is exactly the "existing sessions pick the new payload up on their next
> restart" behaviour `docker/tools/README.md` promises. Stale `/out/.pc-stage.*` directories
> from an interrupted run are removed at the start of the next sync.

### 4.4 `entrypoint.sh` (runtime, inside arbitrary user images)

PID 1 in a **custom** session container with `PORTERCLAUDE_TOOLS=/opt/porterclaude` (ro),
`PORTERCLAUDE_HOME=/home/dev`, `PORTERCLAUDE_SESSION=<slug>`, cmd `sleep infinity`.
Strict POSIX `sh` (busybox ash / dash must run it) and **nothing in it may abort the
container** — every step logs on failure and continues.

1. `TOOLS=${PORTERCLAUDE_TOOLS:-/opt/porterclaude}`;
   **`HOME=${PORTERCLAUDE_HOME:-${HOME:-/root}}`; `export HOME`** — `$PORTERCLAUDE_HOME`
   wins over whatever home the image brings. That is where the server mounts the shared
   login volumes, so honouring the image's own home (`/root` for the root images most
   people pick, which is what `runc` derives from the passwd entry when nothing pins `HOME`)
   would make `claude` write its credentials *outside* the shared volumes and break
   "log in once, every session is authenticated". The server pins `HOME=<containerHome>` in
   the container env as well, so `docker exec`ed terminals see the same home — the two
   halves are independent on purpose.
   Remember the image's own home in `IMAGE_HOME` for step 6: **when `PORTERCLAUDE_HOME` is
   set, take it from the passwd entry of `id -u`, not from `$HOME`** — the server has
   already overwritten `$HOME`, so reading it back would make `IMAGE_HOME == HOME`, turn
   the bridge into a no-op and leave `su -` / `sudo -i` / `getpwuid()` callers in an
   unlinked `/root`. Only without `PORTERCLAUDE_HOME` is `$HOME` the image's own answer
   (then passwd is the fallback). `/` counts as no home.
2. `PATH="$TOOLS/bin:$HOME/.local/bin:$PATH"`; export it and persist it best-effort:
   `/etc/profile.d/porterclaude.sh` (when writable), `$HOME/.profile`, `$HOME/.bashrc`,
   each guarded by a marker comment so repeats are no-ops. Terminals open login shells, so
   this is what makes `claude` resolvable.
3. When running as root and `/usr/local/bin` is writable, drop a 3-line wrapper
   `/usr/local/bin/claude` that execs `$TOOLS/bin/claude "$@"` (covers non-login shells).
4. Best-effort package bootstrap for `git` and `tmux`: only when `id -u` = 0, only for
   packages actually missing, with a hard timeout (`timeout 300` when available) and all
   output redirected to `/tmp/porterclaude-bootstrap.log`. Try `apt-get`, `apk`, `dnf`,
   `microdnf`, `yum`, `zypper`, `pacman` — the first one found. None → log
   "degraded: no package manager" and continue.
5. Shared-config wiring: `mkdir -p "$HOME/.claude" "$HOME/.claude-home"`; seed
   `"$HOME/.claude-home/.claude.json"` with `{}` when absent; make `$HOME/.claude.json` a
   symlink to it (moving an existing regular file into the volume first). Do **not**
   `chown -R` the shared volume (it is owned by uid 1000 for the recipes); when it is not
   writable, log a warning and carry on.
6. Bridge `$IMAGE_HOME` (when it exists and differs from `$HOME`): symlink
   `$IMAGE_HOME/.claude` → `$HOME/.claude`, `$IMAGE_HOME/.claude-home` →
   `$HOME/.claude-home` and `$IMAGE_HOME/.claude.json` →
   `$HOME/.claude-home/.claude.json`, so that anything resolving `~` through the passwd
   entry instead of `$HOME` (`su -`, `sudo -i`, node's `os.homedir()`, bash tilde
   expansion) still lands on the shared login. Pre-existing regular files/directories are
   **moved aside** to `<path>.pc-backup`, never deleted; an unwritable `$IMAGE_HOME` only
   produces a warning. Step 2 also persists the PATH snippet into
   `$IMAGE_HOME/.profile`/`.bashrc`.
7. `date -u +%FT%TZ > /tmp/porterclaude-ready` (debug marker).
8. Idle: if the CMD is exactly `sleep infinity`, run a portable loop
   (`while :; do sleep 3600; done`) so images whose `sleep` rejects `infinity` still stay
   up; otherwise `exec "$@"`; with no arguments, idle loop.

### 4.5 Sequence: how the volume is populated (server side, for reference)

```
Settings -> Images -> "Sync tools"
  POST /api/images/tools/sync
    ImageService.syncTools()
      buildImage(tar(docker/tools), t=porterclaude/tools:latest)   <- this topic's Dockerfile
        only when the image is missing or its porterclaude.context-hash label differs
        from the current docker/tools hash (force:true = always, --pull + --no-cache);
        otherwise the existing image is reused and only the volume is re-populated
      createVolume(porterclaude-tools) if missing
      createContainer(image=porterclaude/tools:latest, binds=[porterclaude-tools:/out])
      startContainer -> waitContainer (exit 0) -> removeContainer  <- CMD = populate.sh
  volume now holds entrypoint.sh + bin/* -> custom sessions can start
```

---

## 5. The PorterClaude app image (`docker/Dockerfile`)

Multi-stage, built from the **repo root** as context (`dockerfile=docker/Dockerfile`).

```
stage deps   node:22-bookworm-slim
             COPY package.json package-lock.json* ./
             COPY server/package.json server/ ; COPY web/package.json web/
             RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
stage build  COPY . .                         (filtered by .dockerignore)
             RUN npm run build --workspaces --if-present     -> server/dist
             RUN npm prune --omit=dev                        (keeps web vendor deps)
stage run    node:22-bookworm-slim
             WORKDIR /app
             COPY --from=build /app/node_modules ./node_modules
             COPY --from=build /app/server/dist ./server/dist
             COPY --from=build /app/server/package.json ./server/
             COPY --from=build /app/package.json ./
             COPY web/public ./web/public
             COPY web/package.json ./web/
             COPY docker ./docker           <- recipe + tools contexts (PORTERCLAUDE_DOCKER_DIR)
             ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data
             RUN useradd -r -u 10001 -m -d /home/porterclaude porterclaude \
                 && mkdir -p /data && chown -R 10001:10001 /data /app
             USER 10001
             EXPOSE 8080
             HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "..."
             CMD ["node", "server/dist/index.js"]
```

Rules and rationale:
* `bookworm-slim`, not alpine: keeps glibc (future native deps) and matches the recipes.
* No `curl`/`wget` in the runtime layer → the healthcheck uses node's built-in `fetch`:
  `node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`.
* `web/public` is copied from the *context* (no build step for the web topic);
  `node_modules` must survive because vendor assets are served straight out of it
  (`server/src/vendor.ts`).
* `docker/` **must** be copied: recipe builds read `<repoRoot>/docker/recipes` at runtime.
* Non-root (uid 10001) — see §6 for the docker-socket group caveat.
* Do not `VOLUME /data`: compose declares it; an implicit volume confuses stack updates.
* `.dockerignore` (repo root, O1): `.git`, `node_modules`, `**/node_modules`, `**/dist`,
  `data`, `deploy/.env*` (**secrets must never enter a build context**), `deploy/.build`,
  `*.log`, `*.tar`, `.github`, `docs`, `*.tsbuildinfo`, `.idea`, `.vscode`, `Thumbs.db`,
  `.DS_Store`. Keep `package-lock.json` and `web/public`. The `deploy/.env` exclusion is
  security-critical and is asserted by QA.

---

## 6. Generic compose (`/docker-compose.yml`, O1)

One service, both backends, documented switches — what a stranger copy-pastes:

```yaml
services:
  porterclaude:
    image: ghcr.io/lostphysx/porterclaude:latest
    # build: { context: ., dockerfile: docker/Dockerfile }   # uncomment to build locally
    restart: unless-stopped
    init: true
    ports: ["8080:8080"]
    environment:
      APP_PASSWORD: ${APP_PASSWORD:-change-me}
      # PORTERCLAUDE_BACKEND: socket        # or: portainer (+ PORTAINER_* below)
      # PORTAINER_URL / PORTAINER_API_KEY / PORTAINER_ENDPOINT_ID
      # LOG_LEVEL / TRUST_PROXY / COOKIE_SECURE / SESSION_TTL_DAYS
    volumes:
      - porterclaude-data:/data
      - /var/run/docker.sock:/var/run/docker.sock   # socket mode only
    # group_add: ["999"]   # gid of the docker group: stat -c %g /var/run/docker.sock
volumes:
  porterclaude-data:
```

**The socket + non-root interaction must be documented in both compose files and
`docs/DEPLOYMENT.md`:** the app runs as uid 10001, so it can only use
`/var/run/docker.sock` when the socket's group is granted via `group_add` (or `user: "0:0"`,
or a socket proxy). Give the exact discovery command. Portainer mode needs no socket at all.

`porterclaude-data` persistence is load-bearing: it holds `secret.key`; losing it logs
everyone out and makes the stored Portainer key undecryptable (`backend.md` §4).

---

## 7. `deploy/deploy.sh` (O2)

Bash, runs under Git Bash on Windows and on Linux. `set -euo pipefail`. **Never** `set -x`,
never echo `$PORTAINER_API_KEY`, never pass it as a command-line argument (it would appear
in `ps`): it goes into a `chmod 600` curl config file inside a `mktemp -d` directory that an
`EXIT` trap removes.

```
usage: deploy/deploy.sh [--dry-run] [--build-only] [--deploy-only] [--no-wait]
                        [--tag <image-ref>] [--env-file <path>] [-h|--help]
```

### 7.1 Steps

1. **load env** — `deploy/.env` via `set -a; . "$ENV_FILE"; set +a`. Require
   `PORTAINER_URL PORTAINER_ENDPOINT_ID PORTAINER_API_KEY APP_HOSTNAME APP_PASSWORD
   STACK_NAME`; optional `APP_IMAGE` (default `porterclaude:local`), `PROXY_NETWORKS`,
   `HEALTH_TIMEOUT` (default 180 s), `HEALTH_URL` (default `https://$APP_HOSTNAME/api/health`).
   Strip a trailing `/` from `PORTAINER_URL`.
2. **preflight** — `curl`, `tar`, `python3` (fall back to `python`) present;
   `GET $PORTAINER_URL/api/endpoints/$ID/docker/_ping` → HTTP 200 (skipped in `--dry-run`).
3. **context tar** — `python3 deploy/lib/dockerignore.py --root . --print0` emits every file
   surviving `.dockerignore`, piped into
   `tar --null -T - -cf deploy/.build/context.tar` (works with GNU tar and the bsdtar that
   Git for Windows ships). Print the file count and the tar size, not the file list.
4. **build** —
   `POST $PORTAINER_URL/api/endpoints/$ID/docker/build?t=$APP_IMAGE&dockerfile=docker/Dockerfile&rm=1&forcerm=1&pull=1`,
   `Content-Type: application/x-tar`, `--data-binary @deploy/.build/context.tar`, response
   piped into `python3 deploy/lib/portainer.py build-stream`, which prints `stream`/`status`
   values and exits non-zero on `error`/`errorDetail`. Use `curl -sS -N` so progress is not
   buffered.
5. **render compose** — `python3 deploy/lib/render_compose.py deploy/docker-compose.yml
   --keep APP_PASSWORD --out deploy/.build/stack.yml`: `${VAR}` / `${VAR:-default}`
   substitution from the environment, except `--keep` names, which stay literal and are
   passed to Portainer in the stack `Env` array instead (so the password is stored once, by
   Portainer, not baked into the compose text). Unset variable without a default → hard
   error naming the variable.
6. **stack create or update** —
   * `GET $PORTAINER_URL/api/stacks` →
     `python3 deploy/lib/portainer.py find-stack --name "$STACK_NAME" --endpoint "$ID"` →
     stack id or empty.
   * create: `POST /api/stacks/create/standalone/string?endpointId=$ID` with
     `{"name":…,"stackFileContent":…,"env":[{"name":"APP_PASSWORD","value":…}]}`; on HTTP
     404/405 (older Portainer) retry the legacy
     `POST /api/stacks?type=2&method=string&endpointId=$ID` with
     `{"Name":…,"StackFileContent":…,"Env":[…]}`.
   * update: `PUT /api/stacks/$sid?endpointId=$ID` with
     `{"stackFileContent":…,"env":[…],"prune":true,"pullImage":false}` — `pullImage:false`
     because the image was just built locally on that engine.
   * JSON bodies are built by `deploy/lib/portainer.py stack-body …` (`json.dumps`), never by
     string concatenation in bash.
7. **health poll** — `GET $HEALTH_URL` every 5 s until the body contains `"status":"ok"` or
   `HEALTH_TIMEOUT` elapses; print elapsed time; non-zero exit on timeout. `--no-wait` skips.

`--dry-run` performs steps 1, 3 and 5 only (no network) and leaves
`deploy/.build/context.tar` + `deploy/.build/stack.yml` for inspection — the mode QA can run
on the dev box.

### 7.2 Python helpers (stdlib only — nothing in this repo may `pip install`)

| File | CLI | Behaviour |
|---|---|---|
| `lib/dockerignore.py` | `--root <dir> [--ignore-file .dockerignore] [--print0]` | walks the tree, applies `.dockerignore` semantics (per-segment globs, `**`, leading `!` negation, `#` comments, trailing-slash dirs), prints surviving *relative* POSIX paths |
| `lib/render_compose.py` | `<file> [--keep VAR,VAR] [--out <file>]` | `${VAR}` / `${VAR:-default}` substitution from `os.environ`; `--keep` names pass through untouched; missing + no default → exit 2 naming the variable |
| `lib/portainer.py` | `build-stream` \| `find-stack --name --endpoint` \| `stack-body --file --name [--env NAME]…` | JSON-lines build printer (exit 1 on error), stack lookup by name (case-insensitive, endpoint-filtered), stack request-body builder that reads the compose from a file |

All three run on python 3.9+ (CI runners) and 3.13 (dev box), have a
`if __name__ == "__main__":` entry point, and print nothing sensitive.

---

## 8. CI / CD (`.github/workflows/`, O2)

### `ci.yml` — `push` + `pull_request` on `main`

| job | steps |
|---|---|
| `node` | checkout, setup-node 22, `npm ci` when `package-lock.json` exists else `npm install`, `npm run typecheck`, `npm run lint`, `npm test` |
| `scripts` | `shellcheck -S warning` on `deploy/deploy.sh`, `docker/recipes/common.sh`, `docker/tools/*.sh` (with `bash -n` / `sh -n` as the floor); `python -m compileall -q deploy/lib`; `deploy/deploy.sh --dry-run --env-file deploy/.env.example` (dummy key, no network) and assert the two artifacts exist |
| `compose` | `docker compose -f docker-compose.yml config -q` and the same for the rendered `deploy/.build/stack.yml` |
| `image` | `docker/build-push-action` with `push: false`, `platforms: linux/amd64`, `context: .`, `file: docker/Dockerfile` — proves the app image builds |

Do **not** enable `setup-node`'s npm cache until `package-lock.json` is committed (the action
fails when the lock file is missing) — leave a comment saying so.

### `release.yml` — `push: tags: ['v*']` + `workflow_dispatch`

`permissions: { contents: read, packages: write }`; QEMU + buildx; `docker/login-action` to
`ghcr.io` with `GITHUB_TOKEN`; `docker/metadata-action` producing
`ghcr.io/${{ github.repository }}` with `type=semver,pattern={{version}}`,
`{{major}}.{{minor}}` and `latest`; `build-push-action` with
`platforms: linux/amd64,linux/arm64`, `provenance: false` (older registries/Portainer choke
on attestation manifests), `cache-from/to: type=gha`.

Recipe images are **not** released: they are built on the target host by the app, which keeps
them arch-native and lets operators customise them.

---

## 9. Error handling / failure modes

| Failure | Expected behaviour |
|---|---|
| `claude.ai/install.sh` unreachable during a recipe build | build fails loudly; the server surfaces the log lines through the job API |
| `gh` apt repo unreachable | warning, build continues |
| Cross-arch claude binary missing in `fetch-claude.sh` | warning + native-installer fallback; the job fails only if *no* binary was obtained |
| Custom image without a package manager | `entrypoint.sh` logs "degraded", the container still starts and terminals still work; the UI warns via `ready.tmux:false` |
| Custom image where `$HOME` is not writable | log, skip the symlink, continue |
| `sleep infinity` unsupported | entrypoint's portable idle loop takes over |
| App container cannot read `/var/run/docker.sock` | documented `group_add`; Settings reports `socketAvailable:false` |
| Portainer build returns `errorDetail` | `deploy.sh` prints the error line and exits non-zero; no stack update is attempted |
| Same-named stack on another endpoint | `find-stack` filters by endpoint id |
| Health poll timeout | non-zero exit + a hint to check the container logs in Portainer |

---

## 10. Test plan hints (QA)

Static, runnable on the dev box (no docker CLI):

1. `bash -n docker/recipes/common.sh`, `bash -n docker/tools/fetch-claude.sh`,
   `sh -n docker/tools/entrypoint.sh`, `sh -n docker/tools/populate.sh`,
   `bash -n deploy/deploy.sh` — all clean.
2. Grep assertions on the recipes: every `docker/recipes/*/Dockerfile` contains
   `COPY common.sh`, `USER dev`, `WORKDIR /workspace`, `LABEL porterclaude.recipe`,
   `ENTRYPOINT ["/usr/local/bin/pc-entrypoint.sh"]`; none contains `--platform`,
   `RUN --mount`, `x86_64`, `aarch64` or a hardcoded `amd64`/`arm64` download URL.
3. Recipe directory names == `RECIPES` in `server/src/images/recipes.ts` (exact set of six).
4. `docker/Dockerfile`: copies `docker`, `web/public` and `node_modules`; `CMD` is
   `node server/dist/index.js`; `EXPOSE 8080`; a `HEALTHCHECK` exists; `USER` is not root.
5. `.dockerignore` excludes `deploy/.env` and `node_modules`; **security check**:
   `python3 deploy/lib/dockerignore.py --root .` output contains no `deploy/.env`,
   `data/`, `node_modules/` or `.git/` entry.
6. `deploy/deploy.sh --dry-run --env-file deploy/.env.example` exits 0 and writes
   `deploy/.build/context.tar` (non-empty; `tar -tf` shows `docker/Dockerfile` and
   `server/package.json`, and shows **no** `deploy/.env`) plus `deploy/.build/stack.yml`
   where `${APP_HOSTNAME}` is substituted and `${APP_PASSWORD}` is still literal.
7. Secret hygiene sweep: `grep -rIn "ptr_" --exclude-dir=.git .` matches nothing outside
   `deploy/.env`; no file under `docker/`, `deploy/*.sh` or `.github/` contains a key.
8. Workflows are valid YAML and pin actions by major version.

Integration QA (needs the reference host):

9. Settings → Images → build the `base` recipe → job succeeds → `porterclaude/base:latest`
   carries `porterclaude.recipe`; `outdated` flips after touching `common.sh`.
10. Sync tools → volume `porterclaude-tools` exists → create a session on `alpine:3.20`
    (musl!) → the container stays up and `claude --version` works in a terminal.
11. Session on the `node` recipe → `id -u` is 1000; `git tmux rg jq gh claude` all resolve;
    `claude --version` matches `/etc/porterclaude/claude-version`.
12. `php` recipe: session with port 80 published → the sample page renders.
13. `deploy/deploy.sh` end-to-end → image built on the arm64 host → stack created, then a
    second run updates the same stack → `https://$APP_HOSTNAME/api/health` is `{"status":"ok"}`.
