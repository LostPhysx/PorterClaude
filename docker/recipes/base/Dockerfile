# PorterClaude recipe: base (debian:bookworm-slim). OWNER: O1.
# Built by the server from the Docker Engine /build API with docker/recipes/base as the
# context plus common.sh injected at the tar root. Classic builder only — no BuildKit
# syntax, no --platform, no RUN --mount. Must build unchanged on amd64 and arm64.
FROM debian:bookworm-slim
ARG CLAUDE_VERSION=latest
LABEL porterclaude.recipe="base" \
      porterclaude.claude-version="${CLAUDE_VERSION}"
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PORTERCLAUDE_RECIPE=base

COPY common.sh /tmp/common.sh
RUN bash /tmp/common.sh && rm -f /tmp/common.sh

# no recipe-specific tooling: this image is the plain toolchain

USER dev
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/pc-entrypoint.sh"]
CMD ["sleep", "infinity"]
