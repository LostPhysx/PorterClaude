#!/usr/bin/env bash
# PorterClaude — shared recipe provisioning. OWNER: O1.
#
# CONTRACT (frozen — see docs/design/orchestration.md §2/§3):
#   * The server injects THIS file at the tar root of every recipe build context, so every
#     recipe Dockerfile does:  COPY common.sh /tmp/common.sh  &&  RUN bash /tmp/common.sh
#     No other shared file is available in a recipe context: anything else this script needs
#     it must generate itself (heredocs).
#   * Result of a successful run:
#       - apt tooling: git gh ripgrep tmux curl jq unzip (NO sudo)
#       - user `dev`, uid 1000, gid 1000, HOME=/home/dev, shell /bin/bash
#       - /home/dev/.claude, /home/dev/.claude-home, /workspace owned by 1000:1000
#       - claude installed OUTSIDE $HOME (under /opt/claude) and linked to /usr/local/bin/claude
#       - /etc/porterclaude/claude-version  (exact `claude --version`)
#       - /etc/porterclaude/recipe          (from $PORTERCLAUDE_RECIPE, may be empty)
#       - /etc/profile.d/porterclaude.sh    (PATH, TERM, COLORTERM)
#       - /usr/local/bin/pc-entrypoint.sh   (0755) — the recipe ENTRYPOINT
#   * Must be arch-neutral (amd64 + arm64): use `dpkg --print-architecture` / `uname -m`,
#     never hardcode an architecture.
#   * Must be non-interactive and idempotent. Classic builder only (no BuildKit features).
#
# Changing this file re-hashes EVERY recipe context (all six flip to `outdated`). Intended.

set -eu
export DEBIAN_FRONTEND=noninteractive

CLAUDE_INSTALL_ROOT="${CLAUDE_INSTALL_ROOT:-/opt/claude}"
DEV_USER=dev
DEV_UID=1000
DEV_GID=1000
DEV_HOME=/home/dev

log()  { printf '[porterclaude] %s\n' "$*"; }
warn() { printf '[porterclaude][warn] %s\n' "$*" >&2; }
die()  { printf '[porterclaude][error] %s\n' "$*" >&2; exit 1; }

# --- 1. base apt packages ----------------------------------------------------------------
install_packages() {
  # TODO(O1): apt-get update && apt-get install -y --no-install-recommends
  #   ca-certificates curl wget git tmux ripgrep jq unzip zip less procps psmisc
  #   openssh-client gnupg nano file xz-utils
  # then rm -rf /var/lib/apt/lists/*   (do the cleanup at the very end of the script)
  # NOTE: no sudo, on purpose.
  :
}

# --- 2. GitHub CLI (best effort; must not fail the build) --------------------------------
install_gh() {
  # TODO(O1): official apt repo, arch from `dpkg --print-architecture`:
  #   keyring -> /usr/share/keyrings/githubcli-archive-keyring.gpg
  #   deb [arch=$(dpkg --print-architecture) signed-by=...] https://cli.github.com/packages stable main
  # Wrap everything so a network/repo failure only warns.
  :
}

# --- 3. the `dev` user (uid 1000) --------------------------------------------------------
ensure_dev_user() {
  # TODO(O1):
  #   existing=$(getent passwd "$DEV_UID" | cut -d: -f1)
  #   if [ -n "$existing" ] && [ "$existing" != "$DEV_USER" ]; then
  #       usermod -l "$DEV_USER" -d "$DEV_HOME" -m "$existing"      # node:22-bookworm ships `node`
  #       groupmod -n "$DEV_USER" "<group with gid 1000>"           # when it exists
  #   elif [ -z "$existing" ]; then
  #       groupadd -g "$DEV_GID" "$DEV_USER" || true                # gid may be taken
  #       useradd -m -u "$DEV_UID" -g "$DEV_GID" -s /bin/bash "$DEV_USER"
  #   fi
  #   usermod -s /bin/bash "$DEV_USER"
  #   mkdir -p "$DEV_HOME/.claude" "$DEV_HOME/.claude-home" "$DEV_HOME/.local/bin" /workspace
  #   chown -R "$DEV_UID:$DEV_GID" "$DEV_HOME" /workspace
  # Never delete a pre-existing uid-1000 account.
  :
}

# --- 4. Claude Code (native installer, installed outside $HOME) --------------------------
install_claude() {
  # TODO(O1):
  #   mkdir -p "$CLAUDE_INSTALL_ROOT"
  #   HOME="$CLAUDE_INSTALL_ROOT" bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
  #   locate the launcher: "$CLAUDE_INSTALL_ROOT/.local/bin/claude", else
  #     find "$CLAUDE_INSTALL_ROOT" -type f -name claude -perm -u+x | head -n1
  #   ln -sf <resolved> /usr/local/bin/claude ; chmod -R a+rX "$CLAUDE_INSTALL_ROOT"
  #   /usr/local/bin/claude --version   -> /etc/porterclaude/claude-version (trimmed)
  # A failure here MUST fail the build (die).
  :
}

# --- 5. shell environment ----------------------------------------------------------------
write_profile() {
  # TODO(O1): /etc/profile.d/porterclaude.sh  (0644)
  #   export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
  #   export TERM="${TERM:-xterm-256color}"
  #   export COLORTERM=truecolor
  :
}

# --- 6. the recipe entrypoint ------------------------------------------------------------
write_entrypoint() {
  # TODO(O1): write /usr/local/bin/pc-entrypoint.sh (0755), POSIX sh, best-effort steps:
  #   HOME=${HOME:-/home/dev}
  #   mkdir -p "$HOME/.claude" "$HOME/.claude-home"
  #   [ -e "$HOME/.claude-home/.claude.json" ] || printf '{}\n' > "$HOME/.claude-home/.claude.json"
  #   if $HOME/.claude.json is a regular file -> mv it into the volume (never delete data)
  #   ln -sfn "$HOME/.claude-home/.claude.json" "$HOME/.claude.json"
  #   finally: exec "$@"   (no args, or `sleep infinity` that fails -> portable idle loop)
  # Every step wrapped so a failure only warns and never stops the container.
  :
}

# --- 7. metadata -------------------------------------------------------------------------
write_metadata() {
  # TODO(O1): mkdir -p /etc/porterclaude
  #   printf '%s\n' "${PORTERCLAUDE_RECIPE:-}" > /etc/porterclaude/recipe
  #   chmod -R a+rX /etc/porterclaude
  :
}

main() {
  log "provisioning recipe '${PORTERCLAUDE_RECIPE:-unknown}' on $(dpkg --print-architecture 2>/dev/null || uname -m)"
  install_packages
  install_gh
  ensure_dev_user
  install_claude
  write_profile
  write_entrypoint
  write_metadata
  log "done"
}

main "$@"
