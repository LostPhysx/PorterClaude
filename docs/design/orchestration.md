# PorterClaude — orchestration / CI / CD design (`docker/`, `deploy/`, `.github/`)

> **v0.2 (uniform agent delivery): the [v0.2 section](#v02--uniform-agent-delivery-authoritative-from-here-down)
> at the end of this file wins wherever it contradicts the v0.1 text above it.**

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

---

# v0.2 — uniform agent delivery (AUTHORITATIVE from here down)

Everything above describes v0.1 and stays true unless this section contradicts it; **where
they disagree, this section wins**. Companions: `backend.md` §11–16 (server internals) and
`api.md` §"v0.2" (wire contract). This section is planner-owned: **do not edit it**; report
instead of rewriting.

## 11 What v0.2 changes, in one paragraph

Coding agents (claude, opencode, gemini, codex, aider, plus custom ones) are no longer baked
into the recipe images. **Every** session — recipe *and* custom — mounts the per-host tools
volume read-only and is started with `<toolsMount>/entrypoint.sh` as its entrypoint. The
tools volume is populated per host by the tools image, which now installs the host's
**enabled agents** at *populate* time (not build time) from the `PORTERCLAUDE_AGENTS` spec
the server passes in, records the result in `<toolsMount>/AGENTS.json`, and ships the
runtimes those agents need (a standalone Node for npm agents, `uv` + a managed CPython for
pip agents). The entrypoint wires `PATH`, the per-agent `HOME`/config **symlinks** into the
mounted auth volumes (`PORTERCLAUDE_AGENT_LINKS`), and the ownership repair. Recipes become
pure language-toolchain images. Nothing about `docker/Dockerfile`, `docker-compose.yml`,
`deploy/**` or the workflows changes functionally — only their documentation and CI's static
checks.

### Change list

| # | Change | Owner |
|---|---|---|
| 1 | `docker/recipes/common.sh` no longer installs Claude Code; no `/etc/porterclaude/claude-version`; no `~/.claude*` seeding; it creates `~/.porterclaude/agents` instead | O1 |
| 2 | Recipe Dockerfiles drop `ARG CLAUDE_VERSION` and the `porterclaude.claude-version` label; `pc-entrypoint.sh` shrinks to "HOME/TERM + `exec "$@"` + idle fallback" | O1 |
| 3 | `docker/tools/` becomes a manifest-driven **agent installer**: `install-agents.sh` + `lib/*.sh` + per-agent overrides in `agents/<id>.sh` | O1 |
| 4 | `docker/tools/fetch-claude.sh` is folded into `docker/tools/agents/claude.sh` and **deleted** | O1 |
| 5 | The tools image no longer downloads anything at build time; the populate container does the work and needs network on the host | O1 |
| 6 | `docker/tools/entrypoint.sh` becomes agent-generic (link table from `PORTERCLAUDE_AGENT_LINKS`, ownership over `~/.porterclaude`, wrappers per agent command) | O1 |
| 7 | New payload layout (`agents/`, `bin/`, `lib/`, `runtime/`, `AGENTS.json`); `bin/claude-linux-*` moves to `agents/claude/bin/` | O1 |
| 8 | `docker/README.md` + `docker/tools/README.md` rewritten for agents; the "add a recipe" section gains "recipes must not install an agent" | O1 |
| 9 | `docs/DEPLOYMENT.md`: multi-host, per-host tools volume + auth volumes, upgrade procedure, disk/network expectations | O2 |
| 10 | New `docs/AGENTS.md`: what an agent is, the built-ins, and **how to add a custom agent** | O2 |
| 11 | `README.md`: agent-neutral copy, v0.2 feature list, hosts | O2 |
| 12 | Root `docker-compose.yml` + `deploy/**`: comment/doc updates only (`PORTERCLAUDE_BACKEND`/`PORTAINER_*` now seed the **first host**) | O2 |
| 13 | CI: deletion-proof shell lint loop, `install-agents.sh --plan` contract test, agent-id parity with `server/src/agents/builtin.ts`, "no agent in a recipe" guard | O2 |

### Ownership (v0.2, disjoint)

```
O1  docker/**            (tools, recipes, app Dockerfile, docker/README.md), .dockerignore
O2  docker-compose.yml (root), deploy/**, .github/**, docs/** (except docs/design/*.md),
    README.md
```
`docs/design/orchestration.md` stays planner-owned. `docs/design/api.md`, `backend.md` and
`frontend.md` belong to the other topics — **do not edit them**.

---

## 12 Contracts with the backend topic (frozen, from `backend.md` §12.3)

| Direction | Item | Value |
|---|---|---|
| server → tools container | env `PORTERCLAUDE_AGENTS` | JSON array of `AgentInstallSpec` = `{id, command, install, versionCommand}` (`server/src/agents/model.ts`) |
| server → tools container | mount | the host's tools volume, **rw at `/out`** |
| tools → volume | `<toolsMount>/AGENTS.json` | `{ syncedAt, agents:[{id,command,installed,version,error}] }` = `ToolsAgentManifest` |
| tools → volume | `<toolsMount>/agents/<id>/…` | the agent's files |
| tools → volume | `<toolsMount>/bin/<command>` | the executable shim that ends up on `PATH` |
| tools → volume | `<toolsMount>/runtime/node/bin/node`, `<toolsMount>/runtime/python` | bundled runtimes |
| tools → volume | `<toolsMount>/entrypoint.sh` | 0755, the entrypoint of **every** session |
| server → session | env `PORTERCLAUDE_AGENT_IDS` | `claude,opencode` |
| server → session | env `PORTERCLAUDE_AGENT_LINKS` | `target\|source\|kind;target\|source\|kind` (`encodeAgentLinks`) |
| server → session | env `PORTERCLAUDE_TOOLS`, `PORTERCLAUDE_HOME`, `HOME`, `PATH`, `PORTERCLAUDE_SESSION`, `PORTERCLAUDE_HOST`, `TERM` | as v0.1, plus `PORTERCLAUDE_HOST` |
| server → session | entrypoint | `["<toolsMount>/entrypoint.sh"]` for **every** session; `cmd ["sleep","infinity"]` only for custom images (recipes keep their image CMD) |
| server → container | `<toolsMount>/entrypoint.sh --porterclaude-bootstrap` | root exec after start: re-run the steps that need a writable `$HOME` |
| server → container | `<toolsMount>/entrypoint.sh --porterclaude-share` | root exec / shim call: hand the agent dirs back to their owner |

`AgentInstallSpec.install` is one of four kinds (`agents/model.ts`):

```jsonc
{"kind":"script","url":"https://…","args":[],"binPath":"bin/claude","env":{}}
{"kind":"npm","package":"@google/gemini-cli","version":"latest","bin":"gemini"}
{"kind":"pip","package":"aider-chat","version":"…","bin":"aider","preferUv":true}
{"kind":"binary","urls":{"linux-x64":"https://…","linux-arm64":"https://…"},"archive":"tar.gz","path":"dist/foo"}
```

**Additive, optional env** the tools image reads and defaults itself — the server MAY pass
them, nothing breaks when it does not:

| Env | Default | Meaning |
|---|---|---|
| `PORTERCLAUDE_TOOLS_MOUNT` | `/opt/porterclaude` | the path sessions mount the volume at (§13.2 — the reason absolute paths baked by `npm`/`uv` are correct) |
| `PORTERCLAUDE_TOOLS_FORCE` | `0` | `1` = reinstall every agent even when `SPEC.json` is unchanged |
| `PORTERCLAUDE_AGENT_TIMEOUT` | `900` | per-agent install timeout in seconds |
| `PORTERCLAUDE_NODE_VERSION` | pinned in `lib/runtime.sh` | Node runtime for npm agents |
| `PORTERCLAUDE_UV_VERSION` | `latest` | uv release for pip agents |
| `CLAUDE_DIST_BASE`, `PORTERCLAUDE_CLAUDE_VERSION` | as v0.1 | claude binary source / channel |

**Exit code of the populate container**: `0` unless the *payload itself* (entrypoint, shims,
libs, manifest) could not be published. A single agent failing to install is a **warning**:
it is recorded as `installed:false` + `error` in `AGENTS.json`, printed as
`[tools][warn] …`, and the job still succeeds (`backend.md` §15).

---

## 13 The tools volume, v2

### 13.1 Payload layout (frozen)

```
<toolsMount>/entrypoint.sh                    0755  session bootstrap (POSIX sh)
<toolsMount>/AGENTS.json                      0644  ToolsAgentManifest
<toolsMount>/VERSION                          0644  claude's version, or empty (v0.1 compat)
<toolsMount>/lib/pc-common.sh                 0644  sh helpers shared by shims + entrypoint
<toolsMount>/bin/pc-agent                     0755  the one shim implementation
<toolsMount>/bin/<command>                    0755  per-agent shim (execs pc-agent)
<toolsMount>/agents/<id>/run.sh               0755  generated launcher for that agent
<toolsMount>/agents/<id>/VERSION              0644  `versionCommand` output, or empty
<toolsMount>/agents/<id>/SPEC.json            0644  the AgentInstallSpec this dir was built from
<toolsMount>/agents/<id>/ERROR                0644  install error (absent on success)
<toolsMount>/agents/<id>/…                          kind-specific payload (prefix/, node_modules/, tools/)
<toolsMount>/runtime/node/bin/node            0755  libc dispatcher (POSIX sh)
<toolsMount>/runtime/node/<glibc|musl>/…            unpacked Node distribution
<toolsMount>/runtime/uv/bin/uv                0755  static uv (runs on glibc and musl)
<toolsMount>/runtime/python/…                       uv-managed CPython (glibc; musl best effort)
```

Everything is world-readable/executable (`chmod -R a+rX`, `0755` on executables): sessions
mount the volume **read-only** and run as arbitrary uids. `bin/claude-linux-*` of v0.1 is
gone — `bin/claude` is now the generic shim, so v0.1 containers keep working after an
upgrade.

### 13.2 The `/opt/porterclaude` symlink trick (why absolute paths survive)

The populate container mounts the volume at **`/out`**, sessions mount it at
**`<toolsMount>`** (`/opt/porterclaude` by default). `npm` bin shims, `uv` tool scripts and
`pyvenv.cfg` bake **absolute** paths at install time, so installing under `/out/...` would
produce launchers that point at a path no session has.

Rule: before installing anything, `populate.sh` creates the staging directory and points the
runtime path at it **inside the populate container only**:

```sh
STAGE="$OUT/.pc-stage.$$"
MOUNT="${PORTERCLAUDE_TOOLS_MOUNT:-/opt/porterclaude}"
mkdir -p "$STAGE"
rm -rf "$MOUNT"; mkdir -p "$(dirname "$MOUNT")"; ln -sfn "$STAGE" "$MOUNT"
```

Every installer then works with `$MOUNT/agents/<id>`, `$MOUNT/runtime/...` paths, so every
absolute path any third-party installer records is already the path the sessions will see.
Promotion (§13.4) moves the staged trees into `$OUT` and drops the symlink.

### 13.3 Install-time vs populate-time

| Stage | Does |
|---|---|
| image build (`docker/tools/Dockerfile`) | installs `ca-certificates curl jq tar xz-utils unzip` and copies the scripts into `/payload` + `/usr/local/bin`. **No downloads** — the image is small and its context hash only changes when *our* scripts change |
| populate run (`CMD populate.sh`) | publishes the static payload, then installs/updates the agents named in `PORTERCLAUDE_AGENTS`, writes `AGENTS.json`, promotes everything into the volume |

Consequences, to be documented by O2: a tools sync needs **network access from the docker
host**, takes minutes on the first run, and the tools volume grows (Node ≈ 60 MB, a uv
CPython ≈ 90 MB, aider's dependencies ≈ 250 MB).

**Idempotency**: an agent whose `SPEC.json` equals the incoming spec, whose `VERSION` is
non-empty and which has no `ERROR` file is *carried over* (`cp -a` from the volume into the
stage) instead of reinstalled, unless `PORTERCLAUDE_TOOLS_FORCE=1`. Agents that are no
longer in the spec are dropped from the volume (their **auth volume is never touched** —
disabling an agent must not destroy a login).

### 13.4 Promotion (ETXTBSY, still the rule)

Sessions execute binaries straight off this volume, so nothing may be written in place.
* **files** (`entrypoint.sh`, `AGENTS.json`, `bin/*`, `lib/*`, `VERSION`): staged, then
  `mv -f` over the target — `rename(2)` is allowed on a busy executable.
* **directories** (`agents/<id>`, `runtime/<name>`): staged, then swapped —
  `mv "$OUT/agents/<id>" "$OUT/agents/.<id>.old"` → `mv "$STAGE/agents/<id>" "$OUT/agents/<id>"`
  → `rm -rf "$OUT/agents/.<id>.old"`. Unlinking a running executable is legal on Linux; the
  running process keeps its inode and the next start picks up the new tree.
* Stale `$OUT/.pc-stage.*` and `$OUT/**/.*.old` directories are removed at the start of the
  next run.

### 13.5 `AGENTS.json`

Written with `jq -n` (never string concatenation) and matching
`ToolsAgentManifest` in `server/src/agents/model.ts` **exactly** — no extra keys:

```json
{
  "syncedAt": "2026-08-16T10:11:12Z",
  "agents": [
    { "id": "claude", "command": "claude", "installed": true,  "version": "2.1.5", "error": null },
    { "id": "aider",  "command": "aider",  "installed": false, "version": null,    "error": "uv tool install failed (see the job log)" }
  ]
}
```

`version` is the first line of `versionCommand` output, trimmed, or `null`.
`<toolsMount>/VERSION` mirrors the `claude` entry (empty file when claude is not installed)
so the v0.1 `cat /payload/VERSION` probe keeps working.

### 13.6 Shims and launchers

`bin/<command>` (generated, POSIX sh, 3 lines) sets `PORTERCLAUDE_AGENT_ID=<id>` and execs
`bin/pc-agent`, which:
1. resolves `TOOLS` from `$PORTERCLAUDE_TOOLS` or `dirname $0/..`;
2. errors with a clear "agent `<id>` is not installed on this host — Settings → Images →
   Sync tools" when `agents/<id>/run.sh` is missing (exit 127);
3. calls `entrypoint.sh --porterclaude-share` **before and after** the run (the v0.1
   ownership hand-back, now for every agent, not just claude);
4. runs `agents/<id>/run.sh "$@"` and propagates its exit status.

`agents/<id>/run.sh` is generated per kind and **never** contains a `/out` path:

| kind | `run.sh` execs |
|---|---|
| `script` / `binary` | the installed executable (claude: the arch+libc dispatch of §13.7) |
| `npm` | `"$TOOLS/runtime/node/bin/node" "$AGENT_DIR/node_modules/<pkg>/<binjs>" "$@"` (the bin path is resolved from the package's `package.json` at install time) |
| `pip` | `"$AGENT_DIR/tools/<pkg>/bin/<bin>" "$@"` (uv tool script, shebang → `$MOUNT/runtime/python/...`) |

Two agents claiming the same `command`: the **first** spec in `PORTERCLAUDE_AGENTS` wins;
the later one is installed but gets no shim and is recorded with
`error:"command '<cmd>' is already provided by agent '<id>'"`.

### 13.7 Architecture and libc matrix

`uname -m` in the populate container is the host architecture (`x86*64|amd64 → x64`,
`aarch*64|arm64 → arm64`); **never** hardcode an architecture literal anywhere under
`docker/`. The libc of a *session* is not known at install time — an arm64 host can run
`debian:bookworm` (glibc) and `alpine:3.20` (musl) sessions side by side — so anything that
can cover both must:

| Agent kind | glibc sessions | musl sessions |
|---|---|---|
| `claude` (override) | native binary `linux-<arch>` | native binary `linux-<arch>-musl` |
| `script` (generic, e.g. opencode) | installer output | works when the installer produces a static/musl-compatible binary — **best effort** |
| `npm` | bundled Node (nodejs.org) | bundled Node musl build (unofficial-builds.nodejs.org; may be missing for arm64) — **best effort** |
| `pip` | uv-managed CPython | **not supported** (documented; the shim prints a clear error) |
| `binary` | the `linux-<arch>` URL | the `linux-<arch>-musl` URL when the definition provides one |

Detection at runtime (`lib/pc-common.sh`, mirrored in every generated launcher):
`ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl` → musl. A missing
musl artefact falls back to the glibc one **only** when it is known to be static (claude's
musl build is static and is therefore also the glibc fallback, as in v0.1).

### 13.8 File layout of `docker/tools/` (O1)

```
docker/tools/
  Dockerfile            build: packages + copy scripts into /payload, CMD populate.sh
  populate.sh           CMD: stage → publish payload → install agents → promote  (bash)
  install-agents.sh     the agent driver: parse PORTERCLAUDE_AGENTS, install, manifest (bash)
  entrypoint.sh         RUNTIME, strict POSIX sh, ships in the payload
  lib/pc-common.sh      RUNTIME + build: log/warn, arch/libc detection (POSIX sh, ships)
  lib/common.sh         build-only helpers: download, retry, timeout, json (bash)
  lib/kinds.sh          pc_install_script / _npm / _pip / _binary (bash)
  lib/runtime.sh        pc_ensure_node / pc_ensure_uv / pc_ensure_python (bash)
  agents/<id>.sh        optional per-agent override (currently only claude.sh)
  README.md
```
Only `entrypoint.sh` and `lib/pc-common.sh` run **inside session images**: strict POSIX sh,
no bashisms, no GNU-only flags. Everything else runs only in the Debian-based tools image and
may use bash + `jq`.

**Per-agent override protocol**: if `docker/tools/agents/<id>.sh` exists it is sourced and
its `pc_agent_install_<id>` function is called *instead of* the kind installer, with the same
contract (see §13.9). It exists so a built-in can do better than the generic path — today
only `claude` does (multi-libc native binaries + installer fallback, i.e. what
`fetch-claude.sh` did in v0.1).

### 13.9 Installer contract (every kind, every override)

```
in :  $AGENT_ID  $AGENT_COMMAND  $AGENT_DIR (=$MOUNT/agents/<id>, empty, exists)
      $AGENT_SPEC (the spec object as JSON)  $TOOLS_MOUNT (=$MOUNT)  $ARCH  $TARGET
out:  0  → $AGENT_DIR/run.sh exists and is executable
      >0 → the agent is recorded installed:false; the reason was printed to stderr
never: exit the calling script, write outside $AGENT_DIR / $MOUNT/runtime, prompt, take
      longer than $PORTERCLAUDE_AGENT_TIMEOUT (the driver wraps the call in `timeout`)
```
The driver writes `SPEC.json`, `VERSION` (by running `versionCommand` through the shim) and
`ERROR`; installers never write those three.

---

## 14 `entrypoint.sh`, v2 (runtime, every session)

Still PID 1 in every managed container, still strict POSIX `sh`, still **nothing in it may
abort the container**. What changes: it is agent-generic and reads its work from the
environment instead of hardcoding `~/.claude`.

1. `TOOLS`, `HOME`/`PORTERCLAUDE_HOME`/`IMAGE_HOME` resolution: **unchanged from v0.1** (the
   passwd lookup, the `/` guard, `ORIG_PATH`).
2. `setup_path()`: unchanged (`$TOOLS/bin` first, image PATH preserved, snippets persisted
   into `/etc/profile.d/porterclaude.sh`, `$HOME/.profile`, `$HOME/.bashrc` and the image
   home's copies, guarded by a marker). Bump the marker to `porterclaude (generated v3)` so
   containers bootstrapped by a v0.1 volume get the new block appended.
3. `link_agents()` **(new, replaces `link_claude_config`)** — for every entry of
   `PORTERCLAUDE_AGENT_LINKS` (`target|source|kind;…`):
   * `mkdir -p` the parent of `target` and, for `kind=dir`, `source` itself; for
     `kind=file`, seed `source` when absent — `{}` when its name ends in `.json`, otherwise
     an empty file;
   * park an existing regular file/directory at `target` aside to `<target>.pc-backup`
     (never delete user data — the v0.1 `park_aside` is reused verbatim);
   * `ln -s "$source" "$target"`.
   Failures warn and continue (a read-only auth volume, a not-yet-chowned mountpoint).
4. `claim_agents()` **(new, replaces `claim_shared`)** — root only: determine the owner as
   the first non-root owner among `<home>/.porterclaude/agents/*`, falling back to
   `1000:1000` (the recipe user), then `chown -R` `<home>/.porterclaude` and every link
   target it created. Non-root sessions only warn when an agent dir belongs to a foreign uid.
5. `install_agent_wrappers()` **(new, replaces `install_claude_wrapper`)** — root only:
   for every `$TOOLS/bin/*` shim whose name does not already resolve to something outside
   `$TOOLS`, write a 3-line `/usr/local/bin/<name>` that execs it (covers non-login shells).
   `pc-agent` itself is skipped.
6. `bridge_image_home()` — generic: for every link target under `$HOME`, create the same
   relative path under `$IMAGE_HOME` pointing at the same `source`.
7. `bootstrap_packages()` (git + tmux, root only, best effort) and the idle loop: unchanged.
8. Modes: `--porterclaude-share` → step 4 only; `--porterclaude-bootstrap` → steps 2–6
   (the server's root exec after start); no flag → the full sequence, then `exec "$@"` /
   idle loop.

Ordering note for QA: on a **fresh** auth volume the mountpoint is `root:root`, so a recipe
session (uid 1000) cannot create the link sources — step 3 warns, the server chowns and
re-runs `--porterclaude-bootstrap`, and only then are the links complete. That is by design;
the session is usable either way.

---

## 15 Recipes, v0.2

Recipes are **language-toolchain images only**. `common.sh`:

* keeps: apt toolchain, `gh`, the `dev` user (uid 1000), `/etc/profile.d/porterclaude.sh`,
  `/etc/porterclaude/recipe`, cleanup;
* **drops** `install_claude()` entirely (no `/opt/claude`, no `/usr/local/bin/claude`, no
  `/etc/porterclaude/claude-version`, no `PORTERCLAUDE_CLAUDE_VERSION=` build-log marker);
* **drops** the `~/.claude`, `~/.claude/projects` and `~/.claude-home` seeding, and creates
  `/home/dev/.porterclaude/agents` (0755, `1000:1000`) instead — the parent of every agent
  mount, so docker's copy-up has an owner to work with;
* `write_entrypoint()` shrinks: `pc-entrypoint.sh` sets `HOME`/`TERM`, writes
  `/tmp/porterclaude-ready` and `exec "$@"` (idle-loop fallback). It exists only for people
  running a recipe image by hand — PorterClaude always overrides the entrypoint with the
  tools volume's.

Recipe Dockerfiles: drop `ARG CLAUDE_VERSION` and the `porterclaude.claude-version` label;
everything else (base images, `USER dev`, `WORKDIR /workspace`, `ENTRYPOINT`, `CMD`, the php
supervisord stack, the arch-neutrality rules) is unchanged. `RecipeStatus.claudeVersion` is
now sourced from the tools volume (`backend.md` §15) — a recipe image that still carries the
old label is simply reporting a stale hint.

Changing `common.sh` re-hashes all six recipe contexts (`outdated` flips) — intended, and
this time it is *required*: an operator who does not rebuild keeps images with a stale
`claude` inside, which is harmless (the tools volume shadows it on `PATH`) but confusing.

---

## 16 App image, compose, deploy, CI

* `docker/Dockerfile`, `.dockerignore`: **unchanged**. `COPY docker ./docker` already ships
  the new `docker/tools/lib` and `docker/tools/agents` subdirectories, and both the build
  context tar and the context hash walk directories recursively
  (`server/src/images/tarContext.ts`) — no change needed there either.
* Root `docker-compose.yml`, `deploy/docker-compose.yml`, `deploy/deploy.sh`,
  `deploy/lib/*.py`, `.env.example`: **no functional change**. Comments/docs only:
  `PORTERCLAUDE_BACKEND` / `PORTAINER_*` / `DOCKER_SOCKET` now seed the **first host** and
  only while no host exists; everything else is configured in the app.
* `.github/workflows/release.yml`: unchanged.
* `.github/workflows/ci.yml` (O2):
  * replace the fixed `bash -n` / `shellcheck` file list with a loop over
    `docker/tools/*.sh docker/tools/lib/*.sh docker/tools/agents/*.sh docker/recipes/*.sh
    deploy/*.sh deploy/lib/*.sh` that picks `sh -n` or `bash -n` from the shebang — so
    adding or deleting a script needs no CI change;
  * `install-agents.sh --plan` with a canned `PORTERCLAUDE_AGENTS` (one spec per kind) must
    exit 0, print one plan line per agent, touch **no** files and reach **no** network;
  * `--plan` with malformed JSON must exit non-zero;
  * parity: every `docker/tools/agents/<id>.sh` id exists in `server/src/agents/builtin.ts`;
  * guard: `grep -R "claude.ai/install.sh" docker/recipes/` finds nothing, and no recipe
    Dockerfile mentions `claude`;
  * guard: `docker/tools/entrypoint.sh` mentions `PORTERCLAUDE_AGENT_LINKS`, and the keys in
    the `AGENTS.json` writer match `ToolsAgentManifest` (`grep` both files);
  * the existing jobs (`node`, `compose`, `image`, the deploy dry-run and secret-hygiene
    assertions) stay exactly as they are.

---

## 17 Failure modes (v0.2 additions)

| Failure | Expected behaviour |
|---|---|
| `PORTERCLAUDE_AGENTS` missing/empty | payload is published, `AGENTS.json` gets `agents: []`, exit 0 (a host with no agents is legal) |
| `PORTERCLAUDE_AGENTS` is not valid JSON | exit **non-zero** before touching the volume (a broken spec is a server bug, not an agent problem) |
| one agent's download/install fails | warning + `installed:false` + `error` in the manifest; the job succeeds; the shim is still written and prints the error when invoked |
| an agent times out | same as a failure, with `error:"timed out after Ns"` |
| the Node/uv runtime cannot be fetched | every agent of that kind fails with a shared error; other kinds are unaffected |
| an agent's `versionCommand` fails | `installed:true`, `version:null` (it may need credentials to start) |
| a musl session starts a pip agent | the shim exits non-zero with "aider requires a glibc image on this host" |
| the auth volume mountpoint is still `root:root` | `link_agents` warns; the server's chown + `--porterclaude-bootstrap` completes the wiring |
| an upgraded install has never re-synced tools | sessions come up, `PATH` has no agents, the shims are absent; the UI shows "no agents installed on this host" |

---

## 18 Test plan (v0.2)

Static, on the dev box (no docker CLI):

1. Shebang-aware `sh -n` / `bash -n` over every script under `docker/` and `deploy/`;
   `shellcheck -S warning` clean.
2. `docker/tools/install-agents.sh --plan` with a canned four-kind spec: exit 0, one line per
   agent, no network, no writes (run it with `OUT` pointing at an empty temp dir and assert
   the directory is still empty).
3. `docker/tools/entrypoint.sh` link parsing: a harness that sets
   `PORTERCLAUDE_AGENT_LINKS='/tmp/h/.claude|/tmp/h/.porterclaude/agents/claude/claude|dir;/tmp/h/.claude.json|/tmp/h/.porterclaude/agents/claude/claude.json|file'`,
   `PORTERCLAUDE_HOME=/tmp/h`, runs `entrypoint.sh --porterclaude-bootstrap` and asserts both
   symlinks, the `{}` seed and that a pre-existing `/tmp/h/.claude` directory was parked to
   `.pc-backup` instead of being deleted. Runs on the dev box under Git Bash.
4. Grep guards: no arch literal (`x86_64`, `aarch64`, a bare `amd64`/`arm64` in a URL) under
   `docker/`; no `claude` in `docker/recipes/**`; no `/out` in any generated `run.sh` writer.
5. Recipe assertions of v0.1 §10.2 minus the claude ones, plus: every recipe Dockerfile has
   no `ARG CLAUDE_VERSION`.
6. `AGENTS.json` key parity with `server/src/agents/model.ts` (`ToolsAgentManifest`).
7. The v0.1 static suite (`deploy.sh --dry-run`, context-tar security sweep, compose
   validation, secret hygiene) must still pass untouched.

Integration (reference host, after a real sync):

8. Sync tools on a migrated v0.1 host → `AGENTS.json` lists `claude` installed with a
   version → a recipe session opens an `agent:claude` terminal → **no** `/login` prompt (the
   legacy import worked) → `which claude` resolves into `/opt/porterclaude/bin`.
9. Enable `opencode` + `gemini` → sync → both `installed:true` with versions; the Node
   runtime exists; a session recreate later `agent:gemini` starts.
10. A session on `alpine:3.20` (musl): `claude` works, `gemini` works or fails with a clear
    message, `aider` fails with the documented glibc message — the container stays up either
    way.
11. Re-sync while a session is running `claude`: no `ETXTBSY`, the running agent keeps
    working, a newly started one is the new version.
12. Disable an agent → sync → its `agents/<id>` directory disappears from the volume, its
    **auth volume still exists**, re-enabling + syncing restores it with the login intact.
13. Second host (Portainer): its tools volume is populated independently; a login on host A
    does **not** authenticate host B.
