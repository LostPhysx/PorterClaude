# deploy/ — reference instance

Operator-specific deployment of PorterClaude: build the app image **on the remote Docker
engine through Portainer** and create/update the Portainer stack that runs it. Nothing here
needs a local Docker CLI.

Secrets live in `deploy/.env` (gitignored); [`.env.example`](.env.example) documents every
key with placeholders. **Never commit a real Portainer API key.**

**Scope.** Everything in this directory is about *shipping the app container*. The docker
hosts PorterClaude manages, the coding agents installed on each of them and the container
images are configured **inside the app** — see [../docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md)
and [../docs/AGENTS.md](../docs/AGENTS.md). The rendered stack sets
`PORTERCLAUDE_BACKEND=socket`, which seeds the *first* host as the engine the app runs on and
is ignored once `/data` holds a host; further hosts are added in Settings → Hosts.

```
deploy/
  deploy.sh              build + stack create/update + health poll
  host-prep.sh           OPTIONAL one-off host chores (vhost, reload, cleanup), all opt-in
  lib/common.sh          shared plumbing: secure tmpdir, curl config, API helpers
  lib/dockerignore.py    .dockerignore-aware file lister (feeds the context tar)
  lib/render_compose.py  ${VAR} / ${VAR:-default} substitution with a secret keep-list
  lib/portainer.py       JSON helpers: build-stream printer, stack lookup, request bodies
  docker-compose.yml     the reference stack (nginx-proxy + acme-companion, socket mode)
  .build/                generated artifacts (gitignored): context.tar, stack.yml
```

## Usage

```bash
cp deploy/.env.example deploy/.env      # then fill in the real values
bash deploy/deploy.sh --dry-run         # no network: tar the context + render the stack file
bash deploy/deploy.sh                   # build, create/update the stack, wait for health
```

| Flag | Effect |
|---|---|
| `--dry-run` | steps 1/3/5 only (env, context tar, rendered stack file). **No network at all** — this is what CI and the Windows dev box run |
| `--build-only` | build the image on the remote engine, do not touch the stack |
| `--deploy-only` | skip the build, only create/update the stack |
| `--no-wait` | skip the health poll |
| `--tag <ref>` | override `APP_IMAGE` for the remote build (default `porterclaude:local`) |
| `--image <ref>` | **no remote build**: deploy an already-built or pullable image (`pullImage: true` on the stack update). The way around a reverse proxy that cuts long `/docker/build` requests |
| `--env-file <p>` | use another env file (default `deploy/.env`) |
| `-h`, `--help` | usage |

What a full run does:

1. loads `deploy/.env` (CR-stripped, so a CRLF file from Windows is fine) and requires
   `PORTAINER_URL`, `PORTAINER_ENDPOINT_ID`, `PORTAINER_API_KEY`, `APP_HOSTNAME`,
   `APP_PASSWORD`, `STACK_NAME`;
2. preflight: `GET /api/endpoints/<id>/docker/_ping` must answer `200`;
3. tars the build context — the file list comes from `lib/dockerignore.py`, so it matches
   what Docker itself would send — and asserts the tar contains `docker/Dockerfile` and
   **no** `deploy/.env*`;
4. `POST …/docker/build?t=$APP_IMAGE&dockerfile=docker/Dockerfile&rm=1&forcerm=1&pull=1`
   with the tar; the JSON-lines response is streamed through `lib/portainer.py build-stream`.
   A build only counts as successful when **both** channels agree: the HTTP status (captured
   with `curl --dump-header`) is 2xx **and** the stream reported a finished image
   (`Successfully built` / an `aux` image id). `error`/`errorDetail` entries, a Portainer
   error object (`{"message": …}`), a proxy error page (nginx 502/504), an empty body and a
   stream cut short all abort the run, so a failed build can never be followed by a stack
   update that silently redeploys the *previous* image;
5. resolves `DOCKER_GID` — from `deploy/.env`, or by asking the engine: a throwaway
   `alpine` container that bind-mounts `/var/run/docker.sock` **read-only**, prints
   `stat -c %g` and is removed again (it is labelled `porterclaude.managed=true`, runs with
   `NetworkMode: none`, and a failure only warns: the compose default `999` takes over) —
   then renders `deploy/docker-compose.yml` into `deploy/.build/stack.yml`;
