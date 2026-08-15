# docker/tools — the shared `porterclaude-tools` volume

OWNER: O1. Full design: [`docs/design/orchestration.md`](../../docs/design/orchestration.md) §4.

Custom session images (any `FROM` the user types) get Claude Code without a rebuild: the
server mounts this volume read-only at `/opt/porterclaude` and overrides the container's
entrypoint with `/opt/porterclaude/entrypoint.sh`.

| File | When it runs | What it does |
|---|---|---|
| `Dockerfile` | build | installs curl, runs `fetch-claude.sh`, stages `/payload` |
| `fetch-claude.sh` | build | downloads the 4 native claude binaries (x64/arm64 × glibc/musl), writes the dispatcher + `VERSION` |
| `populate.sh` | container `CMD` | copies `/payload` into the volume mounted at `/out`, then exits 0 |
| `entrypoint.sh` | every custom session container | PATH, best-effort git/tmux install, `~/.claude.json` symlink, idle |

TODO(O1): document the volume layout, the `CLAUDE_DIST_BASE` / `CLAUDE_VERSION` build args,
and how to re-sync from the UI (Settings → Images → Sync tools).
