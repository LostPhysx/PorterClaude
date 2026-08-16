#!/bin/sh
# PorterClaude — bootstrap entrypoint for CUSTOM session images. OWNER: O1. RUNTIME.
#
# The server starts custom-image sessions with:
#   entrypoint ["/opt/porterclaude/entrypoint.sh"]   cmd ["sleep","infinity"]
#   env PORTERCLAUDE_TOOLS=/opt/porterclaude  PORTERCLAUDE_HOME=/home/dev
#       HOME=/home/dev  PORTERCLAUDE_SESSION=<slug>
# /opt/porterclaude is the shared tools volume, mounted READ-ONLY.
#
# HARD RULES (docs/design/orchestration.md §4.4):
#   * strict POSIX sh — this runs inside busybox/ash, dash and bash images alike
#   * NOTHING here may abort the container: every step logs on failure and continues
#   * no assumptions about the image user, package manager, or $HOME
#
# $HOME vs $PORTERCLAUDE_HOME: the shared login volumes are mounted at $PORTERCLAUDE_HOME
# (porterclaude-claude -> $PORTERCLAUDE_HOME/.claude, porterclaude-claude-home ->
# $PORTERCLAUDE_HOME/.claude-home). Custom images bring their own user home (/root for the
# root images most people pick), and runc derives HOME from the image's passwd entry unless
# the server pins it. If we honoured that home, claude would store its credentials outside
# the shared volumes and "log in once, every session authenticated" (PLAN.md) would break.
# So: PORTERCLAUDE_HOME WINS, and the image's own home is bridged into it with symlinks for
# anything that resolves ~ through passwd instead of $HOME.
#
# OWNERSHIP: those shared volumes are used by EVERY session of an installation, but only one
# uid can own them. The recipe images hard-wire their session user to uid 1000 and cannot
# adapt; a root custom image can — so root adapts (section 4 below): everything this script
# and `claude` write into the shared volumes is handed over to the volume's owner.
set -u

TOOLS="${PORTERCLAUDE_TOOLS:-/opt/porterclaude}"

# The PATH the container was CREATED with. The server pins <tools>/bin + the image's own ENV
# PATH there (sessions/container.ts composeToolsPath), so this variable is the only place the
# image's toolchain directories (/usr/local/go/bin, /usr/local/cargo/bin, /usr/local/openjdk/bin,
# ...) survive: login shells source /etc/profile, which on Debian & co REPLACES PATH with a
# fixed list. setup_path() below bakes this value into the persisted profile snippets, so that
# `which go` in a terminal of a golang:* custom session finds the toolchain again.
ORIG_PATH="${PATH:-}"

# The home the image's passwd entry gives our uid — /root for the root images most people
# pick. This is what `su -`, `sudo -i`, login(1) and every getpwuid() caller resolve `~` to,
# no matter what $HOME says.
passwd_home() {
  _u="$(id -u 2>/dev/null || echo)"
  if [ -n "$_u" ] && [ -r /etc/passwd ]; then
    awk -F: -v u="$_u" '$3 == u { print $6; exit }' /etc/passwd 2>/dev/null
  fi
}

# The home the image itself would use. The server PINS HOME=$PORTERCLAUDE_HOME in the
# container env (so that `docker exec`ed terminals agree with us), which means $HOME is no
# longer evidence of what the image wanted: whenever PORTERCLAUDE_HOME is set we must ask
# passwd instead, or the bridge below silently turns into a no-op and `su -` lands in an
# unlinked /root. Without PORTERCLAUDE_HOME, $HOME is the image's own answer and wins.
PASSWD_HOME="$(passwd_home 2>/dev/null || echo)"
if [ -n "${PORTERCLAUDE_HOME:-}" ]; then
  IMAGE_HOME="$PASSWD_HOME"
else
  IMAGE_HOME="${HOME:-$PASSWD_HOME}"
fi
HOME="${PORTERCLAUDE_HOME:-${IMAGE_HOME:-/root}}"
export HOME
# "/" is a home in some minimal images; we do not scatter dotfiles into the root filesystem.
case "$IMAGE_HOME" in
  ""|"/") IMAGE_HOME="" ;;
esac
TERM="${TERM:-xterm-256color}"
export TERM
BOOTSTRAP_LOG=/tmp/porterclaude-bootstrap.log
# v2: the persisted snippet now also restores the image's own PATH (see setup_path). The
# version is part of the marker on purpose — a container bootstrapped by an older tools
# volume gets the new block appended instead of being skipped by the idempotency guard.
MARKER_TAG="porterclaude (generated v2)"
MARKER="# $MARKER_TAG - do not duplicate"

