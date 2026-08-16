# docker/ — images

OWNER: O1. Design: [`docs/design/orchestration.md`](../docs/design/orchestration.md)
(§11–§15 describe v0.2 and win where they contradict the older sections).

| Path | Image | Built by | Tag |
|---|---|---|---|
| `Dockerfile` | the PorterClaude app | `deploy/deploy.sh` (Portainer `/build`) or CI buildx | `porterclaude:local` / `ghcr.io/<owner>/porterclaude:<ver>` |
| `recipes/<name>/Dockerfile` | session dev images | the app itself, Settings → Images | `porterclaude/<name>:latest` |
| `tools/Dockerfile` | payload for the per-host tools volume | the app itself, Settings → Images → Sync tools | `porterclaude/tools:latest` |

Recipes and the tools image are **never** published: they are built natively on whichever
host runs the sessions, so amd64 and arm64 both work without buildx.

## Coding agents are not part of any image (v0.2)

A recipe is a **language-toolchain image and nothing else**. Claude Code, opencode, gemini,
codex, aider and any custom agent live in the **per-host tools volume**
([`tools/README.md`](tools/README.md)), which PorterClaude mounts read-only into *every*
session — recipe and custom image alike — and whose `entrypoint.sh` it uses as the container
entrypoint. That is what makes "enable an agent → Sync tools" work without rebuilding an
image, and what makes one login per host authenticate every session on it.

**Never add an agent installer to a recipe.** It would shadow the volume's version on
`PATH`, inflate the image, and break the shared-login model. CI greps `docker/recipes/` for
installer patterns and for `ARG CLAUDE_VERSION` and fails the build if one comes back.

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

