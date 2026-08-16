#!/usr/bin/env bash
# PorterClaude — shared recipe provisioning. OWNER: O1.
#
# CONTRACT (frozen — see docs/design/orchestration.md §2/§3):
#   * The server injects THIS file at the tar root of every recipe build context, so every
#     recipe Dockerfile does:  COPY common.sh /tmp/common.sh  &&  RUN bash /tmp/common.sh
#     No other shared file is available in a recipe context: anything else this script needs
#     it must generate itself (heredocs).
#   * Result of a successful run:
#       - apt tooling: git gh ripgrep tmux curl jq unzip (deliberately NO privilege-
#         escalation helper: sessions are unprivileged)
#       - user `dev`, uid 1000, gid 1000, HOME=/home/dev, shell /bin/bash
#       - /home/dev/.claude, /home/dev/.claude/projects, /home/dev/.claude-home and
#         /workspace owned by 1000:1000  (projects must exist so that the private-history
#         volume mount cannot get a root-owned mountpoint created under it)
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
  log "apt-get update"
  apt-get update
  log "installing the base toolchain (unprivileged sessions: no escalation helper)"
  apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    git \
    tmux \
    ripgrep \
    jq \
    unzip \
    zip \
    less \
    procps \
    psmisc \
    openssh-client \
    gnupg \
    nano \
    file \
    xz-utils
}

# --- 2. GitHub CLI (best effort; must not fail the build) --------------------------------
install_gh() {
  local arch keyring listfile
  if command -v gh >/dev/null 2>&1; then
    log "gh already present"
    return 0
  fi
  keyring=/usr/share/keyrings/githubcli-archive-keyring.gpg
  listfile=/etc/apt/sources.list.d/github-cli.list
  arch="$(dpkg --print-architecture)"
  log "installing gh for architecture '$arch' (optional)"
  if ! curl -fsSL --retry 3 --connect-timeout 20 \
        https://cli.github.com/packages/githubcli-archive-keyring.gpg -o "$keyring"; then
    warn "gh: could not download the archive keyring — skipping (gh is optional)"
    rm -f "$keyring"
    return 0
  fi
  chmod a+r "$keyring"
  printf 'deb [arch=%s signed-by=%s] https://cli.github.com/packages stable main\n' \
    "$arch" "$keyring" > "$listfile"
  if apt-get update && apt-get install -y --no-install-recommends gh; then
    log "gh installed"
    return 0
  fi
  warn "gh: repository unreachable or package unavailable — continuing without gh"
  rm -f "$listfile" "$keyring"
  # restore a consistent apt state for the recipe-specific layers that come after us
  apt-get update || warn "apt-get update failed after removing the gh repository"
}

