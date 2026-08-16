# docker/tools — the per-host `porterclaude-tools` volume

OWNER: O1. Full design: [`docs/design/orchestration.md`](../../docs/design/orchestration.md)
§13–§14 (v0.2 is authoritative), §4 for the v0.1 background.

This directory builds the **agent delivery mechanism**. In v0.2 the coding agents are no
longer baked into any image: every host has one tools volume, the volume carries the agents
that host has enabled, and **every** session — recipe *and* custom image — mounts it
read-only at `<toolsMount>` (default `/opt/porterclaude`) and is started with
`<toolsMount>/entrypoint.sh` as its entrypoint.

| File | When it runs | What it does |
|---|---|---|
| `Dockerfile` | build | installs `ca-certificates curl jq tar xz-utils unzip`, copies this directory to `/opt/pc-tools` and stages the static payload in `/payload`. **Downloads nothing** |
| `populate.sh` | container `CMD` | stage → point `<toolsMount>` at the stage → install the agents → promote into the volume → exit 0 |
| `install-agents.sh` | from `populate.sh` (and `--plan` from CI) | parses `PORTERCLAUDE_AGENTS`, installs/carries over/drops one directory per agent, writes the shims and `AGENTS.json` |
| `lib/common.sh` | build-time helper | logging, `curl`/`tar` wrappers, `jq` access, shell quoting, the promotion primitives |
| `lib/kinds.sh` | build-time helper | the four generic installers (`script`, `npm`, `pip`, `binary`) and the `run.sh` writer |
| `lib/runtime.sh` | build-time helper | the bundled Node, `uv` and CPython runtimes |
| `agents/<id>.sh` | build-time override | per-agent installer that beats the generic one (today only `claude`) |
| `entrypoint.sh` | **every** session container | `PATH`, the agent symlinks, ownership repair, `/usr/local/bin` wrappers, the image-home bridge, idle/`exec "$@"` |
| `lib/pc-common.sh` | inside sessions | the sh helpers the shims and launchers share (arch/libc detection, path resolution) |

Only `entrypoint.sh` and `lib/pc-common.sh` ever run **inside a session image**: they are
strict POSIX sh (busybox ash, dash and bash all run them), use no GNU-only flags and never
abort the container. Everything else runs only in the Debian based tools image and may use
bash + `jq`.

## Volume layout

```
<toolsMount>/entrypoint.sh                 0755  session bootstrap (POSIX sh)
<toolsMount>/AGENTS.json                   0644  the manifest (ToolsAgentManifest)
<toolsMount>/VERSION                       0644  claude's version, or empty (v0.1 compat)
<toolsMount>/lib/pc-common.sh              0644  sh helpers for the shims and launchers
<toolsMount>/bin/pc-agent                  0755  the one shim implementation
<toolsMount>/bin/<command>                 0755  per-agent shim (`claude`, `gemini`, …)
<toolsMount>/agents/<id>/run.sh            0755  generated launcher
<toolsMount>/agents/<id>/VERSION           0644  what `versionCommand` printed, or empty
<toolsMount>/agents/<id>/SPEC.json         0644  the spec this directory was built from
<toolsMount>/agents/<id>/ERROR             0644  install error (absent on success)
<toolsMount>/agents/<id>/…                       kind payload (bin/, node_modules/, tools/)
<toolsMount>/runtime/node/bin/node         0755  libc dispatcher (POSIX sh)
<toolsMount>/runtime/node/{glibc,musl}/…         Node distributions
<toolsMount>/runtime/uv/bin/uv             0755  static uv (glibc *and* musl)
<toolsMount>/runtime/python/…                    uv-managed CPython (glibc)
```

Everything is world-readable and world-executable (`chmod -R a+rX`): the volume is mounted
**read-only** into sessions that run as whatever uid the user's image happens to use.
v0.1's `bin/claude-linux-*` are gone — `bin/claude` is now the generic shim, so containers
created by v0.1 keep working after an upgrade, and the stale files are removed from the
volume by the first v0.2 sync.

### Seeding the shared paths (`entrypoint.sh`)

Every `sharedPaths` entry of an agent becomes one `PORTERCLAUDE_AGENT_LINKS` entry
(`target|source|kind`) and one symlink from the container home into the agent's auth volume.
The link **source** must exist before the agent writes it, because most agents replace such a
file atomically (write next to it + `rename`), which a dangling symlink cannot absorb — so
`entrypoint.sh` creates it:

| `kind` / suffix | seeded with |
|---|---|
| `dir` | `mkdir -p` |
| `file`, `*.json` / `*.yml` / `*.yaml` | `{}` — the empty mapping of JSON *and* YAML |
| `file`, anything else | a zero-byte file |

