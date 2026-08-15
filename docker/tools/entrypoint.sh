#!/bin/sh
# PorterClaude — bootstrap entrypoint for CUSTOM session images. OWNER: O1. RUNTIME.
#
# The server starts custom-image sessions with:
#   entrypoint ["/opt/porterclaude/entrypoint.sh"]   cmd ["sleep","infinity"]
#   env PORTERCLAUDE_TOOLS=/opt/porterclaude  PORTERCLAUDE_HOME=/home/dev
#       PORTERCLAUDE_SESSION=<slug>
# /opt/porterclaude is the shared tools volume, mounted READ-ONLY.
#
# HARD RULES (docs/design/orchestration.md §4.4):
#   * strict POSIX sh — this runs inside busybox/ash, dash and bash images alike
#   * NOTHING here may abort the container: every step logs on failure and continues
#   * no assumptions about the image user, package manager, or $HOME
set -u

TOOLS="${PORTERCLAUDE_TOOLS:-/opt/porterclaude}"
HOME="${HOME:-${PORTERCLAUDE_HOME:-/root}}"
export HOME
BOOTSTRAP_LOG=/tmp/porterclaude-bootstrap.log

log()  { printf '[porterclaude] %s\n' "$*"; }
warn() { printf '[porterclaude][warn] %s\n' "$*" >&2; }

# 1. PATH: $TOOLS/bin first, persisted for login shells (/etc/profile.d, ~/.profile, ~/.bashrc)
#    guarded by a marker comment so repeated starts are no-ops. TODO(O1)
setup_path() { :; }

# 2. When root and /usr/local/bin is writable, drop a wrapper /usr/local/bin/claude that
#    execs "$TOOLS/bin/claude" "$@" (covers non-login shells). TODO(O1)
install_claude_wrapper() { :; }

# 3. Best-effort install of git + tmux, ONLY when id -u = 0 and only for missing packages.
#    Try apt-get, apk, dnf, microdnf, yum, zypper, pacman — first found wins. Hard timeout
#    (`timeout 300` when available), all output into $BOOTSTRAP_LOG. No package manager ->
#    log "degraded: no package manager" and continue. TODO(O1)
bootstrap_packages() { :; }

# 4. Shared config: mkdir -p $HOME/.claude $HOME/.claude-home; seed
#    $HOME/.claude-home/.claude.json with {} when absent; make $HOME/.claude.json a symlink
#    to it (move an existing regular file into the volume first — never delete user data).
#    Do NOT chown -R the shared volume. Not writable -> warn and continue. TODO(O1)
link_claude_config() { :; }

main() {
  setup_path
  install_claude_wrapper
  bootstrap_packages
  link_claude_config
  # TODO(O1): date -u +%FT%TZ > /tmp/porterclaude-ready  (debug marker)

  # 5. Idle / exec. TODO(O1):
  #    - no args                          -> portable idle loop
  #    - args are exactly `sleep infinity` -> portable idle loop (busybox sleep may reject it)
  #    - otherwise                        -> exec "$@"
  #    portable idle loop: while :; do sleep 3600; done
  if [ "$#" -eq 0 ]; then
    while :; do sleep 3600; done
  fi
  exec "$@"
}

main "$@"
