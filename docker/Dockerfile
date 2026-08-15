# PorterClaude app image. OWNER: O1.
# Build context = REPO ROOT (docker build -f docker/Dockerfile .), filtered by /.dockerignore.
# Must build on amd64 and arm64 from the classic Docker Engine /build API (deploy/deploy.sh
# streams a tar to Portainer) AND under buildx in CI. No BuildKit-only syntax.
# Contracts (docs/design/orchestration.md §5): start `node server/dist/index.js`, PORT 8080,
# DATA_DIR /data, healthcheck GET /api/health, and docker/ + web/public + node_modules must
# be present next to server/ because the server resolves them relative to <repoRoot>.

# ---------- stage 1: dependencies ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
# TODO(O1): RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
#   (the lock file is not committed yet — the fallback keeps CI and deploys working)
RUN true

# ---------- stage 2: build ----------
FROM deps AS build
WORKDIR /app
COPY . .
# TODO(O1): RUN npm run build --workspaces --if-present   (tsc -> server/dist)
#   then: RUN npm prune --omit=dev   (keeps the web workspace's vendor deps, drops tsx/vitest)
RUN true

# ---------- stage 3: runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

# TODO(O1): copy from the build stage:
#   /app/node_modules -> ./node_modules      (vendor assets are served straight out of it)
#   /app/server/dist  -> ./server/dist
#   /app/server/package.json -> ./server/
#   /app/package.json -> ./
# and from the context: web/public -> ./web/public, web/package.json -> ./web/,
#   docker -> ./docker   (recipe + tools build contexts, PORTERCLAUDE_DOCKER_DIR default)

# TODO(O1): create an unprivileged user (uid 10001), mkdir /data, chown /data and /app,
#   then USER 10001. NOTE for operators: socket mode needs `group_add: ["<docker gid>"]`
#   in compose because uid 10001 is not in the host's docker group.

EXPOSE 8080

# TODO(O1): HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
#   CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
#   (no curl/wget in this image on purpose)

CMD ["node", "server/dist/index.js"]