# uid:gid the recipe images give their session user (docker/recipes/common.sh). It is the
# canonical owner of the shared login volumes while they are still root-owned.
RECIPE_OWNER="1000:1000"
log()  { printf '[porterclaude] %s\n' "$*"; }
warn() { printf '[porterclaude][warn] %s\n' "$*" >&2; }

am_root() {
  [ "$(id -u 2>/dev/null || echo 1)" = "0" ]
}

# Portable idle loop: some images ship a `sleep` that rejects "infinity", and a bare
# `sleep` as pid 1 ignores SIGTERM. Backgrounding it and waiting lets the trap run.
idle_forever() {
  trap 'exit 0' INT TERM
  while :; do
    sleep 3600 &
    wait $! 2>/dev/null || :
  done
}

# pc_path_compose <colon-list> ... : join the lists, dropping empty and duplicate entries
# (first occurrence wins). Same helper the generated profile snippet carries.
pc_path_compose() {
  _new=''
  for _p in "$@"; do
    _rest="$_p"
    while [ -n "$_rest" ]; do
      case "$_rest" in
        *:*) _d="${_rest%%:*}"; _rest="${_rest#*:}" ;;
        *)   _d="$_rest";       _rest='' ;;
      esac
      [ -n "$_d" ] || continue
      case ":$_new:" in
        *":$_d:"*) continue ;;
      esac
      if [ -n "$_new" ]; then _new="$_new:$_d"; else _new="$_d"; fi
    done
  done
  printf '%s' "$_new"
}

# The block appended to every rc/profile file. $TOOLS and the image PATH are baked in as
# literals (they must survive /etc/profile's PATH reset), $HOME stays dynamic.
path_snippet() {
  printf '%s\n' "$MARKER"
  cat <<'SNIPPET'
pc_path_compose() {
  _new=''
  for _p in "$@"; do
    _rest="$_p"
    while [ -n "$_rest" ]; do
      case "$_rest" in
        *:*) _d="${_rest%%:*}"; _rest="${_rest#*:}" ;;
        *)   _d="$_rest";       _rest='' ;;
      esac
      [ -n "$_d" ] || continue
      case ":$_new:" in
        *":$_d:"*) continue ;;
      esac
      if [ -n "$_new" ]; then _new="$_new:$_d"; else _new="$_d"; fi
    done
  done
  printf '%s' "$_new"
}
SNIPPET
  # single quotes would break the assignments; no real PATH entry contains one
  printf "PORTERCLAUDE_TOOLS='%s'\n" "$(printf '%s' "$TOOLS" | tr -d "'")"
  printf "PORTERCLAUDE_IMAGE_PATH='%s'\n" "$(printf '%s' "$ORIG_PATH" | tr -d "'")"
  cat <<'SNIPPET'
export PORTERCLAUDE_TOOLS PORTERCLAUDE_IMAGE_PATH
PATH="$(pc_path_compose "$PORTERCLAUDE_TOOLS/bin:$HOME/.local/bin" \
                        "$PORTERCLAUDE_IMAGE_PATH" "$PATH")"
export PATH
export TERM="${TERM:-xterm-256color}"
export COLORTERM=truecolor
SNIPPET
}

# 1. PATH: $TOOLS/bin first, then the image's own PATH ($ORIG_PATH — see the top of this
#    file), persisted for the login shells the terminals open. Without the $ORIG_PATH part
#    a terminal in e.g. a golang:1.23-bookworm session has no `go`: /etc/profile throws the
#    image's ENV PATH away and only what we persist here comes back.
setup_path() {
  PATH="$(pc_path_compose "$TOOLS/bin:$HOME/.local/bin" "$ORIG_PATH" "$PATH")"
  export PATH

  files="/etc/profile.d/porterclaude.sh $HOME/.profile $HOME/.bashrc"
  if [ -n "$IMAGE_HOME" ] && [ "$IMAGE_HOME" != "$HOME" ]; then
    # a shell started with the image's own HOME must still find $TOOLS/bin
    files="$files $IMAGE_HOME/.profile $IMAGE_HOME/.bashrc"
  fi
  # shellcheck disable=SC2086  # deliberate word splitting over the list above
  for f in $files; do
    d=$(dirname "$f")
    if [ ! -d "$d" ]; then
      mkdir -p "$d" 2>/dev/null || continue
    fi
    if [ -f "$f" ] && grep -qF "$MARKER_TAG" "$f" 2>/dev/null; then
      continue
    fi
    path_snippet >> "$f" 2>/dev/null || warn "cannot persist PATH in $f"
  done
}

