# PorterClaude tools image. OWNER: O1. v0.2 (docs/design/orchestration.md §13.3).
#
# Builds the payload for the per-host read-only volume `porterclaude-tools`, which EVERY
# session mounts at <toolsMount> (default /opt/porterclaude) in v0.2. The server builds this
# as <ns>/tools:latest and then runs ONE container from it with the volume mounted rw at /out
# and PORTERCLAUDE_AGENTS in the environment; the default CMD populates the volume, installs
# the host's enabled agents and exits 0.
#
# v0.2: NOTHING is downloaded at build time any more (v0.1 baked the four claude binaries in).
# The image is a thin, cacheable toolbox; the agents are installed by the populate run, which
# is what makes "enable an agent -> Sync tools" work without rebuilding an image.
# Classic builder only. Build context = docker/tools (nothing is injected by the server).
FROM debian:bookworm-slim
ARG CLAUDE_VERSION=stable
LABEL porterclaude.claude-version="${CLAUDE_VERSION}"

# jq: the ONLY JSON parser used for PORTERCLAUDE_AGENTS / AGENTS.json (never grep/sed).
# xz-utils + unzip + tar: agent and runtime archives. ca-certificates + curl: downloads.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl jq tar xz-utils unzip \
 && rm -rf /var/lib/apt/lists/*

# The image mirrors docker/tools 1:1 so that $0-relative sourcing works here and in a
# checkout (CI runs `install-agents.sh --plan` straight from the repo).
COPY . /opt/pc-tools/

# /payload is what ends up IN the volume: the runtime bootstrap, the runtime sh helpers and
# the empty directory skeleton the installer fills (§13.1).
RUN chmod 0755 /opt/pc-tools/populate.sh /opt/pc-tools/install-agents.sh \
 && chmod 0755 /opt/pc-tools/entrypoint.sh \
 && mkdir -p /payload/bin /payload/lib /payload/agents /payload/runtime \
 && cp /opt/pc-tools/entrypoint.sh /payload/entrypoint.sh \
 && cp /opt/pc-tools/lib/pc-common.sh /payload/lib/pc-common.sh \
 && chmod 0755 /payload/entrypoint.sh \
 && chmod -R a+rX /payload

ENV PORTERCLAUDE_CLAUDE_VERSION="${CLAUDE_VERSION}" \
    PORTERCLAUDE_TOOLS_MOUNT=/opt/porterclaude

CMD ["/opt/pc-tools/populate.sh"]
