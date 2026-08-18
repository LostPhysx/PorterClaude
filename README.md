# PorterClaude

Launch dev containers on your Docker hosts and work in them from the browser — tabbed,
multi-pane terminals, with the **coding agent of your choice** installed and logged in once
per host.

- **Code** — terminal workspace (tabs, drag-to-split panes, reconnect-safe via tmux); every
  pane is a shell or a coding agent
- **Containers** — create / edit / destroy dev containers on any host, from curated recipes
  (node, dotnet, php-fpm+nginx, python, go, base) or any custom image; **Files** browses each
  running container's `/workspace` and moves files in and out of it (drag-and-drop upload,
  directories download as `.tar.gz`)
- **Settings** — **hosts** (local Docker socket and/or Portainer endpoints), **agents**
  (five built in, plus your own), images and account; everything is configured in the app,
  nothing hard-coded

Status: **v0.3.1** — multiple hosts, pluggable coding agents and workspace file transfer. A
**container** is the long-lived box, a **session** is one connection to a shell inside it.
Release notes:
[CHANGELOG.md](CHANGELOG.md). Agent guide: [docs/AGENTS.md](docs/AGENTS.md). See also
[PLAN.md](PLAN.md), [docs/](docs/) and [docs/design/](docs/design/).

## Quick start

```yaml
# docker-compose.yml
services:
  porterclaude:
    image: ghcr.io/lostphysx/porterclaude:latest
    restart: unless-stopped
    init: true
    ports: ["8080:8080"]
    environment:
      APP_PASSWORD: change-me
      PORTERCLAUDE_BACKEND: socket                   # seeds the first host = this docker socket
    volumes:
      - porterclaude-data:/data                      # must persist (secrets + config)
      - /var/run/docker.sock:/var/run/docker.sock    # only for a local-socket host
    group_add: ["999"]                               # stat -c %g /var/run/docker.sock
volumes:
  porterclaude-data:
```

1. Open `http://localhost:8080` and log in with `APP_PASSWORD`.
2. **Settings → Hosts**: `PORTERCLAUDE_BACKEND: socket` has already created the host
   *Local docker* for the mounted socket — check that it is reachable. Drop that variable and
   the app starts with no host at all; you then add one here: the local Docker socket, or a
   Portainer credential (URL + API key) whose endpoints you import. The seed only applies
   while `/data` holds no host — after that the app is the source of truth.
3. **Settings → Agents**: pick the agents this host should have. **Sync tools** installs them
   (minutes on the first run, outbound HTTPS from the Docker host) — or just create a
   container and let it run: an unsynced host and an unbuilt recipe image are prepared
   automatically, with the progress on the container row.
4. Create a container, open a session, run your agent and log in once — every other container
   on that host is now authenticated too.

The app runs as a non-root uid (10001), hence `group_add` for the socket; Portainer hosts
need no socket. Full operator documentation: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
(upgrading from v0.1 included).

## Repo

| Path | What |
|---|---|
| `server/` | Node 22 + TypeScript API: **Express 5** + `ws`, WebSocket session bridge, host manager (Portainer via fetch / socket via dockerode), agent registry, config store |
| `web/` | Static UI, **no bundler**: Bootstrap 5 + jQuery, native ES modules, GoldenLayout 2 panes, xterm.js 5 terminals (vendor assets served from `node_modules`) |
| `docker/` | `Dockerfile` for the app image, `recipes/` for the dev images, `tools/` for the agent delivery (installs the enabled agents into a host's tools volume, plus the container entrypoint) |
| `deploy/` | reference deployment: `deploy.sh` builds the image through Portainer and creates/updates the stack (secrets gitignored) |
| `.github/workflows/` | CI (typecheck, lint, test, shell/python, agent-installer contract, compose, image build) and multi-arch release to ghcr.io |
| `docs/` | [DEPLOYMENT.md](docs/DEPLOYMENT.md), [AGENTS.md](docs/AGENTS.md) + the design docs the implementation follows |
| `CHANGELOG.md` | release notes per tag |

Stack note: [PLAN.md](PLAN.md) sketched Fastify, React/Vite and dockview. The implementation
deliberately uses **Express 5 + `ws`** and a **bundler-free** Bootstrap/jQuery/GoldenLayout
front end instead — `docs/design/*.md` is authoritative wherever the two disagree.

## Development

```bash
npm install                 # npm workspaces: server + web
npm run dev                 # server on :8080, serves web/public
npm run typecheck && npm run lint && npm test
bash deploy/deploy.sh --dry-run     # render the deployment artifacts, no network
```

License: MIT — see [LICENSE](LICENSE).
