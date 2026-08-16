# PorterClaude recipe: go (golang:1.23-bookworm). OWNER: O1.
FROM golang:1.23-bookworm
ARG CLAUDE_VERSION=stable
LABEL porterclaude.recipe="go" \
      porterclaude.claude-version="${CLAUDE_VERSION}"
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PORTERCLAUDE_RECIPE=go \
    GOPATH=/home/dev/go \
    GOCACHE=/home/dev/.cache/go-build \
    PORTERCLAUDE_PATH_EXTRA=/home/dev/go/bin \
    GOFLAGS=-buildvcs=false

COPY common.sh /tmp/common.sh
RUN bash /tmp/common.sh && rm -f /tmp/common.sh

# module + build caches inside the session home, owned by uid 1000
RUN mkdir -p /home/dev/go/bin /home/dev/go/pkg /home/dev/.cache/go-build \
 && chown -R 1000:1000 /home/dev

USER dev
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/pc-entrypoint.sh"]
CMD ["sleep", "infinity"]
