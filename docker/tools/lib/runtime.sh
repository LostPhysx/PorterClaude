#!/usr/bin/env bash
# PorterClaude — the bundled runtimes in the tools volume. OWNER: O1. v0.2.
# Spec: docs/design/orchestration.md §13.1, §13.7.
#
# npm agents need a Node that exists inside ARBITRARY session images, pip agents need a
# Python. Neither may be assumed to be in the image, so both ship in the tools volume:
#
#   $TOOLS_MOUNT/runtime/node/bin/node        POSIX-sh dispatcher: glibc or musl build
#   $TOOLS_MOUNT/runtime/node/glibc/…         nodejs.org distribution
#   $TOOLS_MOUNT/runtime/node/musl/…          unofficial-builds.nodejs.org (best effort)
#   $TOOLS_MOUNT/runtime/node/VERSION
#   $TOOLS_MOUNT/runtime/uv/bin/uv            static musl build → runs on glibc AND musl
#   $TOOLS_MOUNT/runtime/python/…             uv-managed CPython (glibc; musl unsupported)
#
# All three are LAZY: they are only fetched when at least one enabled agent needs them, and
# they are carried over from the existing volume ($PC_OUT — the tools volume as it is right
# now) when the pinned version already matches.
set -uo pipefail

# Pinned so a sync is reproducible and the payload size is predictable. Verified current on
# 2026-08-16: node 24.19.0 is the active LTS line ("Krypton") and has musl builds for both
# architectures; uv follows its `latest` release. Plain version strings, never URLs.
PC_NODE_VERSION="${PORTERCLAUDE_NODE_VERSION:-24.19.0}"
PC_UV_VERSION="${PORTERCLAUDE_UV_VERSION:-latest}"
PC_PYTHON_VERSION="${PORTERCLAUDE_PYTHON_VERSION:-3.12}"

PC_NODE_BASE="${PORTERCLAUDE_NODE_BASE:-https://nodejs.org/dist}"
PC_NODE_MUSL_BASE="${PORTERCLAUDE_NODE_MUSL_BASE:-https://unofficial-builds.nodejs.org/download/release}"
PC_UV_BASE="${PORTERCLAUDE_UV_BASE:-https://github.com/astral-sh/uv/releases}"

# Resolved by the pc_ensure_* functions and reused by lib/kinds.sh.
export PC_NODE_BIN=""     # the glibc `node` INSIDE the tools container (it installs the packages)
PC_NPM_CLI=""      # …/lib/node_modules/npm/bin/npm-cli.js — never the `npm` symlink, whose
                   # shebang is /usr/bin/env node and would need node on PATH
PC_UV_BIN=""
PC_PYTHON_BIN=""

# The runtime path (§13.2) and the volume as it exists right now (the carry-over source).
pc_runtime_root() { printf '%s/runtime' "${TOOLS_MOUNT:-${MOUNT:-/opt/porterclaude}}"; }
pc_out_root()     { printf '%s' "${PC_OUT:-${OUT:-/out}}"; }

