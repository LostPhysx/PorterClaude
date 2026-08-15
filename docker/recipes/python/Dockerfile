# PorterClaude recipe: python (python:3.13-bookworm). OWNER: O1.
FROM python:3.13-bookworm
ARG CLAUDE_VERSION=latest
LABEL porterclaude.recipe="python" \
      porterclaude.claude-version="${CLAUDE_VERSION}"
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PORTERCLAUDE_RECIPE=python \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

COPY common.sh /tmp/common.sh
RUN bash /tmp/common.sh && rm -f /tmp/common.sh

# TODO(O1): pip install --no-cache-dir uv pipx  (wheels exist for amd64 + arm64),
#   pre-create + chown /home/dev/.cache/pip and /home/dev/.local

USER dev
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/pc-entrypoint.sh"]
CMD ["sleep", "infinity"]
