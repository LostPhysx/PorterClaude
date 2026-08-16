# Deploying PorterClaude

PorterClaude is one container. It needs:

- a **persistent** `/data` volume (config, encrypted secrets, session definitions)
- a way to reach Docker: **socket mode** (mount `/var/run/docker.sock`) or
  **Portainer mode** (URL + API key entered in Settings)
- an HTTPS reverse proxy in front of it that passes WebSockets (terminals)

> **`/data` is load-bearing.** It holds `secret.key`, which encrypts the stored Portainer
> API key and signs session cookies. Losing the volume logs everyone out and makes the
> stored key undecryptable — you then have to re-enter it in Settings. Set `APP_SECRET`
> explicitly if you prefer to manage the key yourself.

## Modes

| | Socket mode | Portainer mode |
|---|---|---|
| Where the app runs | on the Docker host it manages | anywhere |
| Setup | mount `/var/run/docker.sock` (+ `group_add`, see below) | paste Portainer URL + API key in Settings |
| Terminal stream | hijacked exec over the socket | `wss://<portainer>/api/websocket/exec` (API key OK) |
| Multiple Docker hosts | no | yes — pick the endpoint in Settings |
| Security note | app has root-equivalent access to the host | key scoped by Portainer RBAC |

Both are chosen/changed in **Settings** at runtime. Env vars can pre-seed them for
unattended installs (`PORTERCLAUDE_BACKEND`, `PORTAINER_URL`, `PORTAINER_API_KEY`,
`PORTAINER_ENDPOINT_ID`).

### The docker socket and the non-root user

The image runs as **uid 10001**, not root. A bind-mounted `/var/run/docker.sock` is
typically `root:docker 660`, so the container must be a member of that group:

```bash
stat -c %g /var/run/docker.sock      # e.g. 999 — the gid, which differs per host
```

```yaml
    group_add:
      - "999"        # the gid printed above
```

The gid differs per host (Debian/Ubuntu commonly 999 or 989, Fedora 992 …), so **do not copy
the number above**. `deploy/deploy.sh` reads it from `DOCKER_GID` in `deploy/.env` and, when
that is unset, asks the engine itself: it runs a throwaway `alpine` container that
bind-mounts the socket read-only, prints `stat -c %g`, and is removed again.

Alternatives: `user: "0:0"` (drops the non-root hardening) or a socket proxy. Without it the
app starts fine but Settings reports the socket as unavailable — that hint is *correct*, not
a bug. Portainer mode needs no socket at all.

## Environment variables

Complete list (server defaults in brackets):

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | listen port |
| `HOST` | `0.0.0.0` | listen address |
| `DATA_DIR` | `./data` (`/data` in the image) | config + secret key — must persist |
| `APP_PASSWORD` | – | first-run password seed for the web UI |
| `APP_SECRET` | auto (`<DATA_DIR>/secret.key`) | encryption + JWT key material |
| `PORTERCLAUDE_BACKEND` | – | `socket` or `portainer` seed |
| `PORTAINER_URL` | – | Portainer base URL seed |
| `PORTAINER_API_KEY` | – | Portainer API key seed (stored encrypted, never returned by the API) |
| `PORTAINER_ENDPOINT_ID` | – | Portainer endpoint id seed |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | socket path for socket mode |
| `LOG_LEVEL` | `info` | pino log level |
| `COOKIE_SECURE` | `auto` | `auto` (secure when the request is https, `X-Forwarded-Proto` aware) / `true` / `false` |
| `TRUST_PROXY` | `1` | Express `trust proxy` value — set it when behind a reverse proxy |
| `SESSION_TTL_DAYS` | `30` | login cookie lifetime |
| `PORTERCLAUDE_DOCKER_DIR` | `<repo>/docker` | recipe + tools build contexts |
| `WEB_DIR` | `<repo>/web/public` | static root |
| `ENABLE_REQUEST_LOG` | `true` | pino-http request logging on/off |

