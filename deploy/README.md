# deploy/ — reference instance

Operator-specific deployment of PorterClaude: build the app image **on the remote Docker
engine through Portainer** and create/update the Portainer stack that runs it. Nothing here
needs a local Docker CLI.

Secrets live in `deploy/.env` (gitignored); [`.env.example`](.env.example) documents every
key with placeholders. **Never commit a real Portainer API key.**

```
deploy/
  deploy.sh              build + stack create/update + health poll
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
| `--tag <ref>` | override `APP_IMAGE` (default `porterclaude:local`) |
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
5. renders `deploy/docker-compose.yml` into `deploy/.build/stack.yml`;
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

## Reference host facts (2026-08-15)

| | |
|---|---|
| Portainer | EE 2.39.5, endpoint `2` ("local", docker.sock) |
| Docker host | Ubuntu 24.04, **arm64**, 4 CPU, 23 GiB, Docker 29.1.3 |
| Reverse proxy | `nginxproxy/nginx-proxy` + `acme-companion` (DEFAULT_EMAIL set), ports 80/443 |
| Proxy convention | `VIRTUAL_HOST`, `LETSENCRYPT_HOST`, `VIRTUAL_PORT`; networks `portainer_dmz` (internal) + `portainer_gate` |
| App hostname | `claude.example.com` (DNS ready) |
| Existing stacks | (redacted) |

### Operator action required before the first remote build

Portainer on this host sits **behind the same nginx-proxy**, with its defaults. Measured
there: the `POST …/docker/build` response is buffered until the build finishes, and a build
that runs longer than 60 s gets an HTML `504 Gateway Time-out` — docker then cancels
("aborts") the build. That kills `deploy.sh`'s remote build of the app image (`npm ci` +
`tsc`, several minutes) and every recipe build over a minute (`php`, `python`, `go`,
`dotnet`) started from Settings → Images.

Fix it once on the proxy, in `vhost.d/<portainer-host>`:

```nginx
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;
proxy_request_buffering off;
client_max_body_size 0;
```

Then reload nginx-proxy. `deploy.sh` detects the failure mode (it dies with "the build
request never reached the engine (HTTP 504 …)") but it cannot work around it.

Because the host is arm64, the app image is built **natively there** by `deploy.sh` — no
buildx, no emulation. (CI releases a multi-arch image to ghcr.io separately; recipe images
are always built on the target host by the app.)

The stack runs in socket mode and the app is a non-root uid (10001), so it needs the docker
socket's group:

```bash
stat -c %g /var/run/docker.sock     # on the docker host -> put it in DOCKER_GID
```

`porterclaude-data` must persist: it holds `secret.key`, which encrypts the stored Portainer
key and signs session cookies.

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
| `the build request never reached the engine (HTTP 504 …)` | the reverse proxy in front of Portainer closed the upload before the build finished. Nothing was built and **nothing was deployed** — raise `proxy_read_timeout`/`proxy_send_timeout` for `/api/endpoints/*/docker/build` (or hit Portainer directly), then rerun |
| `the build endpoint did not return Docker JSON output` | the response was an HTML/plain-text error page (proxy, WAF, wrong `PORTAINER_URL` path) rather than Docker's JSON lines |
| `the build stream ended without a success marker` | the connection dropped mid-build, so the image is incomplete; the run stops instead of redeploying the previous image |
| `health check timed out` | check the container logs for the stack in Portainer; the proxy also needs `Upgrade`/`Connection` forwarding for terminals |
