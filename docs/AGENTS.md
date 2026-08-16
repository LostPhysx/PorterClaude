# Coding agents in PorterClaude

PorterClaude runs **coding agents** inside your dev containers. Since v0.2 the agent is a
first-class, configurable thing: the app itself is agent-neutral, ships five built-ins, and
lets you add your own. Each *host* gets exactly the agents you enable for it.

Operator-side topics (installing PorterClaude, hosts, volumes, backups) live in
[DEPLOYMENT.md](DEPLOYMENT.md). The definitions of the built-in agents are code:
[`server/src/agents/builtin.ts`](../server/src/agents/builtin.ts) is the source of truth,
this page only explains it.

## 1. The model

**Agent** — a definition, not a code path:

```
{ id, name, description, command, args, versionCommand,
  install, sharedPaths, historyPath, env, loginHint, homepage }
```

`id` is a slug (`^[a-z0-9][a-z0-9-]{0,31}$`), stable forever: it appears in the terminal
protocol (`shell=agent:<id>`) and in a volume name, so it is never renamed.

**Host** — one Docker engine. A host installs the agents you enable for it into **its own**
tools volume (Settings → Agents → *Sync tools*, or Settings → Images → *Sync tools*), and
gives each of them **one auth volume per host**:

```
porterclaude-auth-<agentId>   ->   /home/dev/.porterclaude/agents/<agentId>
```

Log in once on a host and every session on that host is authenticated. **Nothing is shared
between hosts** — not images, not the tools volume, not logins. A login on host `prod` says
nothing about host `lab`.

**Session** — a container on one host. It mounts the tools volume read-only at
`/opt/porterclaude` and the auth volume of each of its agents; by default a session gets the
agents *enabled on its host*, but you can narrow that per session. A terminal then runs
either a plain shell or one of the session's agents.

Everything the agent expects in `$HOME` is a **symlink** into its auth volume, created by the
tools volume's entrypoint when the container starts:

```
~/.claude       ->  ~/.porterclaude/agents/claude/claude          (dir)
~/.claude.json  ->  ~/.porterclaude/agents/claude/claude.json     (file)
```

That is why a single volume can back several shared paths, and why a *file* path works at all
(agents rewrite files like `~/.claude.json` with `rename(2)`, which a file bind mount would
not survive).

## 2. The built-in agents

| id | agent | installed via | how you log in | state shared per host |
|---|---|---|---|---|
| `claude` | Claude Code | native installer (no runtime needed) | `/login` inside the agent | `~/.claude`, `~/.claude.json` |
| `opencode` | opencode | native installer | `opencode auth login` | `~/.local/share/opencode`, `~/.config/opencode` |
| `gemini` | Gemini CLI | npm (bundled Node) | Google login, or `GEMINI_API_KEY` | `~/.gemini` |
| `codex` | Codex CLI | npm (bundled Node) | ChatGPT login, or `OPENAI_API_KEY` | `~/.codex` |
| `aider` | Aider | pip via uv (bundled Python) | API keys in `~/.aider.conf.yml` | `~/.aider.conf.yml`, `~/.aider.model.settings.yml`, `~/.aider` |

