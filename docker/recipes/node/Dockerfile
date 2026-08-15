# PorterClaude recipe: node (node:22-bookworm). OWNER: O1.
# NOTE: this base already has a uid-1000 user called `node`; common.sh RENAMES it to `dev`
# (usermod -l dev -d /home/dev -m node) instead of creating a second uid-1000 account.
FROM node:22-bookworm
ARG CLAUDE_VERSION=latest
LABEL porterclaude.recipe="node" \
      porterclaude.claude-version="${CLAUDE_VERSION}"
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PORTERCLAUDE_RECIPE=node \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

COPY common.sh /tmp/common.sh
RUN bash /tmp/common.sh && rm -f /tmp/common.sh

# TODO(O1): recipe tooling as root:
#   corepack enable (pnpm + yarn shims), npm cache dir under /home/dev, chown 1000:1000

USER dev
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/pc-entrypoint.sh"]
CMD ["sleep", "infinity"]
