# Deploying PorterClaude

PorterClaude is one container. It needs:

- a **persistent** `/data` volume (config, encrypted secrets, session definitions)
- a way to reach Docker: at least one **host** — the local socket (mount
  `/var/run/docker.sock`) or a **Portainer** credential + endpoint, added in Settings
- an HTTPS reverse proxy in front of it that passes WebSockets (terminals)

Everything else — hosts, coding agents, images, sessions — is configured in the app. The
agent-facing half of the documentation (what an agent is, the built-ins, adding a custom one)
is [AGENTS.md](AGENTS.md).

> **`/data` is load-bearing.** It holds `secret.key`, which encrypts the stored Portainer
> API keys and signs session cookies. Losing the volume logs everyone out and makes the
> stored keys undecryptable — you then have to re-enter them in Settings. Set `APP_SECRET`
> explicitly if you prefer to manage the key yourself.

## Hosts

Since v0.2 PorterClaude manages **several Docker engines**. A *host* is a named connection:

| Connection | What it is | Notes |
|---|---|---|
| `socket` | the engine the app itself runs on | mount `/var/run/docker.sock` (+ `group_add`, below). **At most one socket host** per install |
| `portainer` | a stored Portainer credential + an endpoint id | the app anywhere, the engine anywhere Portainer can reach |
| `tcp`, `ssh` | reserved | accepted by the schema, every operation answers `501 not_implemented` |

A **credential** (`Settings → Hosts → Portainer credentials`) is a Portainer URL + API key,
stored once and encrypted with `secret.key`. Any number of hosts reference it, and
*Import endpoints* turns a credential's endpoint list into one host per endpoint in a single
step.

| | Socket host | Portainer host |
|---|---|---|
| Where the app runs | on the Docker host it manages | anywhere |
| Setup | mount `/var/run/docker.sock` (+ `group_add`) | paste URL + API key, pick the endpoint |
| Terminal stream | hijacked exec over the socket | `wss://<portainer>/api/websocket/exec` (API key OK) |
| Security note | app has root-equivalent access to that host | key scoped by Portainer RBAC |

**Nothing is shared between hosts.** Images, recipe builds, the tools volume, the agent auth
volumes (i.e. the logins), workspaces and sessions all belong to exactly one host. An agent
login on host A says nothing about host B; a recipe built on A must be built again on B.

Two caveats worth knowing before you add the second host:

* A host that is unreachable degrades **only itself**: it is listed with
  `status: unreachable`, its sessions show as absent, and every other host keeps working.
* Two hosts may point at the *same* engine (e.g. the local socket and a Portainer endpoint of
  the same machine). That is allowed, and they then share volumes and images by construction.
  If you want two genuinely independent installs on one engine, give one host
  `volumePrefix` / `containerPrefix` overrides (Settings → Hosts → *(host)* → Overrides).
* Deleting a host **never touches the engine** — containers, volumes and images stay; only
  PorterClaude forgets them. It refuses while sessions still reference the host unless you
  force it.

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
app starts fine but the socket host reports itself unavailable — that hint is *correct*, not
a bug. Portainer hosts need no socket at all.

## Environment variables

Complete list (server defaults in brackets):

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | listen port |
| `HOST` | `0.0.0.0` | listen address |
| `DATA_DIR` | `./data` (`/data` in the image) | config + secret key — must persist |
| `APP_PASSWORD` | – | first-run password seed for the web UI |
| `APP_SECRET` | auto (`<DATA_DIR>/secret.key`) | encryption + JWT key material |
| `PORTERCLAUDE_BACKEND` | – | `socket` or `portainer` — **seeds the first host** |
| `PORTAINER_URL` | – | Portainer base URL for the seeded host |
| `PORTAINER_API_KEY` | – | Portainer API key (stored encrypted as a credential, never returned by the API) |
| `PORTAINER_ENDPOINT_ID` | – | Portainer endpoint id for the seeded host |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | socket path of the seeded socket host |
| `LOG_LEVEL` | `info` | pino log level |
| `COOKIE_SECURE` | `auto` | `auto` (secure when the request is https, `X-Forwarded-Proto` aware) / `true` / `false` |
| `TRUST_PROXY` | `1` | Express `trust proxy` value — set it when behind a reverse proxy |
| `SESSION_TTL_DAYS` | `30` | login cookie lifetime |
| `PORTERCLAUDE_DOCKER_DIR` | `<repo>/docker` | recipe + tools build contexts |
| `WEB_DIR` | `<repo>/web/public` | static root |
| `ENABLE_REQUEST_LOG` | `true` | pino-http request logging on/off |

**The five Docker variables only seed the *first* host, and only while no host exists.** They
are an unattended-install convenience: once a host is stored in `config.json`, they are
ignored, and hosts two … N are added in Settings (or through `/api/hosts`). There is no
environment variable for a second host, for agents or for images — all of that is app
configuration.

### `DATA_DIR` and the repository checkout

