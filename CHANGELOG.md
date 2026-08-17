# Changelog

All notable changes to PorterClaude. Versions are git tags (`vX.Y.Z`); each tag is also
published as `ghcr.io/lostphysx/porterclaude:<version>`.

## v0.2.2 — 2026-08-17

- **Sessions prepare their host instead of refusing.** Creating (or editing, or starting) a
  session whose recipe image was never built, or whose host has an unsynced tools volume, no
  longer fails with a 409 that throws the form away. The definition is stored immediately, the
  image build and/or tools sync run on the host, and the container is created and started when
  they finish. The API answers `202` with `session.preparing` (`phase`, `detail`, the image
  `jobs` to follow); the Sessions table shows a *preparing* badge with the current step.
- A failed preparation keeps the session and puts the reason in its warnings — **Start**
  retries the whole thing. Concurrent calls join the running preparation rather than starting
  a second build.
- An edit/recreate that needs a build no longer tears the old container down first: it keeps
  running until the host is ready.
- Recipe picker says *builds on first use* instead of *not built*.

## v0.2.1 — 2026-08-17

- Custom-agent definitions are validated at the API (command, paths, env keys; `historyPath`
  must stay inside the agent's shared dir) → `422` instead of a broken tools volume.
- **Instance-scoped discovery**: every container/volume gets `porterclaude.instance=<id>`, so
  two PorterClaude installs on one engine no longer see each other's sessions (unlabelled
  pre-0.2.1 containers are still adopted).
- Tools sync distinguishes "download failed (curl exit N)" from "no URL for this arch";
  `lastSyncedAt` survives restarts; unreachable-host errors surface in the Agents view.
- Re-running *Import endpoints* keeps operator-edited host names; the Add-host form no
  longer inherits the default host's agent set.
- Docs/compose/deploy consistency: quick start pre-creates the socket host
  (`PORTERCLAUDE_BACKEND=socket`), `DOCKER_GID` documented, `.env.example`/compose network
  variables aligned, `porterclaude.instance` label explained in `docs/DEPLOYMENT.md`.

## v0.2.0 — 2026-08-17

- **Multiple Docker hosts.** A host is the local socket or a Portainer credential +
  endpoint; *Import endpoints* creates one host per Portainer endpoint. Images, volumes,
  sessions and logins are per host; one unreachable host never breaks the rest.
- **Pluggable coding agents.** Claude Code, opencode, Gemini CLI, Codex CLI and Aider ship
  built in; custom agents are added as a JSON definition (npm / pip / installer script /
  binary). Recipe images no longer bake an agent in — sessions mount the host's tools volume,
  so upgrading an agent is a forced **Sync tools**, never an image rebuild.
- **One login per agent per host** via `porterclaude-auth-<agentId>` volumes; the v0.1
  Claude Code login is imported automatically (self-healing if the first import was partial).
- Config store migrated v1 → v2 losslessly; session entrypoint hardened for `dash`.
- Guide: `docs/AGENTS.md`.

## v0.1.0 — 2026-08-16

- Password login (JWT cookie), encrypted config store (`/data/config.json`).
- Docker backends configured in the app: Portainer (URL + API key + endpoint) or local
  `docker.sock`.
- Sessions from curated recipes (node, dotnet, php-fpm+nginx, python, go, base) or any custom
  image; create / edit / destroy.
- Tabbed, multi-pane browser terminals (GoldenLayout + xterm.js), reconnect-safe via tmux.
- Shared Claude Code login across all containers on a host.
- Reference deployment via Portainer (`deploy/deploy.sh`), CI + multi-arch release to ghcr.io.
