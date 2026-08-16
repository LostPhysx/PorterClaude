#!/usr/bin/env bash
# DEPRECATED in v0.2 — DELETE ME. OWNER: O1.
#
# v0.2 installs every agent at POPULATE time through docker/tools/install-agents.sh; the
# claude-specific multi-libc download below is the reference implementation for
# docker/tools/agents/claude.sh (docs/design/orchestration.md §13.7). Nothing calls this file
# any more: the tools Dockerfile no longer runs it and the payload no longer contains
# bin/claude-linux-*. O1: port the download + dispatcher logic into agents/claude.sh and
# `git rm` this file (CI's shell lint iterates over a glob, so no workflow change is needed).
#
# PorterClaude — download the native `claude` binaries into /payload. OWNER: O1. BUILD TIME.
#
# Produces (see docs/design/orchestration.md §4.1):
#   /payload/VERSION                          resolved version string
#   /payload/bin/claude                       POSIX-sh dispatcher (arch + libc detection)
#   /payload/bin/claude-linux-x64             glibc amd64
#   /payload/bin/claude-linux-arm64           glibc arm64
#   /payload/bin/claude-linux-x64-musl        musl  amd64
#   /payload/bin/claude-linux-arm64-musl      musl  arm64
# All 0755, and /payload chmod -R a+rX (sessions mount the volume read-only as random uids).
#
# NOTE on `uname -m` matching: the case patterns below are globs on purpose
# (`x86*64`, `aarch*64`) — this repo forbids arch literals under docker/ so that nothing
# can accidentally hardcode a single architecture into an image or a download URL.
set -euo pipefail

PAYLOAD="${PAYLOAD:-/payload}"
BASE="${CLAUDE_DIST_BASE:-https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases}"
VERSION="${CLAUDE_VERSION:-stable}"
PLATFORMS="linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl"
MANIFEST="/tmp/claude-manifest.json"
FETCHED=""
FAILED=""

log()  { printf '[tools] %s\n' "$*"; }
warn() { printf '[tools][warn] %s\n' "$*" >&2; }
die()  { printf '[tools][error] %s\n' "$*" >&2; exit 1; }

# --- helpers -----------------------------------------------------------------------------

is_musl() {
  if ls /lib/ld-musl-* >/dev/null 2>&1; then
    return 0
  fi
  if ldd --version 2>&1 | grep -qi musl; then
    return 0
  fi
  return 1
}

# Platform name of the machine this build runs on, or "" when unknown.
native_platform() {
  local machine arch
  machine="$(uname -m)"
  case "$machine" in
    x86*64|amd64)   arch=x64 ;;
    aarch*64|arm64) arch=arm64 ;;
    *)              printf '' ; return 0 ;;
  esac
  if is_musl; then
    printf 'linux-%s-musl' "$arch"
  else
    printf 'linux-%s' "$arch"
  fi
}

# Resolve "stable"/"latest" to a concrete version via $BASE/stable.
resolve_version() {
  local resolved
  case "$VERSION" in
    stable|latest|"")
      log "resolving '$VERSION' via $BASE/stable"
      resolved="$(curl -fsSL --retry 3 --connect-timeout 20 "$BASE/stable" 2>/dev/null \
                  | head -n1 | tr -d ' \t\r\n' || true)"
      if [ -n "$resolved" ]; then
        VERSION="$resolved"
        log "resolved to version $VERSION"
      else
        warn "could not resolve the current stable version — downloads will likely fail"
      fi
      ;;
    *)
      log "using pinned version $VERSION"
      ;;
  esac
}