A zero-byte file is **not** a neutral default for a structured format: `aider` reads the
shared `~/.aider.conf.yml` through configargparse and aborts with `yaml.load(…) returned type
NoneType instead of dict` (exit 2) when it is empty (QA OPS-2). An already-seeded empty
`.json`/`.yml`/`.yaml` source is repaired to `{}` on the next start — a 0-byte file holds no
user data, and volumes seeded by an older build have to heal themselves. Anything the *user*
put at the link target is parked aside as `<target>.pc-backup`, never deleted.

`bin/<command>` sets `PORTERCLAUDE_AGENT_ID` and execs `bin/pc-agent`, which resolves the
payload root, refuses a missing agent with a clear "not installed on this host — Settings →
Images → Sync tools" (exit 127), brackets the run with `entrypoint.sh --porterclaude-share`
(the ownership hand-back) and execs `agents/<id>/run.sh`.

## What a sync does

Settings → Images → **Sync tools** builds `<ns>/tools:latest` from this directory and runs
**one** container from it per host, with the host's tools volume mounted read-write at
`/out` and `PORTERCLAUDE_AGENTS` (a JSON `AgentInstallSpec[]`, `server/src/agents/model.ts`)
in the environment. `populate.sh` then:

1. removes leftovers of an interrupted run and stages the payload in `/out/.pc-stage.<pid>/`;
2. points the **runtime** path at that stage: `ln -sfn <stage> <toolsMount>`. This is the one
   trick that makes the volume relocatable — `npm` bin shims, `uv` tool scripts and
   `pyvenv.cfg` bake **absolute** paths at install time, so everything is installed through
   `<toolsMount>/…` and never through `/out/…`;
3. runs `install-agents.sh`, which per agent either **carries it over** (identical
   `SPEC.json`, a non-empty `VERSION`, no `ERROR`, and `PORTERCLAUDE_TOOLS_FORCE` is not `1`)
   or installs it through `agents/<id>.sh` / the kind installer, wrapped in
   `timeout $PORTERCLAUDE_AGENT_TIMEOUT`;
4. writes `bin/pc-agent`, one shim per command, `AGENTS.json` and `VERSION`;
5. promotes the stage into the volume and drops the symlink.

**Exit code**: non-zero only when the payload itself could not be published (or when
`PORTERCLAUDE_AGENTS` is not valid JSON — that is a server bug, not an agent problem). A
single agent failing to install is a warning: it is recorded as `installed:false` + `error`
in `AGENTS.json`, the shim is still written and prints that reason when the user calls it,
and the job succeeds.

