# PorterClaude tools image. OWNER: O1.
# Builds the payload for the shared read-only volume `porterclaude-tools`, which custom
# session images mount at /opt/porterclaude. The server builds this as porterclaude/tools:latest
# and then runs ONE container from it with the volume mounted rw at /out; the default CMD
# copies the payload into /out and exits 0 (see docs/design/orchestration.md §4).
# Classic builder only. Build context = docker/tools (nothing is injected by the server).
FROM debian:bookworm-slim
ARG CLAUDE_VERSION=stable
LABEL porterclaude.claude-version="${CLAUDE_VERSION}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY fetch-claude.sh entrypoint.sh populate.sh /usr/local/bin/

# fetch-claude.sh downloads the native binaries for all four targets (with an installer
# fallback for the host architecture) and writes the dispatcher + VERSION into /payload.
RUN chmod 0755 /usr/local/bin/fetch-claude.sh /usr/local/bin/entrypoint.sh /usr/local/bin/populate.sh \
 && mkdir -p /payload/bin \
 && cp /usr/local/bin/entrypoint.sh /payload/entrypoint.sh \
 && chmod 0755 /payload/entrypoint.sh \
 && CLAUDE_VERSION="${CLAUDE_VERSION}" /usr/local/bin/fetch-claude.sh \
 && chmod -R a+rX /payload

CMD ["/usr/local/bin/populate.sh"]
