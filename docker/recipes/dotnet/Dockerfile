# PorterClaude recipe: dotnet (mcr.microsoft.com/dotnet/sdk:9.0, Debian 12 based). OWNER: O1.
FROM mcr.microsoft.com/dotnet/sdk:9.0
ARG CLAUDE_VERSION=latest
LABEL porterclaude.recipe="dotnet" \
      porterclaude.claude-version="${CLAUDE_VERSION}"
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PORTERCLAUDE_RECIPE=dotnet \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_CLI_HOME=/home/dev \
    NUGET_PACKAGES=/home/dev/.nuget/packages

COPY common.sh /tmp/common.sh
RUN bash /tmp/common.sh && rm -f /tmp/common.sh

# TODO(O1): mkdir -p /home/dev/.nuget/packages /home/dev/.dotnet && chown -R 1000:1000 /home/dev
#   (optionally `dotnet --info` as a smoke check; do NOT run `dotnet workload` installs)

USER dev
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/pc-entrypoint.sh"]
CMD ["sleep", "infinity"]
