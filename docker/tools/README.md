# docker/tools — the shared `porterclaude-tools` volume

OWNER: O1. Full design: [`docs/design/orchestration.md`](../../docs/design/orchestration.md) §4.

Custom session images (any `FROM` the user types) get Claude Code without a rebuild: the
server mounts this volume read-only at `/opt/porterclaude` and overrides the container's
entrypoint with `/opt/porterclaude/entrypoint.sh`.

| File | When it runs | What it does |
|---|---|---|
| `Dockerfile` | build | installs curl, runs `fetch-claude.sh`, stages `/payload` |
| `fetch-claude.sh` | build | downloads the 4 native claude binaries (x64/arm64 × glibc/musl), writes the dispatcher + `VERSION` |
| `populate.sh` | container `CMD` | stages `/payload` inside the volume mounted at `/out` and renames it into place, then exits 0 |
| `entrypoint.sh` | every custom session container | `$HOME`, PATH, best-effort git/tmux install, `~/.claude.json` symlink, image-home bridge, idle |

## Volume layout

```
/opt/porterclaude/entrypoint.sh                 0755  bootstrap (container entrypoint)
/opt/porterclaude/VERSION                       0644  claude version string
/opt/porterclaude/bin/claude                    0755  dispatcher (architecture + libc)
/opt/porterclaude/bin/claude-linux-x64          0755  glibc, 64-bit intel
/opt/porterclaude/bin/claude-linux-arm64        0755  glibc, 64-bit arm
/opt/porterclaude/bin/claude-linux-x64-musl     0755  musl,  64-bit intel
/opt/porterclaude/bin/claude-linux-arm64-musl   0755  musl,  64-bit arm
```

Everything is world-readable and world-executable (`chmod -R a+rX`): the volume is mounted
**read-only** into sessions that run as whatever uid the user's image happens to use.

`bin/claude` is a POSIX-sh dispatcher: it maps `uname -m` to `x64`/`arm64`, detects musl
(`/lib/ld-musl-*` or `ldd --version`), and execs the matching binary. If the glibc build for
this architecture is missing it falls back to the statically linked musl build.

## Re-syncing

Settings → Images → **Sync tools**. That builds `porterclaude/tools:latest` from this
directory, creates the `porterclaude-tools` volume when missing, and runs one container with
the volume mounted read-write at `/out`; `populate.sh` copies the payload in and exits 0 (a
non-zero exit is reported as a failed job). Existing sessions pick the new payload up on
their next restart.

**Re-syncing while sessions are running is safe.** A session that is running `claude` off
this volume holds `bin/claude-linux-*` open as a *busy executable*, and writing into such a
file fails with `ETXTBSY` ("Text file busy") — which is exactly what a naive
`cp -a /payload/. /out/` does, aborting the sync half-way and leaving the volume in a mixed
state. `populate.sh` therefore never writes in place: it copies everything into
`/out/.pc-stage.<pid>/` first, fixes the modes there, and then `mv`s each file over its
target. `rename(2)` is allowed on a busy executable — the running process keeps the old,
now-unlinked inode and the next `claude` start picks up the new binary. A stale
`.pc-stage.*` left behind by an interrupted sync is removed at the start of the next one.

## Build args

| Arg / env | Default | Meaning |
|---|---|---|
| `CLAUDE_VERSION` | `stable` | version to fetch; `stable`/`latest` are resolved through `$CLAUDE_DIST_BASE/stable`. Recorded in the `porterclaude.claude-version` label (requested version) and, resolved, in `VERSION` |
| `CLAUDE_DIST_BASE` | the public Claude Code release bucket | override to fetch from a mirror or an air-gapped cache |

If a download fails, `fetch-claude.sh` falls back to the official installer for the **host**
architecture only and warns loudly that cross-architecture binaries are missing; the build
fails only when not even the host architecture could be covered.

## What `entrypoint.sh` guarantees

It is strict POSIX sh (busybox ash, dash and bash all run it) and **nothing in it may kill
the container** — every step logs on failure and continues:

1. pins `HOME` to `$PORTERCLAUDE_HOME` (`/home/dev`), *overriding* whatever home the image
   brings. That is where the server mounts the shared login volumes; the image's own home
   (`/root` for the root images most people use) would put the Claude credentials outside
   them and break "log in once, every session is authenticated". The server pins the same
   `HOME` in the container env, so `docker exec`ed terminals agree;
2. puts `$PORTERCLAUDE_TOOLS/bin` on `PATH` **together with the PATH the container was created
   with** (the server pins `<tools>/bin` + the image's own `ENV PATH` there) and persists both
   for login shells (`/etc/profile.d/porterclaude.sh`, `~/.profile`, `~/.bashrc`, each guarded
   by a marker so restarts do not duplicate lines). Baking the image PATH in is not optional:
   `/etc/profile` on Debian & co *replaces* `PATH` with a fixed list, so a snippet that only
   re-added the tools directory would leave e.g. a `golang:1.23-bookworm` session without
   `/usr/local/go/bin` — `which go` in a terminal would fail although PID 1 has it. The
   snippet ships a `pc_path_compose` helper that drops empty and duplicate entries, so
   sourcing it twice (login shell + `~/.bashrc`) cannot grow `PATH`. The marker carries a
   version (`porterclaude (generated v2)`), so a container bootstrapped by an older tools
   volume gets the new block appended instead of being skipped;
3. as root, drops a `/usr/local/bin/claude` wrapper for non-login shells;
4. best-effort installs `git` and `tmux` when missing and only when root, via the first of
   `apt-get / apk / dnf / microdnf / yum / zypper / pacman` it finds, with a 300 s timeout and
   all output in `/tmp/porterclaude-bootstrap.log`. No package manager → it logs
   `degraded: no package manager` and carries on (terminals work, tmux persistence does not);
5. seeds `~/.claude-home/.claude.json` and symlinks `~/.claude.json` to it, moving an existing
   regular file into the volume first — user data is never deleted;
6. bridges the image's own home when it differs from `$HOME`: `<image home>/.claude`,
   `.claude-home` and `.claude.json` become symlinks into `$HOME`, so code that resolves
   `~` through `/etc/passwd` rather than `$HOME` (`su -`, `sudo -i`, `os.homedir()`) still
   sees the shared login. Anything already there is moved to `*.pc-backup`, never removed;
7. writes `/tmp/porterclaude-ready` and then idles (portable loop, so an image whose `sleep`
   rejects `infinity` still stays up) or execs the container command.