A sync needs **outbound network on the docker host** and takes minutes on the first run
(Node ≈ 60 MB, a uv CPython ≈ 90 MB, aider's dependencies ≈ 250 MB). Re-syncs are cheap:
unchanged agents and runtimes are copied from the volume, not downloaded again.

### Upgrading an installed agent

The carry-over compares the **spec**, not the installed version, and a spec does not change
when upstream ships a new release — so a plain re-sync keeps `claude`, `opencode`, … at the
version they were installed with, forever. The upgrade switch is `PORTERCLAUDE_TOOLS_FORCE=1`:
it disables the carry-over and reinstalls every enabled agent **and** the bundled runtimes
from source (the channel/`latest` an install kind resolves is re-resolved, so this is what
picks up a new upstream version).

The server sets it for `POST /api/hosts/:hostId/images/tools/sync {"force":true}` — in the
UI: Settings → Agents → the caret next to *Install / update on this host* → **Upgrade all
agents**. That request also rebuilds `<ns>/tools:latest` without the layer cache, so expect
the cost of a first sync again. A plain sync (`force:false`) stays the cheap "install what is
missing" path.

Running sessions are unaffected by an upgrade (see *Re-syncing while sessions are running*
below): they keep the copy they started with until they are restarted.

### Environment

| Env | Default | Meaning |
|---|---|---|
| `PORTERCLAUDE_AGENTS` | `[]` | the JSON spec array (required for anything to be installed) |
| `PORTERCLAUDE_TOOLS_MOUNT` | `/opt/porterclaude` | the path sessions mount the volume at — the path baked into every launcher |
| `PORTERCLAUDE_TOOLS_FORCE` | `0` | `1` = reinstall every agent and runtime even when the spec is unchanged — the **upgrade** switch, set by `tools/sync {force:true}` |
| `PORTERCLAUDE_AGENT_TIMEOUT` | `900` | seconds per agent install |
| `PORTERCLAUDE_NODE_VERSION` | pinned in `lib/runtime.sh` | Node for `npm` agents |
| `PORTERCLAUDE_UV_VERSION` / `PORTERCLAUDE_PYTHON_VERSION` | `latest` / `3.12` | for `pip` agents |
| `CLAUDE_DIST_BASE`, `PORTERCLAUDE_CLAUDE_VERSION` | public bucket / `stable` | claude's binary source and channel |
| `OUT` | `/out` | the mounted volume (also the carry-over source) |

`install-agents.sh --plan` validates the spec, prints one line per agent and exits 0 without
touching a file or the network — that is what CI runs.

## Re-syncing while sessions are running is safe

A session that is running an agent off this volume holds its executable open as a *busy
executable*, and writing into such a file fails with `ETXTBSY` ("Text file busy") — exactly
what a naive `cp -a /payload/. /out/` does, aborting the sync half-way. Nothing is ever
written in place:

* **files** (`entrypoint.sh`, `AGENTS.json`, `bin/*`, `lib/*`, `VERSION`) are staged and then
  `mv`d over the target. `rename(2)` is allowed on a busy executable — the running process
  keeps the old, now-unlinked inode and the next start picks up the new one;
* **directories** (`agents/<id>`, `runtime/<name>`) are swapped: the old one is moved to
  `.<name>.old`, the new one takes its place, the old one is deleted. Unlinking a running
  executable is legal on Linux;
* stale `.pc-stage.*` and `.*.old` directories are removed at the start of the next run.

## Architecture and libc

`uname -m` in the populate container is the architecture of the host the volume belongs to
(`x86*64|amd64 → x64`, `aarch*64|arm64 → arm64`); **no architecture literal may appear
anywhere under `docker/`** — every target name is composed from `pc_arch()`, and CI greps
for violations. The libc of a *session* is not known at install time (an arm64 host can run
`debian:bookworm` and `alpine:3.20` sessions side by side), so:

| Kind | glibc sessions | musl sessions |
|---|---|---|
| `claude` (override) | native binary `linux-<arch>` | native binary `linux-<arch>-musl` |
| `script` (e.g. opencode) | installer output | works when the installer emits a static/musl binary — best effort |
| `npm` | bundled Node | bundled Node musl build (unofficial-builds; best effort) |
| `pip` | uv-managed CPython | **not supported** — `run.sh` exits with "requires a glibc image on this host" |
| `binary` | the `linux-<arch>` URL | the `linux-<arch>-musl` URL when the definition has one |

Runtime detection is `ls /lib/ld-musl-*` or `ldd --version | grep -qi musl`, mirrored in
`lib/pc-common.sh` and in every generated launcher. A missing musl artefact falls back to the
glibc one **only** when it is known to be static — which is why claude's musl build is also
the glibc fallback.

## Adding an agent

Agents are **data**: `server/src/agents/builtin.ts` (built-ins) or a custom agent created in
the UI. Nothing here has to change to add one — the four install kinds cover the usual
installer/npm/pip/tarball shapes.

Write a `docker/tools/agents/<id>.sh` override only when the generic path cannot work. It is
sourced by the driver and must define `pc_agent_install_<id>` with the contract of
`docs/design/orchestration.md` §13.9:

```
in : $AGENT_ID $AGENT_COMMAND $AGENT_DIR (exists, empty) $AGENT_SPEC (JSON) $TOOLS_MOUNT $ARCH $TARGET
out: 0  -> $AGENT_DIR/run.sh exists and is executable (write it with pc_write_run_sh)
     >0 -> the agent is recorded installed:false; the reason was printed to stderr
never: exit the caller, write outside $AGENT_DIR / $TOOLS_MOUNT/runtime, prompt, or bake a
       /out path into anything
```

`SPEC.json`, `VERSION` and `ERROR` are written by the driver — an installer never touches
them. The id must exist in `server/src/agents/builtin.ts`; CI enforces that. `claude` is the
worked example: it downloads the native binaries for both libc flavours of the host
architecture (the generic `script` installer would produce a glibc-only binary, useless in an
alpine session) and falls back to the official installer when the bucket is unreachable.

## Debugging a host

```bash
docker run --rm -v porterclaude-tools:/v alpine cat /v/AGENTS.json     # what is installed
docker run --rm -v porterclaude-tools:/v alpine ls -l /v/bin /v/agents
docker exec -it <session> sh -lc 'which claude; claude --version'      # inside a session
docker exec -it <session> cat /tmp/porterclaude-bootstrap.log          # entrypoint noise
```

`agents/<id>/ERROR` holds the last install error of that agent; the job log of *Sync tools*
holds the full installer output.
