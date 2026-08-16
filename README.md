# PorterClaude

Launch **Claude Code** dev containers on your Docker host and work in them from the
browser — tabbed, multi-pane terminals, one shared Claude login for every container.

- **Code** — terminal workspace (tabs, drag-to-split panes, reconnect-safe via tmux)
- **Sessions** — create / edit / destroy dev containers from curated recipes
  (node, dotnet, php-fpm+nginx, python, go, base) or any custom image
- **Settings** — point it at a **Portainer** endpoint (URL + API key) or the local
  **Docker socket**; everything is configured in the app, nothing hard-coded

Status: in development. See [PLAN.md](PLAN.md), [docs/](docs/) and
[docs/design/](docs/design/).

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
    volumes:
      - porterclaude-data:/data                      # must persist (secrets + config)
      - /var/run/docker.sock:/var/run/docker.sock    # socket mode only
    group_add: ["999"]                               # stat -c %g /var/run/docker.sock
volumes:
  porterclaude-data:
```

Open `http://localhost:8080`, log in with `APP_PASSWORD`, go to **Settings** and either
accept the auto-detected Docker socket or enter your Portainer URL + API key.
Create a session, open a terminal, run `claude`, log in once — every other session is
now authenticated too.

The app runs as a non-root uid (10001), hence `group_add` in socket mode; Portainer mode
needs no socket. Full operator documentation: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Repo

| Path | What |
|---|---|
| `server/` | Node 22 + TypeScript API: **Express 5** + `ws`, WebSocket terminal bridge, Docker backends (Portainer via fetch / socket via dockerode), config store |
| `web/` | Static UI, **no bundler**: Bootstrap 5 + jQuery, native ES modules, GoldenLayout 2 panes, xterm.js 5 terminals (vendor assets served from `node_modules`) |
| `docker/` | `Dockerfile` for the app image, `recipes/` for the dev images, `tools/` for the custom-image bootstrap |
| `deploy/` | reference deployment: `deploy.sh` builds the image through Portainer and creates/updates the stack (secrets gitignored) |
| `.github/workflows/` | CI (typecheck, lint, test, shell/python, compose, image build) and multi-arch release to ghcr.io |
| `docs/` | [DEPLOYMENT.md](docs/DEPLOYMENT.md) + the design docs the implementation follows |

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
