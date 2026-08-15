# docker/ — images

OWNER: O1. Design: [`docs/design/orchestration.md`](../docs/design/orchestration.md).

| Path | Image | Built by | Tag |
|---|---|---|---|
| `Dockerfile` | the PorterClaude app | `deploy/deploy.sh` (Portainer `/build`) or CI buildx | `porterclaude:local` / `ghcr.io/<owner>/porterclaude:<ver>` |
| `recipes/<name>/Dockerfile` | session dev images | the app itself, Settings → Images | `porterclaude/<name>:latest` |
| `tools/Dockerfile` | payload for the shared tools volume | the app itself, Settings → Images → Sync tools | `porterclaude/tools:latest` |

Recipes are **never** published: they are built natively on whichever host runs the
sessions, so amd64 and arm64 both work without buildx.

TODO(O1): document
* how `common.sh` is injected at the tar root of every recipe context (so `COPY common.sh .`
  works) and that editing it marks all six recipes `outdated`;
* the `CLAUDE_VERSION` build arg and where the real version ends up
  (`/etc/porterclaude/claude-version`, `porterclaude.claude-version` label = requested);
* the php recipe's port-80-as-uid-1000 caveat and the `PC_HTTP_PORT` escape hatch;
* how to add a recipe (directory + entry in `server/src/images/recipes.ts` — that file is
  backend-owned, so raise it rather than editing it).
