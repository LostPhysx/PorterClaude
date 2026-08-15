# PorterClaude recipe: go (golang:1.23-bookworm). OWNER: O1.
FROM golang:1.23-bookworm
ARG CLAUDE_VERSION=latest
LABEL porterclaude.recipe="go" \
      porterclaude.claude-version="${CLAUDE_VERSION}"
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PORTERCLAUDE_RECIPE=go \
    GOPATH=/home/dev/go \
    GOCACHE=/home/dev/.cache/go-build \
    GOFLAGS=-buildvcs=false

COPY common.sh /tmp/common.sh
RUN bash /tmp/common.sh && rm -f /tmp/common.sh

# TODO(O1): mkdir -p $GOPATH $GOCACHE && chown -R 1000:1000 /home/dev/go /home/dev/.cache

USER dev
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/pc-entrypoint.sh"]
CMD ["sleep", "infinity"]