# pc_ensure_node : make $TOOLS_MOUNT/runtime/node usable and print the path of the npm CLI of
# the GLIBC build (that is what installs packages inside the tools container).
#   * glibc: $PC_NODE_BASE/v$V/node-v$V-linux-<arch>.tar.xz           (required)
#   * musl : $PC_NODE_MUSL_BASE/v$V/node-v$V-linux-<arch>-musl.tar.xz (best effort)
#   * writes runtime/node/bin/node, a POSIX-sh dispatcher that picks glibc|musl at RUNTIME
#     and prints a clear error when the needed flavour is absent
# Returns non-zero when the glibc build could not be obtained: every npm agent then fails
# with that one reason (§17).
pc_ensure_node() {
  local root dir arch out_dir tmp url name
  root="$(pc_runtime_root)"
  dir="$root/node"
  arch="$(pc_node_arch)"

  if [ -n "$PC_NPM_CLI" ] && [ -f "$PC_NPM_CLI" ]; then
    printf '%s' "$PC_NPM_CLI"
    return 0
  fi
  if [ -z "$arch" ]; then
    pc_warn "node runtime: unsupported machine '$(uname -m)'"
    return 1
  fi

  if [ ! -x "$dir/glibc/bin/node" ]; then
    out_dir="$(pc_out_root)/runtime/node"
    if [ "${PORTERCLAUDE_TOOLS_FORCE:-0}" != "1" ] \
       && [ -x "$out_dir/glibc/bin/node" ] \
       && [ "$(cat "$out_dir/VERSION" 2>/dev/null || echo)" = "$PC_NODE_VERSION" ]; then
      pc_log "node $PC_NODE_VERSION: carried over from the existing volume"
      mkdir -p "$root"
      rm -rf "$dir"
      cp -a "$out_dir" "$dir" || { pc_warn "node: carry-over failed"; rm -rf "$dir"; }
    fi
  fi

  if [ ! -x "$dir/glibc/bin/node" ]; then
    tmp="$(mktemp -d)"
    name="node-v$PC_NODE_VERSION-linux-$arch"
    url="$PC_NODE_BASE/v$PC_NODE_VERSION/$name.tar.xz"
    pc_log "fetching node $PC_NODE_VERSION ($arch, glibc)"
    if ! pc_fetch "$url" "$tmp/node.tar.xz"; then
      pc_warn "node: download failed: $url"
      rm -rf "$tmp"
      return 1
    fi
    rm -rf "$dir/glibc"
    if ! pc_extract "$tmp/node.tar.xz" "$dir/glibc" 1; then
      pc_warn "node: could not unpack the glibc distribution"
      rm -rf "$tmp"
      return 1
    fi
    rm -rf "$tmp"
  fi

  if [ ! -x "$dir/musl/bin/node" ]; then
    tmp="$(mktemp -d)"
    name="node-v$PC_NODE_VERSION-linux-$arch-musl"
    url="$PC_NODE_MUSL_BASE/v$PC_NODE_VERSION/$name.tar.xz"
    pc_log "fetching node $PC_NODE_VERSION ($arch, musl — best effort)"
    if pc_fetch "$url" "$tmp/node-musl.tar.xz" \
       && pc_extract "$tmp/node-musl.tar.xz" "$dir/musl" 1; then
      :
    else
      rm -rf "$dir/musl"
      pc_warn "node: no musl build for this architecture — npm agents cannot run in musl (alpine) sessions"
    fi
    rm -rf "$tmp"
  fi

  printf '%s\n' "$PC_NODE_VERSION" > "$dir/VERSION"
  pc_write_exec "$dir/bin/node" <<'DISPATCH'
#!/bin/sh
# PorterClaude node dispatcher (generated by docker/tools/lib/runtime.sh). POSIX sh.
# Picks the flavour that matches THIS container's libc: the volume is shared by every
# session of the host, and an alpine and a debian session may use it at the same time.
set -u
_d="$(CDPATH='' cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd)"
[ -n "$_d" ] || _d=/opt/porterclaude/runtime/node
_flavour=glibc
if ls /lib/ld-musl-* >/dev/null 2>&1; then
  _flavour=musl
elif ldd --version 2>&1 | grep -qi musl; then
  _flavour=musl
fi
if [ ! -x "$_d/$_flavour/bin/node" ]; then
  echo "porterclaude: the bundled node runtime has no $_flavour build on this host." >&2
  echo "porterclaude: re-run Settings -> Images -> Sync tools, or use a glibc based image." >&2
  exit 1
fi
# the musl distribution of node is linked against libgcc/libstdc++, which a bare alpine
# image does not ship: say so before the loader's cryptic "symbol not found" appears
if [ "$_flavour" = musl ] && ! ls /usr/lib/libgcc_s.so.1 /lib/libgcc_s.so.1 >/dev/null 2>&1; then
  echo "porterclaude: the musl build of node needs libgcc/libstdc++, which this image does" >&2
  echo "porterclaude: not ship. On alpine: apk add --no-cache libstdc++ libgcc" >&2
fi
exec "$_d/$_flavour/bin/node" "$@"
DISPATCH

  PC_NODE_BIN="$dir/glibc/bin/node"
  PC_NPM_CLI="$dir/glibc/lib/node_modules/npm/bin/npm-cli.js"
  if [ ! -f "$PC_NPM_CLI" ]; then
    PC_NPM_CLI="$(find "$dir/glibc/lib/node_modules/npm" -name 'npm-cli.js' 2>/dev/null | head -n1)"
  fi
  if [ -z "$PC_NPM_CLI" ] || [ ! -f "$PC_NPM_CLI" ]; then
    pc_warn "node: the distribution carries no npm CLI"
    return 1
  fi
  printf '%s' "$PC_NPM_CLI"
  return 0
}