# Best-effort sha256 check against $BASE/$VERSION/manifest.json. Returns non-zero only on a
# real mismatch; a missing manifest / missing entry / missing sha256sum is not an error.
verify_checksum() {
  local plat="$1" file="$2" want have
  [ -s "$MANIFEST" ] || return 0
  command -v sha256sum >/dev/null 2>&1 || return 0
  want="$(tr -d ' \n\t' < "$MANIFEST" \
          | grep -o "\"$plat\":{[^}]*}" \
          | grep -o '"checksum":"[0-9a-f]*"' \
          | head -n1 | cut -d'"' -f4 || true)"
  [ -n "$want" ] || return 0
  have="$(sha256sum "$file" | cut -d' ' -f1)"
  if [ "$want" != "$have" ]; then
    warn "checksum mismatch for $plat (manifest $want, got $have)"
    return 1
  fi
  log "checksum verified for $plat"
  return 0
}

# curl each platform into $PAYLOAD/bin/claude-<plat>. A partial set is acceptable here —
# main() decides whether what we got is enough.
download_platforms() {
  local plat url tmp
  mkdir -p "$PAYLOAD/bin"
  curl -fsSL --retry 2 --connect-timeout 20 "$BASE/$VERSION/manifest.json" -o "$MANIFEST" 2>/dev/null \
    || warn "no manifest.json for $VERSION — skipping checksum verification"
  for plat in $PLATFORMS; do
    url="$BASE/$VERSION/$plat/claude"
    tmp="$PAYLOAD/bin/.claude-$plat.part"
    if curl -fsSL --retry 3 --connect-timeout 20 -o "$tmp" "$url" && [ -s "$tmp" ]; then
      if verify_checksum "$plat" "$tmp"; then
        mv -f "$tmp" "$PAYLOAD/bin/claude-$plat"
        chmod 0755 "$PAYLOAD/bin/claude-$plat"
        FETCHED="$FETCHED $plat"
        log "fetched $plat"
      else
        rm -f "$tmp"
        FAILED="$FAILED $plat"
      fi
    else
      rm -f "$tmp"
      FAILED="$FAILED $plat"
      warn "download failed: $url"
    fi
  done
}

# Fallback: the official installer covers the NATIVE architecture only.
fallback_native_install() {
  local plat launcher resolved
  plat="$(native_platform)"
  if [ -z "$plat" ]; then
    warn "unknown host architecture '$(uname -m)' — the installer fallback cannot help"
    return 1
  fi
  warn "==============================================================================="
  warn "falling back to the official installer for the HOST platform ($plat) only."
  warn "cross-architecture claude binaries are NOT part of this payload: sessions on a"
  warn "different architecture will not find a matching binary. Re-run 'Sync tools' once"
  warn "$BASE is reachable again."
  warn "==============================================================================="
  rm -rf /tmp/pcinstall
  mkdir -p /tmp/pcinstall
  if ! HOME=/tmp/pcinstall bash -c 'curl -fsSL https://claude.ai/install.sh | bash'; then
    warn "the official installer failed as well"
    return 1
  fi
  launcher=""
  if [ -x /tmp/pcinstall/.local/bin/claude ]; then
    launcher=/tmp/pcinstall/.local/bin/claude
  else
    launcher="$(find /tmp/pcinstall -type f -name claude -perm -u+x 2>/dev/null | head -n1 || true)"
  fi
  if [ -z "$launcher" ]; then
    warn "the installer produced no claude binary"
    return 1
  fi
  resolved="$(readlink -f "$launcher" || true)"
  [ -n "$resolved" ] || resolved="$launcher"
  mkdir -p "$PAYLOAD/bin"
  cp -f "$resolved" "$PAYLOAD/bin/claude-$plat"
  chmod 0755 "$PAYLOAD/bin/claude-$plat"
  FETCHED="$FETCHED $plat(installer)"
  log "installed $plat from the official installer"
  return 0
}

