# PorterClaude

Launch **Claude Code** dev containers on your Docker host and work in them from the
browser — tabbed, multi-pane terminals, one shared Claude login for every container.

- **Code** — terminal workspace (tabs, split panes, reconnect-safe via tmux)
- **Sessions** — create / edit / destroy dev containers from curated recipes
  (node, dotnet, php-fpm+nginx, python, go, base) or any custom image
- **Settings** — point it at a **Portainer** endpoint (URL + API key) or the local
  **Docker socket**; everything is configured in the app, nothing hard-coded

Status: planning / scaffolding. See [PLAN.md](PLAN.md) and [docs/](docs/).

## Quick start (target — not yet implemented)

```yaml
# docker-compose.yml
services:
  porterclaude:
    image: ghcr.io/lostphysx/porterclaude:latest
    ports: ["8080:8080"]
    volumes:
      - porterclaude-data:/data
      - /var/run/docker.sock:/var/run/docker.sock   # optional: socket mode
    environment:
      APP_PASSWORD: change-me
volumes:
  porterclaude-data:
```

Open `http://localhost:8080`, log in with `APP_PASSWORD`, go to **Settings** and either
accept the auto-detected Docker socket or enter your Portainer URL + API key.
Create a session, open a terminal, run `claude`, log in once — every other session is
now authenticated too.

## Repo

| Path | What |
|---|---|
| `server/` | Express + ws API, WebSocket terminal bridge, Docker backends (Portainer / socket) |
| `web/` | Bootstrap 5 + jQuery UI, GoldenLayout panes, xterm.js terminals |
| `docker/recipes/` | Dockerfiles for the curated dev images |
| `docker/tools/` | bootstrap for arbitrary custom images |
| `deploy/` | operator-specific deployment (secrets gitignored) |
| `docs/` | deployment + architecture docs |

License: MIT — see [LICENSE](LICENSE).
