# PorterClaude recipe: python (python:3.13-bookworm). OWNER: O1.
FROM python:3.13-bookworm
LABEL porterclaude.recipe="python"
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PORTERCLAUDE_RECIPE=python \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

COPY common.sh /tmp/common.sh
RUN bash /tmp/common.sh && rm -f /tmp/common.sh

# uv + pipx ship wheels for both architectures, so this stays arch-neutral
RUN pip install --no-cache-dir uv pipx \
 && mkdir -p /home/dev/.cache/pip /home/dev/.cache/uv /home/dev/.local/bin \
 && chown -R 1000:1000 /home/dev

USER dev
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/pc-entrypoint.sh"]
CMD ["sleep", "infinity"]