6. `GET /api/stacks` → create (`POST /api/stacks/create/standalone/string?endpointId=…`,
   falling back to the legacy `POST /api/stacks?type=2&method=string&endpointId=…` on
   404/405) or update (`PUT /api/stacks/<id>?endpointId=…` with `prune:true`,
   `pullImage:false` — the image was just built on that engine);
7. polls `HEALTH_URL` (default `https://$APP_HOSTNAME/api/health`) every 5 s until
   `"status":"ok"` or `HEALTH_TIMEOUT` (default 180 s).

## Secret handling

* The API key is **never** an argument, never echoed, never written to `deploy/.build/`.
  It goes into a `chmod 600` curl config file (`header = "X-API-Key: …"`) inside a
  `mktemp -d` directory that an `EXIT` trap removes. Request/response bodies (which contain
  `APP_PASSWORD`) live in the same directory.
* `APP_PASSWORD` stays **literal** in `stack.yml` (`--keep`) and is handed to Portainer in
  the stack `env` array, so the password is stored once, by Portainer.
* `deploy.sh` never runs `set -x`.

## The setup this was developed against

Not a requirement — the shape of a typical target, so the notes below have context. Your own
values go in `deploy/.env`, which is gitignored.

| | |
|---|---|
| Portainer | EE 2.x, a `local` (docker.sock) endpoint |
| Docker host | Ubuntu 24.04, **arm64**, 4 CPU, 23 GiB, Docker 29.x |
| `/var/run/docker.sock` gid | often **not** the 999 the compose file defaults to — measure it (`stat -c %g /var/run/docker.sock`) and set `DOCKER_GID` |
| Reverse proxy | `nginxproxy/nginx-proxy` + `acme-companion` on 80/443, with `vhost.d` bind-mounted from the host (`NGINX_VHOST_DIR`, default `/srv/nginx/vhost.d`) |
| Proxy convention | `VIRTUAL_HOST`, `LETSENCRYPT_HOST`, `VIRTUAL_PORT`; an internal network plus an edge one (`PROXY_NETWORK_APP` / `PROXY_NETWORK_EDGE`) |
| App hostname | whatever `APP_HOSTNAME` says, with DNS already pointing at the host |

### Operator action required before the first remote build

Portainer on this host sits **behind the same nginx-proxy**, with its defaults. Measured
there: the `POST …/docker/build` response is buffered until the build finishes, and a build
that runs longer than 60 s gets an HTML `504 Gateway Time-out` — docker then cancels
("aborts") the build. That kills `deploy.sh`'s remote build of the app image (`npm ci` +
`tsc`, several minutes), every recipe build over a minute (`php`, `python`, `go`, `dotnet`)
started from Settings → Images, and every **tools sync** (which downloads the host's coding
agents and their runtimes and runs for minutes on the first go).

Fix it once on the proxy, in `vhost.d/<portainer-host>`:

```nginx
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;
proxy_request_buffering off;
client_max_body_size 0;
```

Then reload nginx-proxy. `deploy.sh` recognises the failure mode — a proxy status, an HTML
body, or a failure landing suspiciously close to the 60 s default — and prints that snippet
instead of a bare status code, but it cannot work around it. Two ways out:

```bash
bash deploy/host-prep.sh --dry-run --vhost --reload   # preview
bash deploy/host-prep.sh --vhost --reload             # write both vhost files + SIGHUP
bash deploy/deploy.sh --image ghcr.io/lostphysx/porterclaude:latest   # or skip the build
```

Still true as of 2026-08-16: a stream through this Portainer is cut after **60.1 s** with an
HTML `504`, so this is a prerequisite for the first real deploy.

## host-prep.sh

Optional, never called by `deploy.sh`, and every step is opt-in — nothing happens without an
action flag, and `--dry-run` prints exactly what each one would do.

