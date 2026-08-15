# PorterClaude — Plan

PorterClaude is a self-hostable web app that launches **Claude Code dev containers** on a
Docker host and attaches browser terminals to them in a tabbed / multi-pane workspace.
All containers share **one Claude Code login session**, so you log in once.

It is generic: anyone can run PorterClaude on their own domain and point it at their own
Docker environment. Nothing about a specific host or domain is baked in.

## Vocabulary
- **Backend** — how PorterClaude talks to Docker: a *Portainer* endpoint (URL + API key +
  endpoint id) or the *local Docker socket* (`/var/run/docker.sock` mounted into the app).
- **Session** — one managed container plus its config (name, image, workspace, env,
  ports, limits). Created/edited/destroyed in the **Sessions** tab. "Edit" recreates the
  container with the new config; named volumes and the workspace survive.
- **Terminal** — one exec (`bash` or `claude`) inside a session, shown as a tab/pane in
  the **Code** tab. A session can have many terminals.

## UI (top bar with three tabs)
- **Code** — terminal workspace. dockview (VS Code-style tabs + drag-to-split panes,
  layout persisted). Left rail lists running sessions; open `bash` or `claude` in a pane.
  xterm.js with fit/webgl/web-links addons; resize + reconnect; tmux-backed so a reload
  re-attaches instead of killing Claude.
- **Sessions** — table (name, image, workspace, status, ports, uptime); Create / Edit /
  Start / Stop / Recreate / Destroy; logs viewer. Dialog: name, recipe *or* custom image,
  workspace (host path / git URL / new volume), env, ports, extra volumes, CPU/mem, "share
  Claude conversation history with other sessions" toggle.
- **Settings** — Backend selector: *Portainer* (URL, API key — write-only, stored
  encrypted; endpoint picker fetched from Portainer; "Test connection") or *Docker socket*
  (auto-detected if mounted). Shared volume names, workspaces root, default recipe,
  Images panel (build/rebuild recipes, populate `claude-tools`), app password.

## Architecture
```
Browser (React + xterm.js + dockview)
   │ HTTPS / WebSocket
   ▼
PorterClaude server (Node 22 + TypeScript, Fastify)
   ├─ /api/settings, /api/sessions, /api/images        REST
   ├─ /api/terminals/:sessionId                        WS ↔ container exec
   ├─ config store  (/data/config.json, secrets encrypted with APP_SECRET)
   └─ DockerBackend interface
        ├─ PortainerBackend  → https://<portainer>/api/endpoints/{id}/docker/…  (X-API-Key)
        │                      exec stream via wss://<portainer>/api/websocket/exec
        └─ SocketBackend     → unix:///var/run/docker.sock                       (dockerode)
                               exec stream via hijacked HTTP
                     ▼
              Docker Engine
                ├─ pc-<session>   image: recipe or custom
                │     /home/dev/.claude       ← shared volume  (login session, settings)
                │     /home/dev/.claude.json  ← shared         (account / onboarding)
                │     /workspace              ← per-session bind or volume
                └─ pc-<session2>  … same shared mounts
```
Both backends speak the Docker Engine API (Portainer merely proxies it), so ~95% of the
code is shared; only transport, auth and the exec stream differ. Verified: Portainer
2.39's `/api/websocket/exec` accepts `X-API-Key` and streams (probe returned output).

Why a server in the middle: keeps API keys off the browser, adds app auth, resize /
reconnect / tmux, and avoids browser WebSocket header limits.

## Shared login session
- Named volume `porterclaude-claude` mounted at `/home/dev/.claude` in every session:
  `.credentials.json` (OAuth access + refresh token), `settings.json`, plugins, history.
- `~/.claude.json` (account + onboarding flags) shared via a second small volume mounted
  at `/home/dev/.claude-home` with a symlink — never single-file bind mounts (Claude Code
  writes atomically via rename, which breaks file binds).
- Optional per-session overlay on `~/.claude/projects` for isolated conversation history
  (default: shared).
- Flow: create session A → terminal → `claude` → `/login` once → token lands in the shared
  volume → sessions B, C… start authenticated. Any session that refreshes the token writes
  it back; others re-read on 401. Caveat: rare refresh race between two sessions → one
  401 → retry (documented; revisit if it bites).