# --- 3. the `dev` user (uid 1000) --------------------------------------------------------
ensure_dev_user() {
  local existing existing_group group_name
  existing="$(getent passwd "$DEV_UID" | cut -d: -f1 || true)"
  if [ -n "$existing" ] && [ "$existing" != "$DEV_USER" ]; then
    # e.g. node:22-bookworm ships `node` on uid 1000. Rename it — never delete it.
    log "renaming pre-existing uid $DEV_UID user '$existing' to '$DEV_USER'"
    usermod -l "$DEV_USER" -d "$DEV_HOME" -m "$existing" \
      || die "could not rename user '$existing' to '$DEV_USER'"
    existing_group="$(getent group "$DEV_GID" | cut -d: -f1 || true)"
    if [ -n "$existing_group" ] && [ "$existing_group" != "$DEV_USER" ]; then
      groupmod -n "$DEV_USER" "$existing_group" \
        || warn "could not rename group '$existing_group' to '$DEV_USER'"
    fi
  elif [ -z "$existing" ]; then
    if ! getent group "$DEV_GID" >/dev/null 2>&1; then
      groupadd -g "$DEV_GID" "$DEV_USER" || warn "groupadd $DEV_USER failed"
    fi
    group_name="$(getent group "$DEV_GID" | cut -d: -f1 || true)"
    [ -n "$group_name" ] || group_name="$DEV_USER"
    log "creating user '$DEV_USER' (uid $DEV_UID, group '$group_name')"
    useradd -m -u "$DEV_UID" -g "$group_name" -s /bin/bash -d "$DEV_HOME" "$DEV_USER" \
      || die "could not create user '$DEV_USER'"
  else
    log "user '$DEV_USER' already owns uid $DEV_UID"
  fi

  usermod -s /bin/bash "$DEV_USER" || warn "could not set the login shell of '$DEV_USER'"
  usermod -d "$DEV_HOME" "$DEV_USER" || warn "could not set the home directory of '$DEV_USER'"

  # Docker copies image content *and ownership* into an empty named volume on first use:
  # that is what makes uid 1000 own the shared login volume.
  #
  # .claude/projects (Claude Code's conversation store) MUST exist in the image: when a
  # session with shareHistory=false mounts porterclaude-hist-<slug> at
  # /home/dev/.claude/projects, docker creates the missing mountpoint inside the shared
  # volume as root:root 0755, and every uid-1000 session then gets EACCES on
  # ~/.claude/projects. Shipping it in the image lets docker copy-up seed BOTH the shared
  # volume and every fresh history volume with the right owner. (The server repairs
  # pre-existing volumes - prepareHistoryVolume/ensureProjectsDir - this is the
  # clean-slate half of the same fix.)
  mkdir -p "$DEV_HOME/.claude/projects" "$DEV_HOME/.claude-home" "$DEV_HOME/.local/bin" \
           "$DEV_HOME/.config" "$DEV_HOME/.cache" /workspace
  [ -e "$DEV_HOME/.claude-home/.claude.json" ] \
    || printf '%s\n' '{}' > "$DEV_HOME/.claude-home/.claude.json"
  chown -R "$DEV_UID:$DEV_GID" "$DEV_HOME" /workspace
  chmod 0755 "$DEV_HOME"
  chmod 0700 "$DEV_HOME/.claude/projects"
}

# --- 4. Claude Code (native installer, installed outside $HOME) --------------------------
install_claude() {
  local launcher resolved version
  mkdir -p "$CLAUDE_INSTALL_ROOT" /etc/porterclaude
  # /home/dev/.claude is replaced by a shared volume at runtime, so the installer must not
  # write there: HOME points at $CLAUDE_INSTALL_ROOT for the duration of the install.
  log "installing Claude Code with the native installer (HOME=$CLAUDE_INSTALL_ROOT)"
  HOME="$CLAUDE_INSTALL_ROOT" bash -c 'curl -fsSL https://claude.ai/install.sh | bash' \
    || die "the Claude Code installer failed — a recipe without claude is useless"

  launcher=""
  if [ -x "$CLAUDE_INSTALL_ROOT/.local/bin/claude" ]; then
    launcher="$CLAUDE_INSTALL_ROOT/.local/bin/claude"
  else
    launcher="$(find "$CLAUDE_INSTALL_ROOT" -type f -name claude -perm -u+x 2>/dev/null | head -n1 || true)"
  fi
  [ -n "$launcher" ] || die "no claude binary found under $CLAUDE_INSTALL_ROOT"

  resolved="$(readlink -f "$launcher" || true)"
  [ -n "$resolved" ] || resolved="$launcher"
  ln -sfn "$resolved" /usr/local/bin/claude
  chmod -R a+rX "$CLAUDE_INSTALL_ROOT"

  version="$(HOME="$CLAUDE_INSTALL_ROOT" /usr/local/bin/claude --version 2>/dev/null \
             | head -n1 | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' || true)"
  [ -n "$version" ] || die "'claude --version' produced no output"
  printf '%s\n' "$version" > /etc/porterclaude/claude-version
  log "claude installed: $version  ($resolved)"
}