Env vars only *seed* the config: once `config.json` exists, Settings wins.

### `DATA_DIR` and the repository checkout

`DATA_DIR` holds `secret.key` and `config.json` — the key that encrypts the Portainer API
key, and the encrypted key itself. Treat that directory as secret material.

If you point `DATA_DIR` at a path **inside a checkout of this repository** (handy for local
development), its name **must start with `data`** — `data/`, `data.dev`, `data.qa.frontend`,
… That prefix is what `.gitignore` (`data*/`) and `.dockerignore` (`data*`) key on, so it is
what keeps the directory out of `git add -A` and out of every Docker build context (the app
image's build stage does `COPY . .`, and `deploy/deploy.sh` uploads the same context to the
remote engine). `deploy/deploy.sh` additionally refuses to upload any context containing a
`secret.key` or a `data*/config.json`. In production, keep `DATA_DIR` outside the checkout
entirely — the container default `/data` on the `porterclaude-data` volume.

## Generic compose

```yaml
services:
  porterclaude:
    image: ghcr.io/lostphysx/porterclaude:latest
    restart: unless-stopped
    init: true
    ports:
      - "8080:8080"
    environment:
      APP_PASSWORD: change-me
      TRUST_PROXY: "1"
    volumes:
      - porterclaude-data:/data                      # MUST persist
      - /var/run/docker.sock:/var/run/docker.sock    # remove for Portainer-only mode
    group_add:
      - "999"                                        # stat -c %g /var/run/docker.sock
volumes:
  porterclaude-data:
```

