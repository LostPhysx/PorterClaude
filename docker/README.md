# docker/ — images

> **v0.2 — TODO(O1): rewrite this file for the agent model.** Recipes no longer bake a
> coding agent in; every agent is delivered through the per-host tools volume and every
> session (recipe and custom alike) is started with `<toolsMount>/entrypoint.sh`. See
> [`docs/design/orchestration.md` §13–§15](../docs/design/orchestration.md).


OWNER: O1. Design: [`docs/design/orchestration.md`](../docs/design/orchestration.md).

| Path | Image | Built by | Tag |
|---|---|---|---|
| `Dockerfile` | the PorterClaude app | `deploy/deploy.sh` (Portainer `/build`) or CI buildx | `porterclaude:local` / `ghcr.io/<owner>/porterclaude:<ver>` |
| `recipes/<name>/Dockerfile` | session dev images | the app itself, Settings → Images | `porterclaude/<name>:latest` |
| `tools/Dockerfile` | payload for the shared tools volume | the app itself, Settings → Images → Sync tools | `porterclaude/tools:latest` |

Recipes are **never** published: they are built natively on whichever host runs the
sessions, so amd64 and arm64 both work without buildx.

## How a recipe is built

The server tars `docker/recipes/<name>/` and **injects `docker/recipes/common.sh` at the tar
root**, then POSTs the tar to the Docker Engine `/build` API. Inside the build context the
shared script is therefore a plain sibling of the Dockerfile:

```dockerfile
COPY common.sh /tmp/common.sh
RUN bash /tmp/common.sh && rm -f /tmp/common.sh
```

`common.sh` is the *only* extra file in the context — anything else it needs it generates
itself with heredocs (that is why `/usr/local/bin/pc-entrypoint.sh` is written by
`common.sh` rather than copied). Editing `common.sh` changes the context hash of **all six**
recipes, so the Images panel flips every one of them to *outdated*. That is intended.

`common.sh` provisions: the apt toolchain (`git gh ripgrep tmux curl jq unzip …`, deliberately
**no sudo**), user `dev` with **uid 1000 / gid 1000** and `HOME=/home/dev` (a pre-existing
uid-1000 account such as `node` is *renamed*, never deleted), Claude Code via the native
installer, `/etc/profile.d/porterclaude.sh` and `/usr/local/bin/pc-entrypoint.sh`.

### PATH in terminals

Terminals open **login** shells, and Debian's `/etc/profile` unconditionally *replaces* `PATH`
with `/usr/local/bin:/usr/bin:/bin:…` — everything the base image put into its `ENV PATH`
(`golang`: `/usr/local/go/bin`, which has no symlink in `/usr/local/bin`) is gone by then. So
`common.sh` bakes the **build-time** `PATH` into `/etc/profile.d/porterclaude.sh` and rebuilds
it there as

```
$HOME/.local/bin : $PORTERCLAUDE_PATH_EXTRA : /usr/local/bin : <image ENV PATH> : $PATH
```

with duplicates dropped (`pc_path_compose`, so sourcing it twice is a no-op). A recipe
Dockerfile adds directories that only exist at runtime by setting `ENV PORTERCLAUDE_PATH_EXTRA`
**before** it runs `common.sh`: `go` → `/home/dev/go/bin` (`$GOPATH/bin`), `dotnet` →
`/home/dev/.dotnet/tools`, `php` → `/home/dev/.composer/vendor/bin`.

Builds go through the **classic** builder: no BuildKit-only features at all (no syntax
directive, no build mounts, no per-build platform override, no heredoc `COPY`). Nothing may
hardcode an architecture — use `dpkg --print-architecture` or a `uname -m` `case`.

## Versions and labels

* Build arg `CLAUDE_VERSION` (default **`stable`** in every recipe *and* in
  `tools/Dockerfile`, so a recipe session and a custom-image session run the same Claude
  Code) is both **passed to the installer** by `common.sh` and recorded as the label
  `porterclaude.claude-version`:

  ```bash
  docker build --build-arg CLAUDE_VERSION=2.1.200 …    # installs 2.1.200, label says 2.1.200
  ```

  `install.sh [version]` takes `stable`, `latest` or an exact version. `stable` is the
  installer's own default and is therefore passed as *no* argument at all, so an older
  installer that ignores arguments still produces what the label promises. When an exact
  version is requested and the installer produces something else, the build log carries a
  `[porterclaude][warn] requested claude version … but the installer produced …` line — the
  label must never claim a version the image does not have.
* The **exact** installed version is written to `/etc/porterclaude/claude-version` inside the
  image (`docker exec <c> cat /etc/porterclaude/claude-version`). The recipe name lands in
  `/etc/porterclaude/recipe`.
* `porterclaude.context-hash` and `porterclaude.built-at` are added by the server at build
  time — Dockerfiles must not set them.

## Disk usage: rebuilds leave the previous image behind

A rebuild re-tags `porterclaude/<name>:latest`, and the image the tag pointed at before
becomes **untagged (dangling)** — it is not deleted, and it is not small: ~0.6 GB for `base`,
1.4 GB for `node`, ~1.2 GB for the tools image (four claude binaries). A handful of
*Sync tools* / rebuild cycles fills a small VPS; the reference host had 23 GB of them.

The server therefore removes the image a successful build replaced (`ImageService`
`removeReplacedImage`, `server/src/images/service.ts`): only when the tag really moved, the
old id is now untagged, and no container still uses it — a `409 Conflict` is reported into
the job log and the image is kept. Images left over from *before* that fix, or held by a
stopped container, still have to be collected by hand:

