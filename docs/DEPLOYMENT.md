# Deploying PorterClaude

PorterClaude is one container. It needs:

- a persistent `/data` volume (config, encrypted secrets, session definitions)
- a way to reach Docker: **socket mode** (mount `/var/run/docker.sock`) or
  **Portainer mode** (URL + API key entered in Settings)
- an HTTPS reverse proxy in front of it that passes WebSockets (terminals)

## Modes

| | Socket mode | Portainer mode |
|---|---|---|
| Where the app runs | on the Docker host it manages | anywhere |
| Setup | mount `/var/run/docker.sock` | paste Portainer URL + API key in Settings |
| Terminal stream | hijacked exec over the socket | `wss://<portainer>/api/websocket/exec` (API key OK) |
| Multiple Docker hosts | no | yes — pick the endpoint in Settings |
| Security note | app has root-equivalent access to the host | key scoped by Portainer RBAC |

Both are chosen/changed in **Settings** at runtime. Env vars can pre-seed them for
unattended installs (`PORTERCLAUDE_BACKEND`, `PORTAINER_URL`, `PORTAINER_API_KEY`,
`PORTAINER_ENDPOINT_ID`).

## Environment variables

| Var | Required | Meaning |
|---|---|---|
| `APP_PASSWORD` | yes (first run) | login password for the web UI |
| `APP_SECRET` | no | key used to encrypt secrets in `/data`; auto-generated and persisted if absent |
| `PORT` | no | listen port (default 8080) |
| `PORTERCLAUDE_BACKEND` | no | `socket` or `portainer` seed |
| `PORTAINER_URL` / `PORTAINER_API_KEY` / `PORTAINER_ENDPOINT_ID` | no | seed for Portainer mode |

## Generic compose

```yaml
services:
  porterclaude:
    image: ghcr.io/<owner>/porterclaude:latest
    restart: unless-stopped
    volumes:
      - porterclaude-data:/data
      - /var/run/docker.sock:/var/run/docker.sock   # remove for Portainer-only mode
    environment:
      APP_PASSWORD: change-me
    ports:
      - "8080:8080"
volumes:
  porterclaude-data:
```

## Behind nginx-proxy + acme-companion

If your host uses `nginxproxy/nginx-proxy` + `nginxproxy/acme-companion`, drop the
`ports:` mapping and add the proxy env vars + networks instead:

```yaml
services:
  porterclaude:
    image: ghcr.io/<owner>/porterclaude:latest
    restart: unless-stopped
    environment:
      APP_PASSWORD: change-me
      VIRTUAL_HOST: claude.example.com
      LETSENCRYPT_HOST: claude.example.com
      VIRTUAL_PORT: 8080
    volumes:
      - porterclaude-data:/data
      - /var/run/docker.sock:/var/run/docker.sock
    networks: [proxy_net]        # the network nginx-proxy is attached to
networks:
  proxy_net:
    external: true
volumes:
  porterclaude-data:
```

nginx-proxy forwards `Upgrade`/`Connection` headers by default, so terminals work
without extra vhost config. Long-lived terminals: consider `proxy_read_timeout 3600s`
in `vhost.d/<host>` if idle terminals get cut.

## Deploying via Portainer Stacks (API)

```
POST /api/stacks/create/standalone/string?endpointId=<id>
X-API-Key: <key>
{ "name": "porterclaude", "stackFileContent": "<compose yaml>", "env": [] }
```
Update: `PUT /api/stacks/<stackId>?endpointId=<id>` with `stackFileContent`,
`pullImage: true`, `prune: true`. The `deploy/` folder has a script for this.

## Volumes created on the managed host

| Volume | Mounted in sessions at | Purpose |
|---|---|---|
| `porterclaude-claude` | `/home/dev/.claude` | shared Claude login + settings |
| `porterclaude-claude-home` | `/home/dev/.claude-home` (symlinked `~/.claude.json`) | account/onboarding |
| `porterclaude-tools` (ro) | `/opt/porterclaude` | claude binary + entrypoint for custom images |
| `porterclaude-ws-<session>` | `/workspace` | per-session workspace when no host path is given |

## Architecture notes for operators

- Session containers are labelled `porterclaude.managed=true` and `porterclaude.session=<name>`;
  the app rebuilds its view from these labels, so `/data` loss only loses settings.
- Multi-arch: the app image and all recipes build for `linux/amd64` and `linux/arm64`.
