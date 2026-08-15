# deploy/ — reference instance

Operator-specific deployment of PorterClaude. Secrets live in `deploy/.env` (gitignored);
`deploy/.env.example` documents the keys.

Discovered target facts (2026-08-15):

| | |
|---|---|
| Portainer | EE 2.39.5, endpoint `2` ("local", docker.sock) |
| Docker host | Ubuntu 24.04, **arm64**, 4 CPU, 23 GiB, Docker 29.1.3 |
| Reverse proxy | `nginxproxy/nginx-proxy` + `acme-companion` (DEFAULT_EMAIL set), ports 80/443 |
| Proxy convention | `VIRTUAL_HOST`, `LETSENCRYPT_HOST`, `VIRTUAL_PORT`; networks `portainer_dmz` (internal) + `portainer_gate` |
| App hostname | `claude.example.com` (DNS ready) |
| Existing stacks | (redacted) |

Because arm64: the app image and recipes must be built for `linux/arm64` (build on the
host via the Docker API, or multi-arch in CI).

`deploy.sh` (to be written in milestone 5): renders `docker-compose.yml` with `.env`,
creates or updates the Portainer stack `${STACK_NAME}` via
`/api/stacks/create/standalone/string` / `PUT /api/stacks/{id}`.
