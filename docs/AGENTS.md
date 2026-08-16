# Coding agents in PorterClaude

> **PLANNER SKELETON — TODO(O2): write this guide.** The outline below is the contract:
> keep the headings and fill them in from `docs/design/orchestration.md` §12–§15 (delivery)
> and `docs/design/backend.md` §12.3 (`AgentDefinition`, auth volumes). Everything a reader
> needs must be here — this is the page linked from Settings → Agents and from the README.

PorterClaude runs **coding agents** inside your dev containers. v0.2 makes the agent a
first-class, configurable thing: PorterClaude itself is agent-neutral, and each *host* gets
the agents you enable for it.

## 1. The model (TODO(O2))

* an **agent** is `{ id, name, command, args, versionCommand, install, sharedPaths,
  historyPath, env, loginHint, homepage }`
* a **host** installs the agents you enable for it into its own tools volume
  (Settings → Images → *Sync tools*), and gives each agent **one auth volume per host**
  (`porterclaude-auth-<agentId>`) — log in once per host, every session on that host is
  authenticated; **nothing is shared between hosts**
* a **session** picks agents (default: everything installed on its host); a terminal runs
  `bash` or one of the session's agents

## 2. The built-in agents (TODO(O2): table with id / install kind / login / shared paths)

| id | agent | installed via | how you log in | state shared per host |
|---|---|---|---|---|
| `claude` | Claude Code | native installer | `/login` inside the agent | `~/.claude`, `~/.claude.json` |
| `opencode` | opencode | native installer | `opencode auth login` | `~/.local/share/opencode`, `~/.config/opencode` |
| `gemini` | Gemini CLI | npm (bundled Node) | Google login or `GEMINI_API_KEY` | `~/.gemini` |
| `codex` | Codex CLI | npm (bundled Node) | ChatGPT login or `OPENAI_API_KEY` | `~/.codex` |
| `aider` | Aider | pip/uv (bundled Python) | API keys in `~/.aider.conf.yml` | `~/.aider*` |

Keep the source of truth in `server/src/agents/builtin.ts` — this table only explains it.

## 3. Enabling an agent on a host (TODO(O2))

Settings → Hosts → *(host)* → Agents → enable → **Sync tools** → recreate the sessions that
should get it (the mounts are part of the container spec). Cover: the first sync downloads a
runtime and takes minutes, needs outbound network **from the docker host**, and grows the
tools volume.

## 4. Adding a custom agent (TODO(O2) — the main reason this page exists)

Settings → Agents → *Add*. Explain each field, then show the four install kinds with a
complete, working JSON example each:

```jsonc
{
  "id": "my-agent",                       // lowercase slug, immutable, used in volume names
  "name": "My Agent",
  "command": "my-agent",                  // what lands on PATH inside the session
  "args": [],
  "versionCommand": ["my-agent", "--version"],
  "install": { "kind": "npm", "package": "@acme/my-agent", "version": "latest" },
  "sharedPaths": [ { "path": "~/.my-agent", "kind": "dir" } ],
  "historyPath": null,
  "env": {},
  "loginHint": "run `my-agent login` once per host",
  "homepage": "https://example.com"
}
```

Must be documented explicitly:

* **`sharedPaths` is the whole point** — anything the agent writes that must survive a
  session recreate and be visible to the other sessions on that host goes here. A `file`
  path is fine (it is symlinked, never bind-mounted). Two paths of one agent may not collapse
  to the same slug (`agentPathSlug`), and the app rejects that at save time.
* **install kinds**: `script` (curl | sh, the installer decides the architecture),
  `npm` (uses the tools volume's bundled Node), `pip` (uses the bundled uv/Python —
  **glibc sessions only**), `binary` (explicit URL per target: `linux-x64`, `linux-arm64`,
  `linux-x64-musl`, `linux-arm64-musl`).
* **what "installed" means**: the agent lands in `<toolsMount>/agents/<id>` on that host and
  gets a shim at `<toolsMount>/bin/<command>`; the Images/Tools panel shows the version from
  `AGENTS.json`, or the install error.
* **failure is soft**: a broken install never breaks the host or the other agents — the panel
  shows `not installed` plus the error, and a session terminal for it is refused.
* **musl (alpine) sessions**: what works and what does not (§13.7 of the design doc).
* **secrets**: never put an API key into an agent definition; use the session's environment
  variables or the agent's own config file inside its auth volume.

## 5. Troubleshooting (TODO(O2))

`agent not available` on a terminal, `command not found` after enabling (missing sync /
missing recreate), a login that does not stick (ownership of the auth volume — the container
must run as the volume's uid), a musl session with a glibc-only agent, and where to look:
the tools sync job log, `<toolsMount>/AGENTS.json`, `<toolsMount>/agents/<id>/ERROR`.