`common.sh` provisions: the apt toolchain (`git gh ripgrep tmux curl jq unzip …`,
deliberately **no sudo**), user `dev` with **uid 1000 / gid 1000** and `HOME=/home/dev` (a
pre-existing uid-1000 account such as `node` is *renamed*, never deleted),
`/home/dev/.porterclaude/agents` owned by `1000:1000` (the parent of every per-agent auth
volume mount, so docker's copy-up has an owner to work with), `/etc/porterclaude/recipe`,
`/etc/profile.d/porterclaude.sh` and `/usr/local/bin/pc-entrypoint.sh`.

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
`/home/dev/.dotnet/tools`, `php` → `/home/dev/.composer/vendor/bin`. The agents' own
directory (`<toolsMount>/bin`) is prepended at *runtime* by the tools volume's entrypoint,
not here — an image must stay usable without the volume.

Builds go through the **classic** builder: no BuildKit-only features at all (no syntax
directive, no build mounts, no per-build platform override, no heredoc `COPY`). Nothing may
hardcode an architecture — use `dpkg --print-architecture` or a `uname -m` `case`.

## Labels and versions

* `porterclaude.recipe=<name>` is set by every recipe Dockerfile; the recipe name also lands
  in `/etc/porterclaude/recipe` inside the image.
* `porterclaude.context-hash` and `porterclaude.built-at` are added by the server at build
  time — Dockerfiles must not set them.
* There is **no** claude version in a recipe image any more (no `ARG CLAUDE_VERSION`, no
  `porterclaude.claude-version` label, no `/etc/porterclaude/claude-version`). The version
  the Images panel shows comes from the tools volume's `AGENTS.json`; an image built by v0.1
  may still carry the old label, which is then a stale hint and nothing else.

## Disk usage: rebuilds leave the previous image behind

A rebuild re-tags `porterclaude/<name>:latest`, and the image the tag pointed at before
becomes **untagged (dangling)** — it is not deleted, and it is not small: ~0.6 GB for `base`,
1.4 GB for `node`. A handful of rebuild cycles fills a small VPS; the reference host had
23 GB of them.

The server therefore removes the image a successful build replaced (`ImageService`
`removeReplacedImage`, `server/src/images/service.ts`): only when the tag really moved, the
old id is now untagged, and no container still uses it — a `409 Conflict` is reported into
the job log and the image is kept. Images left over from *before* that fix, or held by a
stopped container, still have to be collected by hand:

```bash
# on the docker host: only images this project built
docker image prune -f --filter label=porterclaude.recipe
```

or, through the Portainer API and without shell access to the host,
[`deploy/host-prep.sh --prune`](../deploy/README.md) (`--dry-run` first: it lists every
image it would remove with its size).

## Runtime contract of a session

Identical for a recipe image and a custom image — the difference is only which `CMD` runs:

```
entrypoint  ["<toolsMount>/entrypoint.sh"]          always the tools volume's bootstrap
cmd         recipe: the image CMD (base/node/…: sleep infinity, php: supervisord)
            custom: ["sleep","infinity"]
user        recipe: dev (uid 1000, gid 1000), HOME=/home/dev, no sudo
            custom: whatever the image uses; $HOME is pinned to the container home
workdir     /workspace (recipes)
mounts      porterclaude-tools          -> /opt/porterclaude                        (read-only)
            porterclaude-auth-<agentId> -> /home/dev/.porterclaude/agents/<agentId>
            porterclaude-hist-<slug>    -> <agent dir>/<shared path>/…  (shareHistory:false)
            <workspace volume>          -> /workspace
env         PORTERCLAUDE_TOOLS, PORTERCLAUDE_HOME, HOME, PATH, TERM,
            PORTERCLAUDE_SESSION, PORTERCLAUDE_HOST,
            PORTERCLAUDE_AGENT_IDS=claude,gemini
            PORTERCLAUDE_AGENT_LINKS=<target>|<source>|<kind>;…
```

The entrypoint creates one symlink per `PORTERCLAUDE_AGENT_LINKS` entry (`~/.claude` →
`~/.porterclaude/agents/claude/claude`, `~/.claude.json` →
`~/.porterclaude/agents/claude/claude.json`, …), parks anything already sitting there as
`*.pc-backup` instead of deleting it, seeds a missing `kind:file` source (`{}` for
`.json`/`.yml`/`.yaml`, an empty file otherwise — a zero-byte `.yml` makes aider abort with
`yaml.load(...) returned type NoneType`), repairs the ownership of the agent volumes, drops
`/usr/local/bin` wrappers for non-login shells and bridges the image's own home when it
differs from `$HOME`. Every step is best effort: nothing in it may abort the container.

`pc-entrypoint.sh` (written by `common.sh`) only matters when somebody runs a recipe image by
hand: it sets `HOME`/`TERM`, writes `/tmp/porterclaude-ready` and `exec "$@"` (with a portable
idle loop when the command is `sleep infinity`, so images whose `sleep` rejects `infinity`
still stay up).

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
(e.g. `PC_HTTP_PORT=8080`, ports `8080:8080`). The php image keeps its own `CMD`
(`supervisord`) under the entrypoint override, so the sample page is served exactly as before.

## Adding a recipe

1. Create `docker/recipes/<name>/Dockerfile` from the frozen skeleton: `FROM <base>`,
   `LABEL porterclaude.recipe="<name>"`, `ENV … PORTERCLAUDE_RECIPE=<name>`
   (plus `PORTERCLAUDE_PATH_EXTRA` if the toolchain needs it),
   `COPY common.sh /tmp/common.sh`, `RUN bash /tmp/common.sh && rm -f /tmp/common.sh`,
   the recipe-specific layers, `USER dev`, `WORKDIR /workspace`,
   `ENTRYPOINT ["/usr/local/bin/pc-entrypoint.sh"]`, `CMD ["sleep","infinity"]`.
2. **No coding agent, no `ARG CLAUDE_VERSION`, no architecture literal, no BuildKit
   feature.** Everything the session user writes to must be owned by `1000:1000` or live
   under `/tmp`.
3. Add the matching entry to `RECIPES` in `server/src/images/recipes.ts`. **That file is
   backend-owned** — raise the change with the backend topic instead of editing it here.
   The directory name and the registry name must be identical.

## The app image

`docker/Dockerfile` is multi-stage and is built with the **repo root** as context
(`-f docker/Dockerfile .`), filtered by `/.dockerignore` (which excludes `deploy/.env*`,
every root-level `data*` directory and any `secret.key` — **secrets must never enter a build
context**; the build stage does `COPY . .`, and `deploy/deploy.sh` uploads the very same tar
to a remote engine). A `DATA_DIR` placed inside the checkout therefore has to be named
`data…`; see `docs/DEPLOYMENT.md`. The runtime layer ships `/app/node_modules`,
`/app/server/dist`, `/app/web/public` and `/app/docker` (which is how the recipe **and** the
tools build contexts, including `docker/tools/lib` and `docker/tools/agents`, reach the
running server), runs as uid 10001, exposes 8080 and healthchecks `GET /api/health` with
node's built-in `fetch` (there is no curl or wget in the image, so no compose file may
override the healthcheck with one).

Because it runs as a non-root uid, socket mode needs the docker group:

```yaml
group_add: ["<gid>"]        # stat -c %g /var/run/docker.sock
```

See the root [`docker-compose.yml`](../docker-compose.yml) and
[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).