- Recipes run as `dev` (uid 1000) so the shared volume has one owner. Custom images run as
  the image's user unless overridden; the tools entrypoint chowns/uses `HOME` accordingly.

## Images: selectable base images per session
1. **Recipes** (curated, prebuilt from `docker/recipes/<name>/Dockerfile`, all layering
   `common.sh`: git, gh, ripgrep, tmux, curl, jq, unprivileged `dev`, Claude Code via the
   native installer, `WORKDIR /workspace`, `sleep infinity` entrypoint):
   `node` (node:22-bookworm, default), `dotnet` (mcr.microsoft.com/dotnet/sdk:9.0),
   `php` (php:8.3-fpm + nginx + composer via supervisord, port 80), `python`
   (python:3.13-bookworm), `go` (golang:1.23-bookworm), `base` (debian:bookworm-slim).
   Built via the backend's `/build` API from the Settings → Images panel, tagged
   `porterclaude/<recipe>:<claude-version>`; the UI shows built / outdated.
   Multi-arch: Dockerfiles are arch-neutral; they build natively on the target host
   (amd64 or arm64).
2. **Custom image** (any `FROM`) — user types an image ref. The session gets an entrypoint
   override that bootstraps Claude Code at start from a shared read-only volume
   `porterclaude-tools` (native `claude` binary for glibc + musl, `entrypoint.sh`); it
   puts `claude` on `PATH`, best-effort installs git/tmux via apt/apk/dnf, then idles.
   No rebuild needed. Distroless / no-package-manager images degrade to "terminal works,
   no tmux persistence" with a UI warning.

## Config storage
- `/data/config.json` in a data volume: backend settings (API key encrypted with
  `APP_SECRET`, auto-generated on first run and persisted), session definitions (source
  of truth for Edit), reconciled at startup against containers labelled
  `porterclaude.managed=true`.
- Env vars only bootstrap: `APP_PASSWORD`, `APP_SECRET`, `PORT`, optional
  `PORTERCLAUDE_BACKEND=socket|portainer` + `PORTAINER_*` seed values.

## Repo layout
```
PorterClaude/  (this repo; folder currently named claude-docker)
  server/            Fastify + ws: backends/, sessions/, terminals/, images/, config/
  web/               React + Vite: Code / Sessions / Settings
  docker/recipes/    node/ dotnet/ php/ python/ go/ base/  + common.sh
  docker/tools/      entrypoint.sh + claude binary fetcher (custom images)
  docker/Dockerfile  the PorterClaude app image
  docker-compose.yml generic compose for running PorterClaude (socket or portainer mode)
  deploy/            operator-specific deployment (compose + gitignored .env)
  docs/              DEPLOYMENT.md, ARCHITECTURE.md
  PLAN.md, README.md
```

## Milestones
1. **Scaffold + Settings + backends** — monorepo (npm workspaces), app auth, config
   store, `DockerBackend` with Portainer + socket implementations, Settings tab with
   test-connection and endpoint picker, containers list.
2. **Sessions** — session model + CRUD, container create with labels/mounts/ports/limits,
   Sessions tab UI (create/edit/recreate/destroy, logs).
3. **Terminals + Code tab** — exec + WS bridge for both backends, xterm, resize,
   reconnect, dockview tabs/panes, layout persistence.
4. **Images + shared session** — recipes, `porterclaude-tools` bootstrap for custom
   images, shared `.claude` volumes, login once → second session authenticated, tmux.
5. **Ship** — app Dockerfile (multi-arch), generic compose, docs, deploy to the reference
   instance behind nginx-proxy + acme-companion, README, first tagged release.

## Decisions taken (defaults; say so if you want otherwise)
- Node/TS full-stack; Fastify + `ws`; dockerode for the socket backend; hand-rolled fetch
  client for Portainer (dockerode's TLS/header story through a reverse proxy is fragile).
- dockview for layout; xterm.js for terminals.
- Session containers named `pc-<slug>`; labels `porterclaude.managed`, `porterclaude.session`.
- The app runs anywhere: on the managed host (socket mode, simplest) or elsewhere
  (Portainer mode). Both are first-class.