| Flag | Effect |
|---|---|
| `--clean` | remove containers labelled `porterclaude.managed=true` **and** named `pc-qa-*` / `pc-o1-*` (override with `HOST_PREP_PREFIXES`), together with their `porterclaude-ws-*` / `porterclaude-hist-*` volumes — the named volumes are read off the container *before* it is deleted, because `?v=1` only drops anonymous ones. The per-agent `porterclaude-auth-*` volumes (the logins) are never touched |
| `--prune` | remove **dangling** images that carry a `porterclaude.*` label (a rebuild leaves 0.6–1.4 GB behind each time); `409 Conflict` = still referenced, kept |
| `--vhost` | write `vhost.d/<portainer-host>` (long build + tools-sync streams) and `vhost.d/<app-host>` (idle session WebSockets). The host directory is read from the nginx-proxy container's own mount of `/etc/nginx/vhost.d`, falling back to `NGINX_VHOST_DIR` / `/srv/nginx/vhost.d`; the files are written by a throwaway `alpine` container with that directory bind-mounted |
| `--reload` | `SIGHUP` the nginx-proxy container so it reloads |
| `--all` | all four, in that order |
| `--dry-run` | change nothing; print every action, the vhost file contents, and a final count |

```bash
bash deploy/host-prep.sh --dry-run --clean --prune --vhost --reload
```

It uses the same secret handling as `deploy.sh` (`lib/common.sh`): the API key only ever
exists in a `chmod 600` curl config inside a `mktemp -d` directory.

Because the host is arm64, the app image is built **natively there** by `deploy.sh` — no
buildx, no emulation. (CI releases a multi-arch image to ghcr.io separately; recipe images
are always built on the target host by the app.)

The stack runs in socket mode and the app is a non-root uid (10001), so it needs the docker
socket's group:

```bash
stat -c %g /var/run/docker.sock     # on the docker host -> put it in DOCKER_GID
```

`DOCKER_GID` is optional: when it is missing from `deploy/.env`, `deploy.sh` probes the
engine for it (step 5 above) and only falls back to the compose default `999` when the probe
fails — a `--dry-run` always renders that fallback, because it makes no network calls.

The two external networks the stack attaches to come from `PROXY_NETWORK_APP` (shared with
nginx-proxy) and `PROXY_NETWORK_EDGE`, defaulting to `portainer_dmz` / `portainer_gate`.
A v0.1 env file that still carries the single `PROXY_NETWORKS=<app>,<edge>` keeps working:
`deploy.sh` splits it into those two names when they are not set explicitly (first entry =
app, second = edge) and logs the mapping, instead of ignoring the variable silently.

`porterclaude-data` must persist: it holds `secret.key`, which encrypts the stored Portainer
keys and signs login cookies. The **agent logins** are not in it — they live on each
managed docker host in the per-agent volumes `porterclaude-auth-<agentId>`
([../docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md#volumes-created-on-a-managed-host)).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `missing in deploy/.env: APP_PASSWORD` | required keys are empty — fill them in |
| `cannot reach … (HTTP 000)` | wrong `PORTAINER_URL`, DNS, or TLS interception |
| `portainer rejected the API key (HTTP 401/403)` | key expired or lacks endpoint access |
| `SECURITY: deploy/.env leaked into the build context` | `.dockerignore` lost its `deploy/.env*` rule — fix before deploying |
| `SECURITY: a secret.key leaked into the build context` | a `DATA_DIR` lives inside the checkout under a name `.dockerignore`'s `data*` rule does not cover — rename it to `data…` or move it out of the repo. It holds `secret.key` + the encrypted Portainer key |
| `SECURITY: a DATA_DIR config.json leaked into the build context` | same cause as above |
| build error lines then a non-zero exit | the remote build failed; the printed lines are Docker's own output |
| `the build never reached the engine (proxy timeout)` | the reverse proxy in front of Portainer closed the request before the build finished. Nothing was built and **nothing was deployed**; the printed snippet is the fix (`host-prep.sh --vhost --reload`), or use `--image <ref>` |
| `could not detect the docker socket gid` | the probe container could not run; put `DOCKER_GID` (from `stat -c %g /var/run/docker.sock`) into `deploy/.env`. Symptom of getting it wrong: the app starts, but Settings reports the socket as unavailable |
| `the build endpoint did not return Docker JSON output` | the response was an HTML/plain-text error page (proxy, WAF, wrong `PORTAINER_URL` path) rather than Docker's JSON lines |
| `the build stream ended without a success marker` | the connection dropped mid-build, so the image is incomplete; the run stops instead of redeploying the previous image |
| `health check timed out` | check the container logs for the stack in Portainer; the proxy also needs `Upgrade`/`Connection` forwarding for the session WebSocket |
