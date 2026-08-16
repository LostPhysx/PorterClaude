# PorterClaude

Launch dev containers on your Docker hosts and work in them from the browser — tabbed,
multi-pane terminals, with the **coding agent of your choice** installed and logged in once
per host.

- **Code** — terminal workspace (tabs, drag-to-split panes, reconnect-safe via tmux); every
  pane is a shell or a coding agent
- **Sessions** — create / edit / destroy dev containers on any host, from curated recipes
  (node, dotnet, php-fpm+nginx, python, go, base) or any custom image
- **Settings** — **hosts** (local Docker socket and/or Portainer endpoints), **agents**
  (five built in, plus your own), images and account; everything is configured in the app,
  nothing hard-coded

Status: **v0.2 — multiple hosts and pluggable coding agents**, on top of the shipped v0.1.0
(auth, Portainer + socket backends, recipe/custom-image sessions, multi-pane terminals, all
QA-verified end-to-end). See [PLAN.md](PLAN.md), [docs/](docs/) and
[docs/design/](docs/design/).

## What v0.2 adds

- **Multiple Docker hosts.** A host is the local socket or a Portainer credential +
  endpoint; *Import endpoints* creates one host per Portainer endpoint in a click. Images,
  volumes, sessions and logins are per host, and one unreachable host never breaks the rest.
- **Coding agents are data, not code.** Claude Code, opencode, Gemini CLI, Codex CLI and
  Aider ship built in; you can add your own with a JSON definition (npm / pip / installer
  script / plain binary). Recipe images no longer bake an agent in — every session mounts
  the host's tools volume instead, so upgrading an agent is *Upgrade all agents* (a forced
  **Sync tools**), never an image rebuild.
- **One login per agent per host.** Each agent gets its own volume
  (`porterclaude-auth-<agentId>`); log in once and every session on that host is
  authenticated. Upgrading from v0.1 imports the existing Claude Code login automatically.

Full guide: [docs/AGENTS.md](docs/AGENTS.md).

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
      - /var/run/docker.sock:/var/run/docker.sock    # only for a local-socket host
    group_add: ["999"]                               # stat -c %g /var/run/docker.sock
volumes:
  porterclaude-data:
```

1. Open `http://localhost:8080` and log in with `APP_PASSWORD`.
2. **Settings → Hosts**: accept the auto-detected Docker socket, or add a Portainer
   credential (URL + API key) and import its endpoints.
3. **Settings → Agents**: pick the agents this host should have, then **Sync tools** — that
   is what installs them (minutes on the first run, outbound HTTPS from the Docker host).
4. Create a session, open a terminal, run your agent and log in once — every other session on
   that host is now authenticated too.

The app runs as a non-root uid (10001), hence `group_add` for the socket; Portainer hosts
need no socket. Full operator documentation: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
(upgrading from v0.1 included).

## Repo

| Path | What |
|---|---|
| `server/` | Node 22 + TypeScript API: **Express 5** + `ws`, WebSocket terminal bridge, host manager (Portainer via fetch / socket via dockerode), agent registry, config store |
| `web/` | Static UI, **no bundler**: Bootstrap 5 + jQuery, native ES modules, GoldenLayout 2 panes, xterm.js 5 terminals (vendor assets served from `node_modules`) |
| `docker/` | `Dockerfile` for the app image, `recipes/` for the dev images, `tools/` for the agent delivery (installs the enabled agents into a host's tools volume, plus the session entrypoint) |
| `deploy/` | reference deployment: `deploy.sh` builds the image through Portainer and creates/updates the stack (secrets gitignored) |
| `.github/workflows/` | CI (typecheck, lint, test, shell/python, agent-installer contract, compose, image build) and multi-arch release to ghcr.io |
| `docs/` | [DEPLOYMENT.md](docs/DEPLOYMENT.md), [AGENTS.md](docs/AGENTS.md) + the design docs the implementation follows |

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