# pc_ensure_uv : fetch the STATIC uv release for this architecture into
# $TOOLS_MOUNT/runtime/uv/bin/uv and print its path. uv's linux assets are musl-static, so
# one binary covers glibc and musl hosts alike.
pc_ensure_uv() {
  local root dir target url tmp out_dir
  root="$(pc_runtime_root)"
  dir="$root/uv"
  if [ -n "$PC_UV_BIN" ] && [ -x "$PC_UV_BIN" ]; then
    printf '%s' "$PC_UV_BIN"
    return 0
  fi
  target="$(pc_uv_target)"
  if [ -z "$target" ]; then
    pc_warn "uv: unsupported machine '$(uname -m)'"
    return 1
  fi

  if [ ! -x "$dir/bin/uv" ]; then
    out_dir="$(pc_out_root)/runtime/uv"
    if [ "${PORTERCLAUDE_TOOLS_FORCE:-0}" != "1" ] && [ -x "$out_dir/bin/uv" ]; then
      pc_log "uv: carried over from the existing volume"
      mkdir -p "$root"
      rm -rf "$dir"
      cp -a "$out_dir" "$dir" || { pc_warn "uv: carry-over failed"; rm -rf "$dir"; }
    fi
  fi

  if [ ! -x "$dir/bin/uv" ]; then
    if [ "$PC_UV_VERSION" = "latest" ] || [ -z "$PC_UV_VERSION" ]; then
      url="$PC_UV_BASE/latest/download/uv-$target.tar.gz"
    else
      url="$PC_UV_BASE/download/$PC_UV_VERSION/uv-$target.tar.gz"
    fi
    tmp="$(mktemp -d)"
    pc_log "fetching uv ($PC_UV_VERSION)"
    if ! pc_fetch "$url" "$tmp/uv.tar.gz" || ! pc_extract "$tmp/uv.tar.gz" "$tmp/x" 1; then
      pc_warn "uv: download failed: $url"
      rm -rf "$tmp"
      return 1
    fi
    mkdir -p "$dir/bin"
    if ! cp -f "$tmp/x/uv" "$dir/bin/uv" 2>/dev/null; then
      pc_warn "uv: the archive carries no uv binary"
      rm -rf "$tmp"
      return 1
    fi
    cp -f "$tmp/x/uvx" "$dir/bin/uvx" 2>/dev/null || :
    chmod 0755 "$dir/bin"/* 2>/dev/null || :
    rm -rf "$tmp"
  fi

  PC_UV_BIN="$dir/bin/uv"
  printf '%s' "$PC_UV_BIN"
  return 0
}

# pc_ensure_python : `uv python install $PC_PYTHON_VERSION` with
# UV_PYTHON_INSTALL_DIR=$TOOLS_MOUNT/runtime/python, and print the interpreter path. The
# download is a glibc build (the tools image is Debian): pip agents are documented as
# glibc-only (§13.7) and their run.sh says so.
pc_ensure_python() {
  local root pydir uv out_dir found
  root="$(pc_runtime_root)"
  pydir="$root/python"
  if [ -n "$PC_PYTHON_BIN" ] && [ -x "$PC_PYTHON_BIN" ]; then
    printf '%s' "$PC_PYTHON_BIN"
    return 0
  fi
  pc_ensure_uv >/dev/null || return 1
  uv="$PC_UV_BIN"

  out_dir="$(pc_out_root)/runtime/python"
  if [ ! -d "$pydir" ] && [ -d "$out_dir" ] && [ "${PORTERCLAUDE_TOOLS_FORCE:-0}" != "1" ]; then
    pc_log "python: carried over from the existing volume"
    mkdir -p "$root"
    cp -a "$out_dir" "$pydir" || rm -rf "$pydir"
  fi

  mkdir -p "$pydir"
  pc_log "installing CPython $PC_PYTHON_VERSION (uv managed)"
  # `env` wraps the COMMAND: a prefix assignment in front of the pc_run FUNCTION would leak
  # into the rest of this shell, and `env … pc_run` would look for an executable of that name
  if ! pc_run 900 env UV_PYTHON_INSTALL_DIR="$pydir" UV_PYTHON_PREFERENCE=only-managed \
         "$uv" python install "$PC_PYTHON_VERSION"; then
    pc_warn "python: 'uv python install $PC_PYTHON_VERSION' failed"
    return 1
  fi
  found="$(UV_PYTHON_INSTALL_DIR="$pydir" UV_PYTHON_PREFERENCE=only-managed \
           "$uv" python find "$PC_PYTHON_VERSION" 2>/dev/null | head -n1)"
  if [ -z "$found" ] || [ ! -x "$found" ]; then
    found="$(find "$pydir" -mindepth 3 -maxdepth 3 -type f -name 'python3' -perm -u+x 2>/dev/null | head -n1)"
  fi
  if [ -z "$found" ] || [ ! -x "$found" ]; then
    pc_warn "python: no managed interpreter found under $pydir"
    return 1
  fi
  PC_PYTHON_BIN="$found"
  printf '%s' "$PC_PYTHON_BIN"
  return 0
}