# 2. Non-login shells: a tiny wrapper on the standard PATH (root only). It execs the
#    dispatcher of the tools volume, which is also what does the ownership hand-back of
#    section 4 after claude exits (fetch-claude.sh, write_dispatcher).
install_claude_wrapper() {
  am_root || return 0
  [ -d /usr/local/bin ] || mkdir -p /usr/local/bin 2>/dev/null || return 0
  [ -w /usr/local/bin ] || return 0
  {
    printf '#!/bin/sh\n'
    printf '%s\n' "$MARKER"
    printf 'exec "%s/bin/claude" "$@"\n' "$TOOLS"
  } > /usr/local/bin/claude 2>/dev/null || {
    warn "cannot write /usr/local/bin/claude"
    return 0
  }
  chmod 0755 /usr/local/bin/claude 2>/dev/null || :
}

# 3. Best-effort install of git + tmux. Root only, missing packages only, hard timeout,
#    everything logged into $BOOTSTRAP_LOG so it never pollutes the terminal.
bootstrap_packages() {
  need=""
  for p in git tmux; do
    command -v "$p" >/dev/null 2>&1 || need="$need $p"
  done
  if [ -z "$need" ]; then
    log "git and tmux are already present"
    return 0
  fi
  if ! am_root; then
    log "degraded: not root, cannot install:$need"
    return 0
  fi

  TO=""
  if command -v timeout >/dev/null 2>&1; then
    TO="timeout 300"
  fi
  log "installing (best effort):$need — log: $BOOTSTRAP_LOG"

  # shellcheck disable=SC2086  # $TO and $need are deliberately word-split
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive $TO apt-get update >>"$BOOTSTRAP_LOG" 2>&1 \
      && DEBIAN_FRONTEND=noninteractive $TO apt-get install -y --no-install-recommends $need \
         >>"$BOOTSTRAP_LOG" 2>&1 \
      || warn "apt-get could not install:$need (see $BOOTSTRAP_LOG)"
  elif command -v apk >/dev/null 2>&1; then
    $TO apk add --no-cache $need >>"$BOOTSTRAP_LOG" 2>&1 \
      || warn "apk could not install:$need (see $BOOTSTRAP_LOG)"
  elif command -v dnf >/dev/null 2>&1; then
    $TO dnf install -y $need >>"$BOOTSTRAP_LOG" 2>&1 \
      || warn "dnf could not install:$need (see $BOOTSTRAP_LOG)"
  elif command -v microdnf >/dev/null 2>&1; then
    $TO microdnf install -y $need >>"$BOOTSTRAP_LOG" 2>&1 \
      || warn "microdnf could not install:$need (see $BOOTSTRAP_LOG)"
  elif command -v yum >/dev/null 2>&1; then
    $TO yum install -y $need >>"$BOOTSTRAP_LOG" 2>&1 \
      || warn "yum could not install:$need (see $BOOTSTRAP_LOG)"
  elif command -v zypper >/dev/null 2>&1; then
    $TO zypper --non-interactive install $need >>"$BOOTSTRAP_LOG" 2>&1 \
      || warn "zypper could not install:$need (see $BOOTSTRAP_LOG)"
  elif command -v pacman >/dev/null 2>&1; then
    $TO pacman -Sy --noconfirm $need >>"$BOOTSTRAP_LOG" 2>&1 \
      || warn "pacman could not install:$need (see $BOOTSTRAP_LOG)"
  else
    log "degraded: no package manager — terminals work, tmux persistence does not"
    return 0
  fi

  still=""
  for p in git tmux; do
    command -v "$p" >/dev/null 2>&1 || still="$still $p"
  done
  if [ -n "$still" ]; then
    log "degraded: still missing:$still"
  else
    log "git and tmux are available"
  fi
  return 0
}