The image ships its own `HEALTHCHECK` (node's built-in `fetch` against `/api/health`).
**Do not override it with a `wget`/`curl` command** — the runtime image contains neither, so
the container would be marked unhealthy forever.

## Behind nginx-proxy + acme-companion

If your host uses `nginxproxy/nginx-proxy` + `nginxproxy/acme-companion`, drop the
`ports:` mapping and add the proxy env vars + networks instead:

```yaml
services:
  porterclaude:
    image: ghcr.io/lostphysx/porterclaude:latest
    restart: unless-stopped
    init: true
    environment:
      APP_PASSWORD: change-me
      VIRTUAL_HOST: claude.example.com
      LETSENCRYPT_HOST: claude.example.com
      VIRTUAL_PORT: 8080
      TRUST_PROXY: "1"
    volumes:
      - porterclaude-data:/data
      - /var/run/docker.sock:/var/run/docker.sock
    group_add: ["999"]
    networks: [proxy_net]        # the network nginx-proxy is attached to
networks:
  proxy_net:
    external: true
volumes:
  porterclaude-data:
```

### Reverse-proxy requirements

* **WebSocket upgrade.** Terminals use `GET /api/terminals` with `Upgrade: websocket`; the
  proxy must forward the `Upgrade` and `Connection` headers. nginx-proxy does this by
  default; a hand-written vhost needs:

  ```nginx
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  ```

* **Idle timeouts.** A terminal that sits idle longer than `proxy_read_timeout` (nginx
  default 60 s) is cut. Raise it for this vhost — with nginx-proxy, drop a file into
  `vhost.d/<host>`:

  ```nginx
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
  ```

  The server also pings every WebSocket periodically, but the proxy must allow the idle
  time in between.

* **TLS.** Keep `COOKIE_SECURE=auto` and `TRUST_PROXY=1` so the login cookie is issued with
  `Secure` when the browser is on https.

### Reverse-proxy requirements for the **Portainer** vhost

This is a *different* vhost from the PorterClaude one above, and it is easy to miss:
PorterClaude drives the managed engine through Portainer's Docker proxy, and two of those
calls are long-running streams — `POST …/docker/build` (recipe images, and the app image
when `deploy/deploy.sh` builds remotely) and the container log/attach streams.

Measured on the reference host (Portainer behind nginx-proxy, defaults): the `/build`
response was buffered and only delivered when the build finished, and a build that ran
longer than 60 s got an HTML `504 Gateway Time-out` instead — at which point docker cancels
the build ("aborted"). Every recipe whose build takes more than a minute (`php`, `python`,
`go`, `dotnet`) and every remote app-image build is affected.

So the vhost in front of **Portainer** needs:

```nginx
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;          # stream the build/log output as it is produced
proxy_request_buffering off;  # stream the (large) build-context upload
client_max_body_size 0;       # a build context can be tens of MB
```

With nginx-proxy that is a file `vhost.d/<portainer-host>` on the proxy container, followed
by a reload (`docker kill -s HUP <nginx-proxy>`). **Do this before running
`deploy/deploy.sh` or building recipes from Settings → Images.**

[`deploy/host-prep.sh`](../deploy/README.md) writes both vhost files and reloads the proxy
through the Portainer API, so it needs no shell on the host:

```bash
bash deploy/host-prep.sh --dry-run --vhost --reload   # prints the files it would write
bash deploy/host-prep.sh --vhost --reload
```

Symptoms while it is missing: a build job that dies after ~60 s with `aborted`; `deploy.sh`
stopping with *"the build never reached the engine (proxy timeout)"* followed by the exact
snippet to install. Nothing is built and nothing is deployed in that case — the previous
image is never silently redeployed.

**Escape hatch.** If you cannot change the proxy, skip the remote build and deploy an image
that already exists (CI publishes multi-arch images to ghcr.io):

```bash
bash deploy/deploy.sh --image ghcr.io/lostphysx/porterclaude:latest
```

## Deploying via Portainer Stacks (API)

```
POST /api/stacks/create/standalone/string?endpointId=<id>
X-API-Key: <key>
{ "name": "porterclaude", "stackFileContent": "<compose yaml>",
  "env": [{ "name": "APP_PASSWORD", "value": "…" }] }
```

Update: `PUT /api/stacks/<stackId>?endpointId=<id>` with `stackFileContent`, `env`,
`prune: true` and `pullImage: false` when the image was just built on that engine.
Older Portainer versions only have the legacy `POST /api/stacks?type=2&method=string`.

[`deploy/deploy.sh`](../deploy/README.md) automates all of it — including building the image
remotely through Portainer's Docker proxy — and keeps the API key out of the process list,
the logs and every generated file. Run `bash deploy/deploy.sh --dry-run` first: it renders
the artifacts without touching the network. `--image <ref>` skips the remote build and points
the stack at a registry image instead (`pullImage: true`).

[`deploy/host-prep.sh`](../deploy/README.md) is the optional companion for the one-off host
chores — nginx vhost snippets, proxy reload, leftover QA containers, dangling images — each
behind its own flag and all of them previewable with `--dry-run`.

## Images

* The **app image** is released multi-arch (`linux/amd64`, `linux/arm64`) to
  `ghcr.io/<owner>/porterclaude` on `v*` tags.
* **Recipe images** (`porterclaude/<recipe>:latest`) and the **tools volume** are built by
  the app itself, on the Docker host it manages, from Settings → Images. They are therefore
  always native-arch and never pulled from a registry.

### Disk: dangling images after a rebuild

Every rebuild re-tags `porterclaude/<name>:latest` and leaves the **previous** image untagged
(0.6–1.4 GB per recipe, ~1.2 GB per tools sync). The app removes the image a successful build
replaced, unless a container still uses it. To collect what is left — old images from before
that behaviour existed, or ones a stopped container was holding:

```bash
docker image prune -f --filter label=porterclaude.recipe          # recipe images
docker image prune -f --filter label=porterclaude.claude-version  # + the tools image
```

Without shell access to the host, `bash deploy/host-prep.sh --prune` does the same through
the Portainer API and only ever touches dangling images carrying a `porterclaude.*` label.
Run it with `--dry-run` first: it prints every image and its size.

## Volumes created on the managed host

| Volume | Mounted in sessions at | Purpose |
|---|---|---|
| `porterclaude-claude` | `/home/dev/.claude` | shared Claude login + settings |
| `porterclaude-claude-home` | `/home/dev/.claude-home` (symlinked `~/.claude.json`) | account/onboarding |
| `porterclaude-tools` (ro) | `/opt/porterclaude` | claude binary + entrypoint for custom images |
| `porterclaude-ws-<session>` | `/workspace` | per-session workspace when no host path is given |
| `porterclaude-hist-<session>` | `/home/dev/.claude/projects` | only when a session opts out of shared history |

## Architecture notes for operators

- Session containers are named `pc-<session>` and labelled `porterclaude.managed=true` and
  `porterclaude.session=<name>`; the app rebuilds its view from these labels, so losing
  `/data` costs you the settings, not the containers (`POST /api/sessions/reconcile`).
- Sessions share one Claude login through `porterclaude-claude`: log in once in any session.
- Backups: back up the `porterclaude-data` volume (settings + encrypted key) and any
  workspace volumes you care about.

---

# v0.2 — hosts and agents (TODO(O2): fold into the sections above)

> **PLANNER SKELETON.** O2 owns this file: work the points below into the existing sections
> (do not leave this block standing as an appendix). Sources of truth:
> `docs/design/orchestration.md` §11–§18, `docs/design/backend.md` §11–§16,
> `docs/design/api.md` §v0.2, and `docs/AGENTS.md` for the agent-facing half.

1. **Hosts.** PorterClaude now talks to *several* Docker engines. A host is
   `socket` (the engine the app runs on, at most one) or `portainer` (a stored credential +
   an endpoint id); `tcp`/`ssh` are reserved. Portainer credentials are stored once and
   "Import endpoints" creates one host per endpoint. Everything below — images, the tools
   volume, the agent auth volumes, sessions — is **per host**; nothing is shared between
   hosts, including logins.
2. **Env vars.** `PORTERCLAUDE_BACKEND`, `PORTAINER_URL`, `PORTAINER_API_KEY`,
   `PORTAINER_ENDPOINT_ID` and `DOCKER_SOCKET` now **seed the first host**, and only while no
   host exists. No new environment variable; the compose files are unchanged.
3. **Upgrade procedure (v0.1 → v0.2).** Pull the new image → the config is migrated in place
   (a `config.json.v1.bak` is written and the existing backend becomes the host `default`;
   every session gets `hostId: default`) → open **Settings → Images → Sync tools** for each
   host → the one-time import copies the old `porterclaude-claude` / `-claude-home` volumes
   into `porterclaude-auth-claude`, so **nobody has to log in again** → recreate sessions to
   pick up the new mounts. The old volumes are never deleted (rollback stays possible).
4. **Agents.** Recipes no longer contain Claude Code: every agent is installed into the
   per-host tools volume by the sync and mounted into every session. Point at
   [AGENTS.md](AGENTS.md).
5. **What a sync needs.** Outbound HTTPS **from the docker host** (nodejs.org,
   github.com/astral-sh, the agents' own installers), several minutes on the first run, and
   disk: the tools volume grows to roughly 100 MB (claude only) … 500 MB (with a Node runtime
   and a Python toolchain).
6. **Volumes on a managed host** — update the existing table:
   `porterclaude-tools` (per host, read-only in sessions), `porterclaude-auth-<agentId>`
   (one per agent per host, **holds the logins — back these up**),
   `porterclaude-ws-<session>`, `porterclaude-hist-<session>[-<agentId>]`. The v0.1
   `porterclaude-claude` / `porterclaude-claude-home` volumes stay behind after the import
   and can be removed once the upgrade is confirmed.
7. **Troubleshooting additions.** "no agents installed on this host" (sync never ran), a
   terminal closing with 4410 (`agent_not_available` — recreate the session) or 4411
   (`host_unavailable` — the engine is unreachable), and a host that shows as unreachable
   without affecting the other hosts.