Only `claude` is enabled on a new host — every extra agent costs sync time and disk. A
migrated v0.1 install keeps its Claude Code login (see the upgrade section of
[DEPLOYMENT.md](DEPLOYMENT.md#upgrading-from-v01-to-v02)).

Built-ins cannot be deleted, but you may **disable** them per host. Disabling removes the
agent from that host's tools volume on the next sync and **never touches its auth volume**,
so re-enabling it restores the login.

## 3. Enabling an agent on a host

1. **Settings → Agents**, pick the host in the selector.
2. Toggle the agent on.
3. **Sync tools** — the host's tools volume is (re)populated with every enabled agent.
4. **Recreate** the sessions that should get it: the agent's auth volume is part of the
   container spec, so existing containers keep the mounts they were created with. Sessions
   that need it are flagged *needs recreate* in the Sessions tab.

What a sync needs, and what it costs:

* **Outbound HTTPS from the Docker host** (not from your browser, and not from the
  PorterClaude container when it drives a remote engine): the agents' own installers,
  `registry.npmjs.org`, `nodejs.org` and `github.com/astral-sh` for the bundled runtimes.
* **Minutes** on the first run — the tools image is built, then Node and/or a managed
  CPython are downloaded. Do not close the browser tab expecting it to stop; the job runs on
  the server.
* **Disk** on the Docker host: roughly 100 MB for `claude` alone, ~60 MB more for the Node
  runtime (`npm` agents), ~90 MB for the Python runtime and ~250 MB for aider's dependencies
  — call it 500 MB for the full set.

A sync is **idempotent**: an agent whose definition has not changed is carried over from the
previous volume instead of being reinstalled, so a second sync is fast. Re-syncing while
sessions are running is safe (the payload is swapped, never overwritten in place) — running
agents keep working on their old copy, newly started ones use the payload as it is after the
sync.

### Upgrading an agent to a newer release

That carry-over compares the **definition**, not the installed version — and a definition
does not change when Anthropic, OpenAI or Google ship a new release of their CLI. So *Install
/ update* alone never moves an installed agent off the version it was installed with. To pick
up new upstream versions use the caret next to the button → **Upgrade all agents**:

* every enabled agent is reinstalled from source (`claude` re-resolves its channel, `npm` and
  `pip` agents resolve `latest` again), together with the bundled Node/Python runtimes;
* the tools image is rebuilt without the layer cache first, so an upgrade costs what the
  first sync cost — minutes and a few hundred MB;
* it is per host: repeat it on every host whose agents should move;
* **running sessions keep the agent they started with** (their executable stays open on the
  old payload). Restart or recreate a session to get the new version in it — checking with
  `claude --version` in an old terminal will show the old one, which is not a failed upgrade.

Over the API that is `POST /api/hosts/:hostId/images/tools/sync` with `{"force": true}`;
`{"force": false}` is the cheap "install what is missing" sync.

## 4. Adding a custom agent

**Settings → Agents → Add**. The form takes the definition as JSON (with a preset to start
from). Custom agents live in `config.json` under `agents.custom`, are available on every
host, and are enabled per host exactly like the built-ins.

### The fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | slug, unique across built-ins and custom agents, **immutable** (it names the auth volume `porterclaude-auth-<id>`) |
| `name` | yes | label in the UI |
| `description` | no | one line shown on the card |
| `command` | yes | what must be callable inside the session; the tools volume puts it on `PATH` as `/opt/porterclaude/bin/<command>` |
| `args` | no | extra argv appended when a terminal opens the agent (default `[]`) |
| `versionCommand` | yes | argv that prints the version, e.g. `["my-agent","--version"]`; its first output line becomes the version in the Agents panel |
| `install` | yes | one of the four kinds below |
| `sharedPaths` | yes (≥1) | the paths that must survive a session recreate and be shared by every session on the host |
| `historyPath` | no | a path **inside** one of the shared dirs holding conversation history; sessions that opt out of shared history get their own volume for it (`null` when the agent has none) |
| `env` | no | extra container environment for sessions that mount this agent |
| `loginHint` | no | one line telling the user how to authenticate |
| `homepage` | no | link shown on the card |

### The four install kinds

**`script`** — the vendor's own installer, curled and piped into `sh` with `HOME`/prefix
pointed at the agent's directory in the tools volume. The installer picks the architecture.

```json
{
  "id": "opencode-nightly",
  "name": "opencode (nightly)",
  "command": "opencode-nightly",
  "args": [],
  "versionCommand": ["opencode-nightly", "--version"],
  "install": {
    "kind": "script",
    "url": "https://opencode.ai/install",
    "args": [],
    "binPath": "bin/opencode",
    "env": { "VERSION": "nightly" }
  },
  "sharedPaths": [
    { "path": "~/.local/share/opencode", "kind": "dir", "note": "auth.json, state" },
    { "path": "~/.config/opencode", "kind": "dir", "note": "settings" }
  ],
  "historyPath": null,
  "env": {},
  "loginHint": "run `opencode-nightly auth login` once per host",
  "homepage": "https://opencode.ai"
}
```

`binPath` is the executable the installer leaves behind, relative to its install prefix.

**`npm`** — installed with the tools volume's **bundled Node**, so the session image needs no
Node of its own.

```json
{
  "id": "acme-cli",
  "name": "Acme CLI",
  "command": "acme",
  "args": ["--no-telemetry"],
  "versionCommand": ["acme", "--version"],
  "install": { "kind": "npm", "package": "@acme/cli", "version": "latest", "bin": "acme" },
  "sharedPaths": [{ "path": "~/.acme", "kind": "dir", "note": "credentials + settings" }],
  "historyPath": "~/.acme/sessions",
  "env": {},
  "loginHint": "run `acme login` once per host",
  "homepage": "https://example.com/acme"
}
```

`version` is an npm dist-tag or an exact version (default `latest`); `bin` defaults to
`command`.

**`pip`** — installed with `uv tool install` against a uv-managed CPython that ships in the
tools volume. **glibc sessions only** (see the musl note below).

```json
{
  "id": "smol",
  "name": "smol-dev",
  "command": "smol",
  "args": [],
  "versionCommand": ["smol", "--version"],
  "install": { "kind": "pip", "package": "smol-dev", "version": "0.4.2", "preferUv": true, "bin": "smol" },
  "sharedPaths": [{ "path": "~/.config/smol", "kind": "dir" }],
  "historyPath": null,
  "env": {},
  "loginHint": "set SMOL_API_KEY in the session environment",
  "homepage": "https://example.com/smol"
}
```

**`binary`** — a plain download, one URL per target. Missing targets are simply not
installed on hosts of that architecture; `archive` is `none`, `tar.gz` or `zip`, and `path`
is the executable inside the archive.

```json
{
  "id": "widget",
  "name": "Widget Agent",
  "command": "widget",
  "args": [],
  "versionCommand": ["widget", "version"],
  "install": {
    "kind": "binary",
    "urls": {
      "linux-x64": "https://example.com/widget/1.4.0/widget-linux-x64.tar.gz",
      "linux-arm64": "https://example.com/widget/1.4.0/widget-linux-arm64.tar.gz",
      "linux-x64-musl": "https://example.com/widget/1.4.0/widget-linux-x64-musl.tar.gz",
      "linux-arm64-musl": "https://example.com/widget/1.4.0/widget-linux-arm64-musl.tar.gz"
    },
    "archive": "tar.gz",
    "path": "widget/bin/widget"
  },
  "sharedPaths": [{ "path": "~/.widget.toml", "kind": "file", "note": "api key + model" }],
  "historyPath": null,
  "env": {},
  "loginHint": "put your key into ~/.widget.toml",
  "homepage": "https://example.com/widget"
}
```

The four targets are `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`.

### `sharedPaths` is the whole point

Anything the agent writes that must **survive a session recreate** and be **visible to the
other sessions on that host** belongs here — credentials above all. Anything else (caches it
can rebuild, per-project state) is better left out: it only makes the auth volume bigger.

* `kind: "dir"` and `kind: "file"` are both fine — a file path is symlinked, never bind
  mounted, so atomic rewrites work.
* When in doubt share the **whole directory** rather than one file inside it. A missed path
  silently breaks "log in once per host", and the symptom (a login prompt in the second
  session) is easy to misread.
* Each path becomes a directory *inside* the auth volume, named after the whole path with
  `~/` and leading dots stripped and `/` replaced by `-`:
  `~/.local/share/opencode` → `local-share-opencode`. **Two shared paths of one agent may
  not produce the same name** — the app rejects such a definition when you save it, because
  both would land in the same place.
* `historyPath` must sit inside one of the shared **dir** paths, otherwise the "private
  history" option of a session has nothing to mount over.

### What "installed" means

After a successful sync on a host, that host's tools volume contains
`/opt/porterclaude/agents/<id>/` (the agent's files plus a generated `run.sh`) and a shim at
`/opt/porterclaude/bin/<command>`, and `/opt/porterclaude/AGENTS.json` lists the agent with
`installed: true` and the version its `versionCommand` printed. The Agents and Images panels
read exactly that file.

A version of `null` on an otherwise installed agent is normal for agents that refuse to print
one before they are authenticated.

### Failure is soft

A broken install never breaks the host, the sync or the other agents. The agent is recorded
as `installed: false` with a one-line error, the panel shows *not installed* plus that error,
and a terminal for it is refused instead of starting an unauthenticated agent. Fix the
definition and sync again. Two agents claiming the same `command` are also a soft failure:
the first one keeps the shim, the second is recorded with an error saying so.

### musl (Alpine) sessions

A session's libc is only known when the container starts, so the tools volume ships what it
can for both:

| kind | glibc session | musl session |
|---|---|---|
| `claude` | native binary | native binary (musl build) |
| `script` | installer output | works when the installer produces a static or musl binary — best effort |
| `npm` | bundled Node | bundled Node musl build; may be unavailable for arm64 — best effort |
| `pip` | uv-managed CPython | **not supported** — the shim exits with a clear message |
| `binary` | the `linux-<arch>` URL | the `linux-<arch>-musl` URL, when your definition provides one |

If an agent must work on Alpine, prefer `binary` with an explicit musl URL. The container
always stays up; only that one agent refuses to start.

Two measured details for Alpine images (docs/design/requests/v2-O1.md 4):

* **`npm` agents need the GCC runtime libraries.** The bundled musl Node build links against
  `libstdc++` and `libgcc_s`, which `alpine:*` does not ship. Add them to the image —
  `RUN apk add --no-cache libstdc++ libgcc` — or the shim dies with a loader error. The
  dispatcher prints exactly that hint when it detects the missing library.
* **`pip` agents are glibc-only.** The uv-managed CPython has no musl build here, so the shim
  exits with the documented message instead of failing halfway through an install. Use a
  glibc base image (Debian/Ubuntu) for sessions that need one.

### Editing and deleting

A custom definition can be edited at any time; the change takes effect on the **next tools
sync** of each host that has it enabled (the id itself is immutable). Deleting one is refused
while a host still enables it or a session pins it — disable it there first, or force the
delete, which strips the id from those hosts and sessions (their containers keep the mount
until they are recreated). Built-in agents can be disabled per host but never edited or
deleted. Nothing of this touches an auth volume: the login survives a delete and is picked up
again if you recreate the agent under the same id.

### Never put API keys in an agent definition

Agent definitions are configuration, not secrets: they are stored in `config.json` in
plaintext and are returned by `GET /api/agents`. Put credentials into the session's
environment variables, or let the agent write them into its own config file inside its auth
volume (which is what a `login` command does).

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| *"no agents installed on this host"* | the host's tools volume was never populated — Settings → Agents → **Sync tools** |
| the agent is missing from a terminal's menu | the session was created before the agent was enabled — **recreate** it (the mounts are part of the container spec) |
| terminal closes with **4410** `agent_not_available` | same cause; the agent is not mounted into that session, or its id is unknown. The client does not reconnect on purpose |
| terminal closes with **4411** `host_unavailable` | the session's host is unreachable or was deleted. Other hosts are unaffected |
| `command not found` inside a bash terminal | the shim only exists after a sync; check `ls /opt/porterclaude/bin` and `cat /opt/porterclaude/AGENTS.json` |
| the agent asks for a login in every session | a shared path is missing from `sharedPaths`, or the auth volume is still owned by root — recreate the session so the bootstrap re-runs the ownership repair |
| a login on host A does not work on host B | by design: auth volumes are per host. Log in once per host |
| a `pip` agent fails on an Alpine session | not supported, see the musl table above — use a glibc image for that session |
| an agent is stuck on an old version | *Install / update* keeps an installed agent as it is — use **Upgrade all agents** (caret next to the button), then restart the sessions that should get it |
| an agent shows *not installed* with an error | read the error on the card, then the tools sync job log (Settings → Images → Jobs), then `/opt/porterclaude/agents/<id>/ERROR` in any session on that host |