# 4. Ownership of the shared login volumes.
#
#    porterclaude-claude -> $HOME/.claude and porterclaude-claude-home -> $HOME/.claude-home
#    are shared by every session of an installation and only ONE uid can own them. Recipe
#    sessions are hard-wired to uid 1000 (docker/recipes/common.sh) and cannot adapt, a root
#    custom session can: we take the current owner of the volume root as the owner of
#    everything written there and fall back to the recipes' 1000:1000 while the volume is
#    still root-owned (fresh install whose FIRST session is a root custom image — docker
#    cannot copy-up a home the image does not have, so the volume root stays root:root).
#    Without this, a login performed in a root session leaves .credentials.json,
#    settings.json and sessions/ root-owned and "log in once, every session is
#    authenticated" only holds when the login happened in a uid-1000 session.
#    Non-root sessions cannot chown anything: they only get a warning.
owner_of() {
  # "uid:gid" of $1 as numbers; empty when it cannot be determined.
  _o=""
  if command -v stat >/dev/null 2>&1; then
    _o="$(stat -c '%u:%g' "$1" 2>/dev/null || echo)"
  fi
  case "$_o" in
    ''|*[!0-9:]*) _o="$(ls -ldn "$1" 2>/dev/null | awk 'NR == 1 { print $3 ":" $4 }')" ;;
  esac
  case "$_o" in
    ''|*[!0-9:]*) _o="" ;;
  esac
  printf '%s' "$_o"
}

shared_owner() {
  for _d in "$HOME/.claude" "$HOME/.claude-home"; do
    _o="$(owner_of "$_d")"
    case "$_o" in
      ''|0:*) continue ;;
    esac
    printf '%s' "$_o"
    return 0
  done
  printf '%s' "$RECIPE_OWNER"
}

warn_foreign_shared() {
  _me="$(id -u 2>/dev/null || echo)"
  _o="$(owner_of "$HOME/.claude")"
  [ -n "$_me" ] && [ -n "$_o" ] || return 0
  [ "${_o%%:*}" = "$_me" ] && return 0
  warn "$HOME/.claude belongs to uid ${_o%%:*} but this session runs as uid $_me:"
  warn "claude may not be able to store its login (run this image as root or as uid ${_o%%:*})"
  return 0
}

claim_shared() {
  if ! am_root; then
    warn_foreign_shared
    return 0
  fi
  own="$(shared_owner)"
  case "$own" in
    ''|0:*) return 0 ;;
  esac
  for d in "$HOME/.claude" "$HOME/.claude-home"; do
    [ -e "$d" ] || continue
    chown -R "$own" "$d" 2>/dev/null || warn "cannot hand $d over to uid ${own%%:*}"
  done
  # the credentials stay private to that uid (chown -R keeps the mode, this is belt & braces)
  if [ -f "$HOME/.claude/.credentials.json" ]; then
    chmod 0600 "$HOME/.claude/.credentials.json" 2>/dev/null || :
  fi
  return 0
}

# 5. Shared Claude Code config: ~/.claude.json is a symlink into the shared volume.
#    Anything seeded here is handed to the volume's owner by claim_shared afterwards.
link_claude_config() {
  vol="$HOME/.claude-home/.claude.json"
  loc="$HOME/.claude.json"

  mkdir -p "$HOME/.claude" "$HOME/.claude-home" 2>/dev/null \
    || warn "cannot create $HOME/.claude / $HOME/.claude-home"
  if [ ! -d "$HOME/.claude-home" ]; then
    warn "no $HOME/.claude-home — skipping the .claude.json link"
    return 0
  fi

  if [ ! -e "$vol" ]; then
    printf '%s\n' '{}' > "$vol" 2>/dev/null || warn "cannot seed $vol (read-only volume?)"
  fi

  if [ -f "$loc" ] && [ ! -L "$loc" ]; then
    # never delete user data: move it into the volume, or park a backup beside it
    if [ ! -s "$vol" ] || [ "$(cat "$vol" 2>/dev/null)" = "{}" ]; then
      mv -f "$loc" "$vol" 2>/dev/null || warn "cannot move $loc into the shared volume"
    else
      mv -f "$loc" "$loc.pc-backup" 2>/dev/null || warn "cannot back up $loc"
    fi
  fi

  if [ -L "$loc" ]; then
    rm -f "$loc" 2>/dev/null || warn "cannot replace the $loc symlink"
  fi
  if [ ! -e "$loc" ]; then
    ln -s "$vol" "$loc" 2>/dev/null || warn "cannot link $loc -> $vol"
  fi
  return 0
}