# --- 5. shell environment ----------------------------------------------------------------
write_profile() {
  # Terminals open LOGIN shells (bash -l), so profile.d is the correct hook.
  mkdir -p /etc/profile.d
  cat > /etc/profile.d/porterclaude.sh <<'PROFILE'
# PorterClaude session environment (generated by docker/recipes/common.sh).
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
export TERM="${TERM:-xterm-256color}"
export COLORTERM=truecolor
PROFILE
  chmod 0644 /etc/profile.d/porterclaude.sh
  log "wrote /etc/profile.d/porterclaude.sh"
}

# --- 6. the recipe entrypoint ------------------------------------------------------------
write_entrypoint() {
  # POSIX sh, best effort: every step logs on failure and continues. The container must
  # always come up, whatever the state of the mounted volumes.
  cat > /usr/local/bin/pc-entrypoint.sh <<'ENTRY'
#!/bin/sh
# PorterClaude recipe entrypoint (generated by docker/recipes/common.sh). POSIX sh.
# Wires the shared Claude Code config, then runs the container command.
# Nothing in here may abort the container: failures warn and continue.
set -u

HOME="${HOME:-/home/dev}"
export HOME
TERM="${TERM:-xterm-256color}"
export TERM

pc_log()  { printf '[porterclaude] %s\n' "$*"; }
pc_warn() { printf '[porterclaude][warn] %s\n' "$*" >&2; }

# Portable idle loop: some images ship a `sleep` that rejects "infinity", and a bare
# `sleep` as pid 1 ignores SIGTERM. Backgrounding it and waiting lets the trap run.
pc_idle() {
  trap 'exit 0' INT TERM
  while :; do
    sleep 3600 &
    wait $! 2>/dev/null || :
  done
}

pc_link_config() {
  vol="$HOME/.claude-home/.claude.json"
  loc="$HOME/.claude.json"

  mkdir -p "$HOME/.claude" "$HOME/.claude-home" 2>/dev/null \
    || pc_warn "cannot create $HOME/.claude / $HOME/.claude-home"
  if [ ! -d "$HOME/.claude-home" ]; then
    pc_warn "no $HOME/.claude-home — skipping the .claude.json link"
    return 0
  fi

  if [ ! -e "$vol" ]; then
    printf '%s\n' '{}' > "$vol" 2>/dev/null || pc_warn "cannot seed $vol"
  fi

  if [ -f "$loc" ] && [ ! -L "$loc" ]; then
    # never delete user data: move it into the shared volume, or park a backup beside it
    if [ ! -s "$vol" ] || [ "$(cat "$vol" 2>/dev/null)" = "{}" ]; then
      mv -f "$loc" "$vol" 2>/dev/null || pc_warn "cannot move $loc into the shared volume"
    else
      mv -f "$loc" "$loc.pc-backup" 2>/dev/null || pc_warn "cannot back up $loc"
    fi
  fi

  if [ -L "$loc" ]; then
    rm -f "$loc" 2>/dev/null || pc_warn "cannot replace the $loc symlink"
  fi
  if [ ! -e "$loc" ]; then
    ln -s "$vol" "$loc" 2>/dev/null || pc_warn "cannot link $loc -> $vol"
  fi
  return 0
}

pc_link_config
date -u +%FT%TZ > /tmp/porterclaude-ready 2>/dev/null || :

if [ "$#" -eq 0 ]; then
  pc_log "no command given — idling"
  pc_idle
fi
if [ "$#" -eq 2 ] && [ "$1" = "sleep" ] && [ "$2" = "infinity" ]; then
  pc_idle
fi
exec "$@"
ENTRY
  chmod 0755 /usr/local/bin/pc-entrypoint.sh
  log "wrote /usr/local/bin/pc-entrypoint.sh"
}

# --- 7. metadata -------------------------------------------------------------------------
write_metadata() {
  mkdir -p /etc/porterclaude
  printf '%s\n' "${PORTERCLAUDE_RECIPE:-}" > /etc/porterclaude/recipe
  chmod -R a+rX /etc/porterclaude
}

# --- 8. cleanup --------------------------------------------------------------------------
cleanup() {
  rm -rf /var/lib/apt/lists/*
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
  cleanup
  log "done"
}

main "$@"
