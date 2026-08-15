#!/usr/bin/env bash
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
set -euo pipefail

PAYLOAD="${PAYLOAD:-/payload}"
BASE="${CLAUDE_DIST_BASE:-https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases}"
VERSION="${CLAUDE_VERSION:-stable}"
PLATFORMS="linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl"

log()  { printf '[tools] %s\n' "$*"; }
warn() { printf '[tools][warn] %s\n' "$*" >&2; }
die()  { printf '[tools][error] %s\n' "$*" >&2; exit 1; }

# Resolve "stable"/"latest" to a concrete version via $BASE/stable. TODO(O1)
resolve_version() { :; }

# curl -fsSL --retry 3 each platform into $PAYLOAD/bin/claude-<plat>; return non-zero for the
# ones that failed (do NOT abort: a partial set is acceptable, see fallback). TODO(O1)
download_platforms() { :; }

# Fallback when downloads fail: install for the NATIVE arch only via the official installer
#   HOME=/tmp/pcinstall bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
# then copy the resulting binary to the matching claude-linux-<arch> name and warn loudly
# that cross-arch binaries are unavailable. TODO(O1)
fallback_native_install() { :; }

# Write $PAYLOAD/bin/claude: case $(uname -m) -> x64|arm64, musl detection via
# /lib/ld-musl-* or `ldd --version | grep -qi musl` -> "-musl" suffix, then
# exec "$dir/claude-linux-$arch$suffix" "$@" with a clear error if missing. TODO(O1)
write_dispatcher() { :; }

main() {
  # TODO(O1): resolve_version; download_platforms || fallback_native_install;
  #   fail only when NOT EVEN the host architecture is covered;
  #   write_dispatcher; echo "$VERSION" > "$PAYLOAD/VERSION"; chmod -R a+rX "$PAYLOAD";
  #   chmod 0755 "$PAYLOAD"/bin/*; log a summary of what was fetched.
  log "TODO(O1): fetch claude binaries"
}

main "$@"