`DATA_DIR` holds `secret.key` and `config.json` — the key that encrypts the Portainer API
keys, and the encrypted keys themselves. Treat that directory as secret material.

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
      - /var/run/docker.sock:/var/run/docker.sock    # only for a socket host
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
PorterClaude drives a Portainer host through Portainer's Docker proxy, and several of those
calls are long-running streams — `POST …/docker/build` (recipe images, the tools image, and
the app image when `deploy/deploy.sh` builds remotely), the tools-sync container's log
stream, and the container log/attach streams.

Measured on the reference host (Portainer behind nginx-proxy, defaults): the `/build`
response was buffered and only delivered when the build finished, and a build that ran
longer than 60 s got an HTML `504 Gateway Time-out` instead — at which point docker cancels
the build ("aborted"). Every recipe whose build takes more than a minute (`php`, `python`,
`go`, `dotnet`), every remote app-image build **and every tools sync** (which downloads
agents and runtimes and legitimately runs for minutes) are affected.

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
`deploy/deploy.sh`, building recipes or syncing tools from Settings → Images.**

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

## Upgrading from v0.1 to v0.2

v0.2 turns the single Docker backend into *hosts* and the hard-wired Claude Code into
*agents*. The upgrade is automatic but has two manual steps; plan for a few minutes of
downtime plus one tools sync per host.

1. **Back up `/data`** (or at least copy `config.json`), then pull the new image and restart
   the container. Nothing else changes in the compose file.
2. **The config migrates itself on first boot.** `config.json` v1 is copied to
   `config.json.v1.bak` before the first v2 write. The migration is lossless: the single
   backend becomes the host **`default`** (a Portainer backend additionally becomes the
   credential `portainer-1`, re-using the already-encrypted key), every session gets
   `hostId: "default"` and inherits the host's agents, and the general settings are carried
   over unchanged. If anything looks wrong, stop the container, restore the `.v1.bak` file
   and go back to the v0.1 image — nothing on the engine has been touched yet.
3. **Settings → Agents → Sync tools, once per host.** This is the step that installs the
   agents: recipe images no longer contain Claude Code, so until the sync has run, sessions
   come up with no agent on `PATH`. The same sync performs the **one-time login import**: the
   contents of the v0.1 `porterclaude-claude` and `porterclaude-claude-home` volumes are
   copied into `porterclaude-auth-claude` (marker file `.pc-import-v1`), so **nobody has to
   log in again**. The old volumes are never deleted or modified, which is what keeps a
   rollback to v0.1 possible; to re-run the import, delete the marker.
4. **Rebuild the recipe images you use** (Settings → Images). They are flagged *outdated*
   because the shared provisioning script changed. An un-rebuilt image still works — the
   tools volume shadows the stale `claude` binary on `PATH` — but it wastes ~100 MB and is
   confusing.
5. **Recreate your sessions.** The agent auth volumes, the tools mount and the entrypoint are
   part of the container spec, so existing containers keep the v0.1 layout until they are
   recreated. Sessions that need it say *needs recreate* in the Sessions tab. Workspace
   volumes are untouched by a recreate.
6. Optional: once everything is verified, remove the leftover v0.1 volumes
   `porterclaude-claude` and `porterclaude-claude-home` (and, if you never rolled back,
   `config.json.v1.bak`).

After the upgrade, `which claude` inside a session resolves to `/opt/porterclaude/bin/claude`
(the tools volume), not to `/usr/local/bin/claude` (the old baked-in copy).

## Images, the tools volume and agents

* The **app image** is released multi-arch (`linux/amd64`, `linux/arm64`) to
  `ghcr.io/<owner>/porterclaude` on `v*` tags.
* **Recipe images** (`porterclaude/<recipe>:latest`) are built by the app itself, per host,
  from Settings → Images. They are language-toolchain images only — since v0.2 they contain
  **no coding agent**.
* The **tools volume** (`porterclaude-tools`, one per host) carries the agents, their
  runtimes and the session entrypoint. Every session mounts it read-only at
  `/opt/porterclaude`, so this is the single place an agent is installed and upgraded.

**What a tools sync needs**, on the *Docker host*, not on the machine running the browser:

* **Outbound HTTPS**: the agents' installers, `registry.npmjs.org`, `nodejs.org`,
  `github.com/astral-sh`. An engine on an air-gapped network cannot install agents.
* **Time**: minutes on the first run (image build + downloads). Later syncs carry unchanged
  agents over and are fast. Do not shorten proxy timeouts for this — see the Portainer vhost
  section above.
* **An explicit upgrade** to move an installed agent to a newer upstream release: the
  carry-over compares the agent's definition, which does not change when a new CLI version
  ships. Settings → Agents → caret next to *Install / update on this host* → **Upgrade all
  agents** (API: `POST /api/hosts/:hostId/images/tools/sync {"force":true}`) reinstalls every
  enabled agent and the bundled runtimes, and costs what a first sync costs. Sessions pick the
  new version up when they are restarted.
* **Disk**: ~100 MB for `claude` alone; ~60 MB more for the bundled Node (npm agents), ~90 MB
  for the managed CPython and ~250 MB for aider's dependencies — roughly 500 MB with
  everything enabled.