```bash
# on the docker host: only images this project built
docker image prune -f --filter label=porterclaude.recipe
docker image prune -f --filter label=porterclaude.claude-version
```

or, through the Portainer API and without shell access to the host,
[`deploy/host-prep.sh --prune`](../deploy/README.md) (`--dry-run` first: it lists every
image it would remove with its size).

## Runtime contract of a recipe image

```
user        dev (uid 1000, gid 1000), HOME=/home/dev, no sudo
workdir     /workspace
entrypoint  ["/usr/local/bin/pc-entrypoint.sh"]     links ~/.claude.json into ~/.claude-home
cmd         ["sleep","infinity"]                    (php: supervisord)
mounts      porterclaude-claude       -> /home/dev/.claude
            porterclaude-claude-home  -> /home/dev/.claude-home
            porterclaude-hist-<slug>  -> /home/dev/.claude/projects   (shareHistory:false)
            workspace                 -> /workspace
```

`common.sh` ships `/home/dev/.claude/projects` (0700, `dev:dev`) **in the image**, and that
is load-bearing: when a `shareHistory:false` session mounts its private history volume at
`/home/dev/.claude/projects`, docker creates a *missing* mountpoint inside the shared
`porterclaude-claude` volume as `root:root`, and from then on every uid-1000 session gets
`Permission denied` on `~/.claude/projects` — Claude Code's conversation store. Because the
directory exists in the image, docker's copy-up seeds both the shared volume and each fresh
history volume with the right owner instead. (The server repairs volumes that predate this;
see `docs/design/backend.md` §7.)

`pc-entrypoint.sh` is best-effort throughout: every step logs on failure and the container
still comes up. It never deletes user data — an existing regular `~/.claude.json` is moved
into the shared volume (or parked as `~/.claude.json.pc-backup`) before the symlink is made.
When the command is exactly `sleep infinity` it runs a portable idle loop instead, so images
whose `sleep` rejects `infinity` still stay up and `docker stop` is still honoured.

## The recipes

| Recipe | Base | Extra |
|---|---|---|
| `node` | `node:22-bookworm` | `corepack enable` (pnpm/yarn); npm cache under `/home/dev/.npm`; the base's uid-1000 `node` user is renamed to `dev` |
| `dotnet` | `mcr.microsoft.com/dotnet/sdk:9.0` | telemetry off, `NUGET_PACKAGES` + `DOTNET_CLI_HOME` under `/home/dev`, `~/.dotnet/tools` on the login PATH |
| `php` | `php:8.3-fpm-bookworm` | nginx + supervisord + composer (`~/.composer/vendor/bin` on the login PATH), `pdo_mysql opcache zip intl`, serves `/workspace/public` on port 80 |
| `python` | `python:3.13-bookworm` | `uv` + `pipx` |
| `go` | `golang:1.23-bookworm` | `GOPATH` / `GOCACHE` under `/home/dev`, `$GOPATH/bin` + the image's `/usr/local/go/bin` on the login PATH |
| `base` | `debian:bookworm-slim` | nothing beyond `common.sh` |

### php: port 80 as an unprivileged user

nginx and php-fpm both run as uid 1000, so every writable path lives under `/tmp`
(`/tmp/nginx.pid`, `/tmp/php-fpm.pid`, `/tmp/nginx/*`) and both log to the container's
stdout/stderr. Binding **port 80 as uid 1000** works because dockerd sets
`net.ipv4.ip_unprivileged_port_start=0` inside containers.

Where an engine does *not* allow it (hardened sysctls, some rootless setups), nginx fails to
bind and supervisord restarts it in a loop. The escape hatch is the env var **`PC_HTTP_PORT`**
(default `80`): set it on the session, and `/usr/local/bin/pc-nginx.sh` rewrites `listen 80;`
into a copy of the config in `/tmp` before starting nginx. Publish that port instead
(e.g. `PC_HTTP_PORT=8080`, ports `8080:8080`).

## Adding a recipe

1. Create `docker/recipes/<name>/Dockerfile` from the frozen skeleton (`ARG CLAUDE_VERSION`,
   the two labels, `COPY common.sh /tmp/common.sh`, `RUN bash /tmp/common.sh`, `USER dev`,
   `WORKDIR /workspace`, the `pc-entrypoint.sh` ENTRYPOINT).
2. Add the matching entry to `RECIPES` in `server/src/images/recipes.ts`. **That file is
   backend-owned** — raise the change with the backend topic instead of editing it here.
   The directory name and the registry name must be identical.

## The app image

`docker/Dockerfile` is multi-stage and is built with the **repo root** as context
(`-f docker/Dockerfile .`), filtered by `/.dockerignore` (which excludes `deploy/.env*`,
every root-level `data*` directory and any `secret.key` — **secrets must never enter a build
context**; the build stage does `COPY . .`, and `deploy/deploy.sh` uploads the very same tar
to a remote engine). A `DATA_DIR` placed inside the checkout therefore has to be named
`data…`; see `docs/DEPLOYMENT.md`. The runtime layer ships `/app/node_modules`,
`/app/server/dist`, `/app/web/public` and `/app/docker`, runs as uid 10001, exposes 8080 and
healthchecks `GET /api/health` with node's built-in `fetch` (there is no curl or wget in the
image, so no compose file may override the healthcheck with one).

Because it runs as a non-root uid, socket mode needs the docker group:

```yaml
group_add: ["<gid>"]        # stat -c %g /var/run/docker.sock
```

See the root [`docker-compose.yml`](../docker-compose.yml) and
[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).
