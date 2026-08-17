# Deploying PorterClaude

PorterClaude is one container. It needs:

- a **persistent** `/data` volume (config, encrypted secrets, container definitions)
- a way to reach Docker: at least one **host** — the local socket (mount
  `/var/run/docker.sock`) or a **Portainer** credential + endpoint, added in Settings
- an HTTPS reverse proxy in front of it that passes WebSockets (sessions)

Everything else — hosts, coding agents, images, containers — is configured in the app. The
agent-facing half of the documentation (what an agent is, the built-ins, adding a custom one)
is [AGENTS.md](AGENTS.md).

> **`/data` is load-bearing.** It holds `secret.key`, which encrypts the stored Portainer
> API keys and signs login cookies. Losing the volume logs everyone out and makes the
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
| Session stream | hijacked exec over the socket | `wss://<portainer>/api/websocket/exec` (API key OK) |
| Security note | app has root-equivalent access to that host | key scoped by Portainer RBAC |

**Nothing is shared between hosts.** Images, recipe builds, the tools volume, the agent auth
volumes (i.e. the logins), workspaces and containers all belong to exactly one host. An agent
login on host A says nothing about host B; a recipe built on A must be built again on B.

Two caveats worth knowing before you add the second host:

* A host that is unreachable degrades **only itself**: it is listed with
  `status: unreachable`, its containers show as absent, and every other host keeps working.
* Two hosts may point at the *same* engine (e.g. the local socket and a Portainer endpoint of
  the same machine). That is allowed, and they then share volumes and images by construction.
  Two *separate PorterClaude installs* on one engine do not see each other's containers: every
  container carries a `porterclaude.instance=<id>` label (the id is generated once per install
  and stored in `config.json`), and container listing/reconcile only adopts containers with this
  install's id or with no id (pre-0.2.1 containers). Volumes are still shared by name, so give
  one install a different `volumePrefix` / `containerPrefix` (Settings → Hosts → *(host)* →
  Overrides) if you want fully independent state.
* Deleting a host **never touches the engine** — containers, volumes and images stay; only
  PorterClaude forgets them. It refuses while containers still reference the host unless you
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
      PORTERCLAUDE_BACKEND: socket                   # seeds the first host = the mounted socket
      TRUST_PROXY: "1"
    volumes:
      - porterclaude-data:/data                      # MUST persist
      - /var/run/docker.sock:/var/run/docker.sock    # only for a socket host
    group_add:
      - "999"                                        # stat -c %g /var/run/docker.sock
volumes:
  porterclaude-data:
```

`PORTERCLAUDE_BACKEND: socket` is what makes the app come up with the host *Local docker*
already created — without it (and without `PORTAINER_*`) the first start has **no host at
all** and the Hosts panel asks you to add one by hand. Drop it for a Portainer-only install,
or when you want to add every host in Settings yourself.

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
      PORTERCLAUDE_BACKEND: socket
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

* **WebSocket upgrade.** Sessions use `GET /api/sessions` with `Upgrade: websocket` (it was
  `/api/terminals` before v0.3); the proxy must forward the `Upgrade` and `Connection`
  headers. nginx-proxy does this by default; a hand-written vhost needs:

  ```nginx
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  ```

* **Idle timeouts.** A session that sits idle longer than `proxy_read_timeout` (nginx
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

## Upgrading to v0.3 (the rename)

v0.3 renames one word that meant three things. What was called a *session* is now a
**container** (the long-lived box), what was called a *terminal* is now a **session** (one
connection to a shell inside a container), and the login is just the login. No feature
changes; the upgrade is a pull and a restart. Four things an operator sees:

1. **Everyone is logged out once.** The cookie `pc_session` became `pc_auth`, so every open
   browser is asked for the password again after the upgrade. Nothing else about auth changed
   — `SESSION_TTL_DAYS` keeps its name and its value.
2. **`config.json` migrates itself.** `sessions[]` becomes `containers[]` and the version goes
   2 → 3; `config.json.v2.bak` is written before the first v3 write. A v1 file still upgrades
   in one boot (v1 → v2 → v3). **Back up `/data` first** — this rewrites the file that holds
   every container definition. If anything looks wrong, stop the container, **restore the
   `.v2.bak` file** and go back to the v0.2 image. Do not roll back the image without
   restoring it: a v0.2 server reads a v3 file "as-is", finds no `sessions[]` key, and reports
   **zero containers with no error at all** — the definitions are still in the file, but the
   old server cannot see them.
3. **Running containers are not touched.** They carry the old label `porterclaude.session`;
   the server writes `porterclaude.container` from now on and **reads either**, so nothing is
   orphaned. A container is relabelled on its next *recreate* — there is no need to force one.
   The env var inside the container stays `PORTERCLAUDE_SESSION` on purpose: it is part of the
   spec hash, so renaming it would flag every container as *needs recreate*.
4. **Old browser tabs lose their panes.** The websocket moved from
   `/api/terminals?session=&name=` to `/api/sessions?container=&session=`, and the REST
   resource from `/api/sessions` to `/api/containers`. A tab still running the pre-upgrade
   JavaScript talks to paths the new server does not serve — reload it. Make sure your proxy
   does not cache `/` or `/js/**` for long across the upgrade, and that its WebSocket rule
   matches `/api/sessions` if it was pinned to `/api/terminals` (see *Reverse-proxy
   requirements*).

## Upgrading from v0.1 to v0.2

v0.2 turns the single Docker backend into *hosts* and the hard-wired Claude Code into
*agents*. The upgrade is automatic but has two manual steps; plan for a few minutes of
downtime plus one tools sync per host.

1. **Back up `/data`** (or at least copy `config.json`), then pull the new image and restart
   the container. Nothing else changes in the compose file.
2. **The config migrates itself on first boot.** `config.json` v1 is copied to
   `config.json.v1.bak` before the first v2 write. The migration is lossless: the single
   backend becomes the host **`default`** (a Portainer backend additionally becomes the
   credential `portainer-1`, re-using the already-encrypted key), every container gets
   `hostId: "default"` and inherits the host's agents, and the general settings are carried
   over unchanged. If anything looks wrong, stop the container, restore the `.v1.bak` file
   and go back to the v0.1 image — nothing on the engine has been touched yet.
3. **Settings → Agents → Sync tools, once per host.** This is the step that installs the
   agents *and* the container bootstrap: every v0.2 container mounts the tools volume read-only
   and runs `/opt/porterclaude/entrypoint.sh` from it, so on a host whose tools volume has
   never been synced a container cannot start at all — docker creates the empty volume, the
   entrypoint is missing and the container restarts forever. PorterClaude therefore refuses to
   create a container on such a host (`409`, "run the tools sync for this host first") instead
   of handing you a crash-looping container; existing containers say so in their warnings,
   and a restart after the sync brings them up. The same sync performs the
   **one-time login import**: the
   contents of the v0.1 `porterclaude-claude` and `porterclaude-claude-home` volumes are
   copied into `porterclaude-auth-claude` (marker file `.pc-import-v1`), so **nobody has to
   log in again**. The old volumes are never deleted or modified, which is what keeps a
   rollback to v0.1 possible; to re-run the import, delete the marker.
4. **Rebuild the recipe images you use** (Settings → Images). They are flagged *outdated*
   because the shared provisioning script changed. An un-rebuilt image still works — the
   tools volume shadows the stale `claude` binary on `PATH` — but it wastes ~100 MB and is
   confusing.
5. **Recreate your containers.** The agent auth volumes, the tools mount and the entrypoint are
   part of the container spec, so existing containers keep the v0.1 layout until they are
   recreated. Containers that need it say *needs recreate* in the Containers tab. Workspace
   volumes are untouched by a recreate.
6. Optional: once everything is verified, remove the leftover v0.1 volumes
   `porterclaude-claude` and `porterclaude-claude-home` (and, if you never rolled back,
   `config.json.v1.bak`).

After the upgrade, `which claude` inside a container resolves to `/opt/porterclaude/bin/claude`
(the tools volume), not to `/usr/local/bin/claude` (the old baked-in copy).

## Images, the tools volume and agents

* The **app image** is released multi-arch (`linux/amd64`, `linux/arm64`) to
  `ghcr.io/<owner>/porterclaude` on `v*` tags.
* **Recipe images** (`porterclaude/<recipe>:latest`) are built by the app itself, per host,
  from Settings → Images. They are language-toolchain images only — since v0.2 they contain
  **no coding agent**.
* The **tools volume** (`porterclaude-tools`, one per host) carries the agents, their
  runtimes and the container entrypoint. Every container mounts it read-only at
  `/opt/porterclaude`, so this is the single place an agent is installed and upgraded.

**What a tools sync needs**, on the *Docker host*, not on the machine running the browser:

* **Outbound HTTPS**: the agents' installers, `registry.npmjs.org`, `nodejs.org`,
  `github.com/astral-sh`. An engine on an air-gapped network cannot install agents.
* **Time**: minutes on the first run (image build + downloads). Later syncs carry unchanged
  agents over and are fast. Do not shorten proxy timeouts for this — see the Portainer vhost
  section above.
* **An explicit upgrade** to move an installed agent to a newer upstream release: the
  carry-over compares the agent's definition, which does not change when a new CLI version
  ships. Settings → Agents → caret next to *Sync tools* → **Upgrade all
  agents** (API: `POST /api/hosts/:hostId/images/tools/sync {"force":true}`) reinstalls every
  enabled agent and the bundled runtimes, and costs what a first sync costs. Containers pick the
  new version up when they are restarted.
* **Disk**: ~100 MB for `claude` alone; ~60 MB more for the bundled Node (npm agents), ~90 MB
  for the managed CPython and ~250 MB for aider's dependencies — roughly 500 MB with
  everything enabled.

A single agent that fails to install is a **warning**, not a failed sync: it is recorded in
`/opt/porterclaude/AGENTS.json` as `installed: false` plus a one-line error, which is what the
Agents and Images panels show. See [AGENTS.md](AGENTS.md) for the agent-side details.

**Alpine (musl) container images** need two extra things, because the tools volume is built
once per host and shared by every libc (measured, docs/design/requests/v2-O1.md 4):

* agents installed from npm need the GCC runtime libraries in the *container* image —
  `RUN apk add --no-cache libstdc++ libgcc`. Without them the shim dies with a loader error
  (the dispatcher prints that exact hint);
* agents installed from pip are **glibc-only** and refuse to start on musl with a clear
  message. Give those containers a Debian/Ubuntu-based image.

### Disk: dangling images after a rebuild

Every rebuild re-tags `porterclaude/<name>:latest` and leaves the **previous** image untagged
(0.6–1.4 GB per recipe, ~0.2 GB per tools image). The app removes the image a successful
build replaced, unless a container still uses it. To collect what is left — old images from
before that behaviour existed, or ones a stopped container was holding:

```bash
docker image prune -f --filter label=porterclaude.recipe        # recipe images
docker image prune -f --filter label=porterclaude.context-hash  # recipes + the tools image
docker image prune -f --filter label=porterclaude.image=app     # app-image builds (deploy.sh)
```

(Images built by v0.1 also carry `porterclaude.claude-version`; v0.2 no longer sets that
label anywhere.) Without shell access to the host, `bash deploy/host-prep.sh --prune` does
the same through the Portainer API and only ever touches dangling images carrying a
`porterclaude.*` label. Run it with `--dry-run` first: it prints every image and its size.

**`deploy/deploy.sh` leaves leftovers too.** Every remote build of the app image replaces the
previous `deps`/`build` stage images and the previously tagged app image, so each deploy
leaves roughly 0.4 GB + 0.3 GB dangling on the build host — a few deploys are a couple of GB.
Since v0.2 all three stages of `docker/Dockerfile` carry `porterclaude.image=app`, so the
commands above (and `host-prep.sh --prune`) collect them. Images built by an **older**
`docker/Dockerfile` have no label at all: those need a plain `docker image prune -f` on the
host once, or removal by id in Portainer.

## Volumes created on a managed host

One set per host — the names are identical on every engine, the contents are not.

| Volume | Mounted in containers at | Purpose | Back up? |
|---|---|---|---|
| `porterclaude-auth-<agentId>` | `/home/dev/.porterclaude/agents/<agentId>` | **the agent's login and settings**, shared by every container on that host | **yes** |
| `porterclaude-tools` (ro) | `/opt/porterclaude` | the installed agents, their runtimes and the container entrypoint | no — a sync rebuilds it |
| `porterclaude-ws-<container>` | `/workspace` | per-container workspace when no host path is given | yes, if you keep code in it |
| `porterclaude-hist-<container>[-<agentId>]` | inside the agent volume (e.g. `…/claude/projects`) | conversation history of a container that opted out of shared history | optional |
| `porterclaude-claude`, `porterclaude-claude-home` | – (v0.1 only) | the v0.1 shared Claude login; **read once** by the v0.2 import, then unused | removable after the upgrade |

The prefix is `general.volumePrefix` (default `porterclaude-`) and can be overridden per host.

**When they appear.** A *tools sync* only builds `porterclaude-tools`. The per-agent auth
volumes are created with the **first container that mounts them**, so after enabling `opencode`
and syncing you will see `porterclaude-auth-claude` but no `porterclaude-auth-opencode` until
a container is created (or recreated) with that agent — an empty volume list right after a sync
is expected, not a failed sync.

The volume to protect is **`porterclaude-auth-<agentId>`**: it is the only copy of an agent's
authentication on that host. Losing it means logging in again, on every host it happened to.

## Architecture notes for operators

- Containers are named `pc-<container>` and labelled `porterclaude.managed=true`,
  `porterclaude.container=<name>`, `porterclaude.host=<hostId>` and
  `porterclaude.agents=<id,id,…>`; the app rebuilds its view from these labels, so losing
  `/data` costs you the settings, not the containers (`POST /api/containers/reconcile`).
  Containers created before v0.3 carry `porterclaude.session=<name>` instead; the server reads
  both and writes only the new one, so they are discovered and adopted exactly as before and
  pick up the new label on their next recreate.
- Container **names are unique across hosts** — that is what lets a session find its host.
- Every container (recipe *and* custom image) starts through `/opt/porterclaude/entrypoint.sh`
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
| a session closes with **4410** (`agent_not_available`) | the agent is not mounted into that container: enable it on the host, sync, and **recreate** the container. The client does not reconnect on purpose |
| a session closes with **4411** (`host_unavailable`) | the container's host is gone or unreachable |
| an agent asks for a login again after the upgrade | the tools sync (which performs the one-time v0.1 login import) has not run yet on that host, or the container predates it — sync, then recreate |
| a login on one host does not work on another | by design: auth volumes are per host |
| a tools sync fails after ~60 s on a Portainer host | the reverse proxy in front of Portainer is cutting the stream — install the vhost snippet above |
| a tools sync fails with download errors | the **Docker host** has no outbound HTTPS |
| a build job dies after ~60 s with `aborted` | same proxy cause as above |
| the container is `unhealthy` although the app answers | the image's `HEALTHCHECK` was overridden with `curl`/`wget`, neither of which exists in the runtime image |