A single agent that fails to install is a **warning**, not a failed sync: it is recorded in
`/opt/porterclaude/AGENTS.json` as `installed: false` plus a one-line error, which is what the
Agents and Images panels show. See [AGENTS.md](AGENTS.md) for the agent-side details.

**Alpine (musl) session images** need two extra things, because the tools volume is built
once per host and shared by every libc (measured, docs/design/requests/v2-O1.md 4):

* agents installed from npm need the GCC runtime libraries in the *session* image —
  `RUN apk add --no-cache libstdc++ libgcc`. Without them the shim dies with a loader error
  (the dispatcher prints that exact hint);
* agents installed from pip are **glibc-only** and refuse to start on musl with a clear
  message. Give those sessions a Debian/Ubuntu-based image.

### Disk: dangling images after a rebuild

Every rebuild re-tags `porterclaude/<name>:latest` and leaves the **previous** image untagged
(0.6–1.4 GB per recipe, ~0.2 GB per tools image). The app removes the image a successful
build replaced, unless a container still uses it. To collect what is left — old images from
before that behaviour existed, or ones a stopped container was holding:

```bash
docker image prune -f --filter label=porterclaude.recipe        # recipe images
docker image prune -f --filter label=porterclaude.context-hash  # recipes + the tools image
```

(Images built by v0.1 also carry `porterclaude.claude-version`; v0.2 no longer sets that
label anywhere.) Without shell access to the host, `bash deploy/host-prep.sh --prune` does
the same through the Portainer API and only ever touches dangling images carrying a
`porterclaude.*` label. Run it with `--dry-run` first: it prints every image and its size.

## Volumes created on a managed host

One set per host — the names are identical on every engine, the contents are not.

| Volume | Mounted in sessions at | Purpose | Back up? |
|---|---|---|---|
| `porterclaude-auth-<agentId>` | `/home/dev/.porterclaude/agents/<agentId>` | **the agent's login and settings**, shared by every session on that host | **yes** |
| `porterclaude-tools` (ro) | `/opt/porterclaude` | the installed agents, their runtimes and the session entrypoint | no — a sync rebuilds it |
| `porterclaude-ws-<session>` | `/workspace` | per-session workspace when no host path is given | yes, if you keep code in it |
| `porterclaude-hist-<session>[-<agentId>]` | inside the agent volume (e.g. `…/claude/projects`) | conversation history of a session that opted out of shared history | optional |
| `porterclaude-claude`, `porterclaude-claude-home` | – (v0.1 only) | the v0.1 shared Claude login; **read once** by the v0.2 import, then unused | removable after the upgrade |

The prefix is `general.volumePrefix` (default `porterclaude-`) and can be overridden per host.

The volume to protect is **`porterclaude-auth-<agentId>`**: it is the only copy of an agent's
authentication on that host. Losing it means logging in again, on every host it happened to.

## Architecture notes for operators

- Session containers are named `pc-<session>` and labelled `porterclaude.managed=true`,
  `porterclaude.session=<name>`, `porterclaude.host=<hostId>` and
  `porterclaude.agents=<id,id,…>`; the app rebuilds its view from these labels, so losing
  `/data` costs you the settings, not the containers (`POST /api/sessions/reconcile`).
- Session **names are unique across hosts** — that is what lets a terminal find its host.
- Every session (recipe *and* custom image) starts through `/opt/porterclaude/entrypoint.sh`
  from the tools volume; recipe images keep their own `CMD` (the `php` recipe still starts
  supervisord). The entrypoint wires `PATH`, symlinks each agent's config paths into its auth
  volume and repairs ownership — it never aborts the container.
- Backups: the `porterclaude-data` volume of the app (settings + encrypted keys), every
  `porterclaude-auth-*` volume on every host (the logins), and the workspace volumes you care
  about.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Settings reports the socket host as unavailable | missing `group_add` (see above), or no socket mounted at all |
| a host shows *unreachable* | that engine or its Portainer is down; other hosts and the UI keep working. Fix the connection, then *Refresh* |
| **"no agents installed on this host"** | the tools volume was never populated on it — Settings → Agents → **Sync tools** |
| a terminal closes with **4410** (`agent_not_available`) | the agent is not mounted into that session: enable it on the host, sync, and **recreate** the session. The client does not reconnect on purpose |
| a terminal closes with **4411** (`host_unavailable`) | the session's host is gone or unreachable |
| an agent asks for a login again after the upgrade | the tools sync (which performs the one-time v0.1 login import) has not run yet on that host, or the session predates it — sync, then recreate |
| a login on one host does not work on another | by design: auth volumes are per host |
| a tools sync fails after ~60 s on a Portainer host | the reverse proxy in front of Portainer is cutting the stream — install the vhost snippet above |
| a tools sync fails with download errors | the **Docker host** has no outbound HTTPS |
| a build job dies after ~60 s with `aborted` | same proxy cause as above |
| the container is `unhealthy` although the app answers | the image's `HEALTHCHECK` was overridden with `curl`/`wget`, neither of which exists in the runtime image |
