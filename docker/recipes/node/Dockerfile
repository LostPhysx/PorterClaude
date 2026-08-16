# PorterClaude recipe: node (node:22-bookworm). OWNER: O1.
# NOTE: this base already has a uid-1000 user called `node`; common.sh RENAMES it to `dev`
# (usermod -l dev -d /home/dev -m node) instead of creating a second uid-1000 account.
FROM node:22-bookworm
ARG CLAUDE_VERSION=stable
LABEL porterclaude.recipe="node" \
      porterclaude.claude-version="${CLAUDE_VERSION}"
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PORTERCLAUDE_RECIPE=node \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_CACHE=/home/dev/.npm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COPY common.sh /tmp/common.sh
RUN bash /tmp/common.sh && rm -f /tmp/common.sh

# pnpm + yarn shims, and a writable npm cache inside the session home
RUN corepack enable || echo "[porterclaude][warn] corepack enable failed - npm still works" \
 && mkdir -p /home/dev/.npm /home/dev/.cache \
 && chown -R 1000:1000 /home/dev

USER dev
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/pc-entrypoint.sh"]
CMD ["sleep", "infinity"]