# 6. Bridge the image's own home into $PORTERCLAUDE_HOME.
#    HOME is pinned above, but plenty of code resolves `~` through the passwd entry (bash's
#    tilde expansion after `su`, node's os.homedir(), sudo -i, ...). Rather than duplicate
#    state there, point the two paths that matter at the shared volumes with symlinks.
#    Never delete anything the image shipped: pre-existing files/dirs are moved aside.
park_aside() {
  # $1 = path to free up. Returns 0 when the path is gone, 1 when it must be left alone.
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then
    return 0
  fi
  if [ -L "$1" ]; then
    rm -f "$1" 2>/dev/null && return 0
    warn "cannot replace the symlink $1"
    return 1
  fi
  bak="$1.pc-backup"
  if [ -e "$bak" ]; then
    bak="$1.pc-backup.$$"
  fi
  if mv -f "$1" "$bak" 2>/dev/null; then
    log "moved $1 aside to $bak"
    return 0
  fi
  warn "cannot move $1 aside — leaving it as it is"
  return 1
}

link_to() {
  # $1 = link path, $2 = target inside $HOME
  lnk="$1"
  tgt="$2"
  if [ -L "$lnk" ] && [ "$(readlink "$lnk" 2>/dev/null || echo)" = "$tgt" ]; then
    return 0
  fi
  park_aside "$lnk" || return 0
  ln -s "$tgt" "$lnk" 2>/dev/null || warn "cannot link $lnk -> $tgt"
}

bridge_image_home() {
  [ -n "$IMAGE_HOME" ] || return 0
  [ "$IMAGE_HOME" != "$HOME" ] || return 0
  if [ ! -d "$IMAGE_HOME" ]; then
    mkdir -p "$IMAGE_HOME" 2>/dev/null || {
      warn "cannot create the image home $IMAGE_HOME — skipping the bridge"
      return 0
    }
  fi
  if [ ! -w "$IMAGE_HOME" ]; then
    warn "$IMAGE_HOME is not writable — claude started with HOME=$IMAGE_HOME would not"
    warn "see the shared login (run it from a terminal, where HOME=$HOME)"
    return 0
  fi
  log "bridging the image home $IMAGE_HOME -> $HOME (shared claude login)"
  link_to "$IMAGE_HOME/.claude"      "$HOME/.claude"
  link_to "$IMAGE_HOME/.claude-home" "$HOME/.claude-home"
  link_to "$IMAGE_HOME/.claude.json" "$HOME/.claude-home/.claude.json"
  return 0
}

main() {
  # Called by the claude dispatcher of the tools volume before and after every claude run
  # (fetch-claude.sh, write_dispatcher) and usable from the server: hand whatever claude
  # wrote in the shared volumes back to their owner. Silent, best effort, root only.
  if [ "${1:-}" = "--porterclaude-share" ]; then
    claim_shared
    exit 0
  fi

  # Re-run of the steps that need a writable $HOME. Docker creates the mountpoint parent
  # $PORTERCLAUDE_HOME as root:root, so in an image that runs as a non-root user the first
  # run above cannot write $HOME/.profile, $HOME/.bashrc or the $HOME/.claude.json symlink.
  # The server therefore chowns $PORTERCLAUDE_HOME as root right after the start and calls
  # us again with this flag (backend.md section 7, "non-root custom images"). Idempotent.
  if [ "${1:-}" = "--porterclaude-bootstrap" ]; then
    log "re-bootstrapping session '${PORTERCLAUDE_SESSION:-unknown}' (home: $HOME)"
    setup_path
    install_claude_wrapper
    link_claude_config
    claim_shared
    bridge_image_home
    log "ready"
    exit 0
  fi

  log "bootstrapping session '${PORTERCLAUDE_SESSION:-unknown}' (tools: $TOOLS, home: $HOME, image home: ${IMAGE_HOME:-none})"
  setup_path
  install_claude_wrapper
  bootstrap_packages
  link_claude_config
  claim_shared
  bridge_image_home
  date -u +%FT%TZ > /tmp/porterclaude-ready 2>/dev/null || :
  log "ready"

  if [ "$#" -eq 0 ]; then
    idle_forever
  fi
  if [ "$#" -eq 2 ] && [ "$1" = "sleep" ] && [ "$2" = "infinity" ]; then
    # busybox sleep rejects "infinity": use the portable loop instead of exec'ing it
    idle_forever
  fi
  exec "$@"
}

main "$@"
