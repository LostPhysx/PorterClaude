# PorterClaude app image. OWNER: O1.
# Build context = REPO ROOT (docker build -f docker/Dockerfile .), filtered by /.dockerignore.
# Must build on amd64 and arm64 from the classic Docker Engine /build API (deploy/deploy.sh
# streams a tar to Portainer) AND under buildx in CI. No BuildKit-only syntax.
# Contracts (docs/design/orchestration.md §5): start `node server/dist/index.js`, PORT 8080,
# DATA_DIR /data, healthcheck GET /api/health, and docker/ + web/public + node_modules must
# be present next to server/ because the server resolves them relative to <repoRoot>.

# ---------- stage 1: dependencies ----------
FROM node:22-bookworm-slim AS deps
# Every stage is labelled so the images a rebuild leaves DANGLING can be collected by label
# (`docker image prune -f --filter label=porterclaude.image=app`, or deploy/host-prep.sh
# --prune, which only ever touches dangling images carrying a porterclaude.* label).
LABEL porterclaude.image="app" porterclaude.stage="deps"
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
# `npm ci` needs a lock file; it is not committed yet, so fall back to `npm install`.
# Once package-lock.json is committed this keeps working unchanged (and gets reproducible).
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi

# ---------- stage 2: build ----------
FROM deps AS build
LABEL porterclaude.image="app" porterclaude.stage="build"
WORKDIR /app
COPY . .
# server: tsc -> server/dist ; web is plain ES modules and has no build step
RUN npm run build --workspaces --if-present
# drop devDependencies but KEEP the web workspace's prod deps: bootstrap, jquery, xterm and
# golden-layout are served straight out of node_modules by server/src/vendor.ts
RUN npm prune --omit=dev --no-audit --no-fund

# ---------- stage 3: runtime ----------
FROM node:22-bookworm-slim AS runtime
LABEL porterclaude.image="app" porterclaude.stage="runtime"
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    HOME=/home/porterclaude

# --chown on COPY instead of a `chown -R` layer (which would duplicate node_modules)
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/server/dist ./server/dist
COPY --from=build --chown=10001:10001 /app/server/package.json ./server/
COPY --from=build --chown=10001:10001 /app/package.json ./
COPY --chown=10001:10001 web/public ./web/public
COPY --chown=10001:10001 web/package.json ./web/
# recipe + tools build contexts: the server tars <repoRoot>/docker/recipes/<name> at runtime
COPY --chown=10001:10001 docker ./docker

# unprivileged runtime user. NOTE for operators: socket mode needs `group_add: ["<docker gid>"]`
# in compose (stat -c %g /var/run/docker.sock) because uid 10001 is not in the host docker group.
RUN useradd -r -u 10001 -m -d /home/porterclaude -s /usr/sbin/nologin porterclaude \
 && mkdir -p /data \
 && chown -R 10001:10001 /data

USER 10001

EXPOSE 8080

# no curl/wget in this image on purpose: node's built-in fetch does the healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# /data is declared by compose, not here: an implicit VOLUME confuses stack updates
CMD ["node", "server/dist/index.js"]