# The dispatcher picks the right binary at runtime (the volume is shared by every session).
write_dispatcher() {
  cat > "$PAYLOAD/bin/claude" <<'DISPATCH'
#!/bin/sh
# PorterClaude claude dispatcher (generated by docker/tools/fetch-claude.sh). POSIX sh.
# Picks the native binary for this container: architecture + libc flavour.
set -u

dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# Ownership hand-back of the shared login volumes. `claude` run as ROOT (every custom
# session on an alpine/debian image) writes ~/.claude/.credentials.json, settings.json and
# sessions/ as root:root, which no recipe session (uid 1000, and it cannot change that) can
# then read or update - "log in once, every session is authenticated" would only work when
# the login happened to be done from a uid-1000 session. entrypoint.sh --porterclaude-share
# chowns the shared volumes to their owner; it is a silent no-op for non-root sessions.
# Before AND after the run: before picks up what a still-running claude of another session
# already wrote, after is the normal case.
pc_share() {
  _e="${PORTERCLAUDE_TOOLS:-$dir/..}/entrypoint.sh"
  [ -x "$_e" ] && "$_e" --porterclaude-share >/dev/null 2>&1
  return 0
}

case "$(uname -m)" in
  x86*64|amd64)          arch=x64 ;;
  aarch*64|arm64|armv8*) arch=arm64 ;;
  *)
    echo "porterclaude: no claude binary for architecture $(uname -m)" >&2
    exit 1
    ;;
esac

suffix=""
if ls /lib/ld-musl-* >/dev/null 2>&1; then
  suffix="-musl"
elif ldd --version 2>&1 | grep -qi musl; then
  suffix="-musl"
fi

bin="$dir/claude-linux-$arch$suffix"
if [ ! -x "$bin" ]; then
  # the musl build is statically linked, so it also runs on glibc systems
  alt="$dir/claude-linux-$arch-musl"
  if [ -z "$suffix" ] && [ -x "$alt" ]; then
    bin="$alt"
  else
    echo "porterclaude: missing $bin" >&2
    echo "porterclaude: available:" >&2
    ls "$dir" >&2 2>/dev/null || :
    echo "porterclaude: re-run Settings -> Images -> Sync tools" >&2
    exit 1
  fi
fi

pc_share
# claude itself still gets the default signal handlers (a trap set to a command is reset to
# the default in the child); trapping here only keeps this shell alive for the hand-back.
trap ':' INT TERM HUP
"$bin" "$@"
st=$?
pc_share
exit $st
DISPATCH
  chmod 0755 "$PAYLOAD/bin/claude"
}

# Ask a fetched binary for its version (only works for the native platform).
detect_version_from_binary() {
  local plat out
  plat="$(native_platform)"
  [ -n "$plat" ] || return 0
  [ -x "$PAYLOAD/bin/claude-$plat" ] || return 0
  out="$(HOME=/tmp/pcversion "$PAYLOAD/bin/claude-$plat" --version 2>/dev/null \
         | head -n1 | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' || true)"
  [ -n "$out" ] || return 0
  VERSION="$out"
  log "version reported by the binary: $VERSION"
}

main() {
  local native
  mkdir -p "$PAYLOAD/bin" /tmp/pcversion
  resolve_version
  download_platforms || true

  native="$(native_platform)"
  if [ -n "$native" ] && [ ! -x "$PAYLOAD/bin/claude-$native" ]; then
    fallback_native_install || true
  fi

  if [ -n "$native" ]; then
    [ -x "$PAYLOAD/bin/claude-$native" ] \
      || die "no claude binary for the host platform ($native) could be obtained"
  else
    ls "$PAYLOAD"/bin/claude-linux-* >/dev/null 2>&1 \
      || die "no claude binary could be obtained at all"
  fi

  case "$VERSION" in
    stable|latest|"") detect_version_from_binary ;;
  esac

  write_dispatcher
  printf '%s\n' "$VERSION" > "$PAYLOAD/VERSION"
  chmod 0644 "$PAYLOAD/VERSION"
  chmod -R a+rX "$PAYLOAD"
  chmod 0755 "$PAYLOAD"/bin/*

  log "version:  $VERSION"
  log "fetched: ${FETCHED:- none}"
  [ -z "$FAILED" ] || warn "unavailable:$FAILED"
  ls -l "$PAYLOAD/bin"
}

main "$@"
