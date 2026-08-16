#!/bin/sh
# TODO(O1): remove this line once the bodies below are implemented — it only silences the
# "assigned but never used / arguments never passed" warnings a skeleton necessarily has.
# shellcheck disable=SC2034,SC2119,SC2120,SC2317
# PorterClaude — session bootstrap. OWNER: O1. RUNTIME. PLANNER SKELETON for v0.2.
# Spec: docs/design/orchestration.md §14 (v0.2), §4.4 (v0.1 background).
#
# v0.2: this is the entrypoint of EVERY managed session (recipe AND custom image), not just
# custom ones. The server creates the container with:
#   entrypoint ["<toolsMount>/entrypoint.sh"]
#   cmd        ["sleep","infinity"]        (custom images only; recipes keep their image CMD)
#   env        PORTERCLAUDE_TOOLS=<toolsMount>  PORTERCLAUDE_HOME=<containerHome>  HOME=…
#              PORTERCLAUDE_SESSION=<slug>      PORTERCLAUDE_HOST=<hostId>
#              PORTERCLAUDE_AGENT_IDS=claude,opencode
#              PORTERCLAUDE_AGENT_LINKS=<target>|<source>|<kind>;<target>|<source>|<kind>
#              PATH=<toolsMount>/bin:<home>/.local/bin:<image PATH>   TERM=xterm-256color
# The tools volume is mounted READ-ONLY at $PORTERCLAUDE_TOOLS; the per-agent auth volumes
# are mounted at <home>/.porterclaude/agents/<agentId> (read-write).
#
# HARD RULES (unchanged from v0.1):
#   * strict POSIX sh — busybox/ash, dash and bash images alike; no `local`, no arrays
#   * NOTHING here may abort the container: every step logs on failure and continues
#   * no assumptions about the image user, package manager or $HOME
#
# WHAT v0.2 CHANGES (see §14): the claude-specific wiring is gone. The symlinks to create
# come from $PORTERCLAUDE_AGENT_LINKS, ownership repair covers <home>/.porterclaude, and the
# /usr/local/bin wrappers are generated per shim found in <tools>/bin.
#
# This file does NOT source <tools>/lib/pc-common.sh on purpose: it must work even when the
# volume is half-populated. The few helpers it needs are duplicated below.
set -u

TOOLS="${PORTERCLAUDE_TOOLS:-/opt/porterclaude}"

# The PATH the container was CREATED with (see v0.1 notes): the only place the image's own
# toolchain directories survive, because /etc/profile REPLACES PATH in login shells.
ORIG_PATH="${PATH:-}"

passwd_home() {
  _u="$(id -u 2>/dev/null || echo)"
  if [ -n "$_u" ] && [ -r /etc/passwd ]; then
    awk -F: -v u="$_u" '$3 == u { print $6; exit }' /etc/passwd 2>/dev/null
  fi
}

# $HOME is pinned by the server, so it is no longer evidence of what the image wanted:
# ask passwd whenever PORTERCLAUDE_HOME is set (v0.1 §4.4 step 1 — do not "simplify" this).
PASSWD_HOME="$(passwd_home 2>/dev/null || echo)"
if [ -n "${PORTERCLAUDE_HOME:-}" ]; then
  IMAGE_HOME="$PASSWD_HOME"
else
  IMAGE_HOME="${HOME:-$PASSWD_HOME}"
fi
HOME="${PORTERCLAUDE_HOME:-${IMAGE_HOME:-/root}}"
export HOME
case "$IMAGE_HOME" in
  ""|"/") IMAGE_HOME="" ;;
esac
TERM="${TERM:-xterm-256color}"
export TERM
BOOTSTRAP_LOG=/tmp/porterclaude-bootstrap.log

# v3: the persisted profile snippet is unchanged in shape, but the marker version must be
# bumped so a container bootstrapped by a v0.1/v0.2 volume gets the new block appended
# instead of being skipped by the idempotency guard.
MARKER_TAG="porterclaude (generated v3)"
MARKER="# $MARKER_TAG - do not duplicate"

# uid:gid the recipe images give their session user (docker/recipes/common.sh): the fallback
# owner of the agent volumes while they are still root-owned.
RECIPE_OWNER="1000:1000"

log()  { printf '[porterclaude] %s\n' "$*"; }
warn() { printf '[porterclaude][warn] %s\n' "$*" >&2; }

am_root() { [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; }

# Portable idle loop: some images ship a `sleep` that rejects "infinity", and a bare
# `sleep` as pid 1 ignores SIGTERM. Backgrounding it and waiting lets the trap run.
idle_forever() {
  trap 'exit 0' INT TERM
  while :; do
    sleep 3600 &
    wait $! 2>/dev/null || :
  done
}

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

# --- 1. PATH (unchanged from v0.1) --------------------------------------------------------
setup_path() {
  PATH="$(pc_path_compose "$TOOLS/bin:$HOME/.local/bin" "$ORIG_PATH" "$PATH")"
  export PATH

  files="/etc/profile.d/porterclaude.sh $HOME/.profile $HOME/.bashrc"
  if [ -n "$IMAGE_HOME" ] && [ "$IMAGE_HOME" != "$HOME" ]; then
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

# --- 2. agent link table ------------------------------------------------------------------
#
# $PORTERCLAUDE_AGENT_LINKS is `target|source|kind;target|source|kind` (server:
# agents/model.ts encodeAgentLinks). `target` is the path the agent expects inside the
# container (`/home/dev/.claude`), `source` is the path inside the mounted auth volume
# (`/home/dev/.porterclaude/agents/claude/claude`), `kind` is `dir` or `file`.
#
# for_each_link <callback> : call `<callback> <target> <source> <kind>` for every entry.
# Empty/short entries are skipped. POSIX field splitting on ';' and '|' via IFS.
for_each_link() {
  _cb="$1"
  _links="${PORTERCLAUDE_AGENT_LINKS:-}"
  [ -n "$_links" ] || return 0
  # TODO(O1): split $_links on ';', then each entry on '|', and call "$_cb" target source
  #           kind. Use `IFS=';'` in a subshell-free way (set -- $_links after IFS change)
  #           so it works in dash/ash; restore IFS afterwards. Skip entries whose target or
  #           source is empty, and normalise an unknown kind to 'dir'.
  :
}

# link_one <target> <source> <kind> : create ONE agent symlink (best effort).
#   * mkdir -p the parent of <target>
#   * kind=dir  : mkdir -p <source>
#     kind=file : seed <source> when absent — `{}` when its basename ends in `.json`,
#                 otherwise an empty file (agents rewrite these atomically, so the file must
#                 exist inside the volume before the link is used)
#   * an existing regular file/directory at <target> is PARKED ASIDE (park_aside), never
#     deleted; an existing symlink pointing elsewhere is replaced
#   * ln -s <source> <target>
# A read-only or not-yet-chowned auth volume must only produce a warning: the server chowns
# <home>/.porterclaude and re-runs us with --porterclaude-bootstrap.
link_one() {
  # TODO(O1)
  _t="$1"; _s="$2"; _k="$3"
  warn "link_one is not implemented yet ($_t -> $_s, $_k)"
  return 0
}

link_agents() {
  [ -n "${PORTERCLAUDE_AGENT_LINKS:-}" ] || {
    log "no agent links in this session"
    return 0
  }
  mkdir -p "$HOME/.porterclaude/agents" 2>/dev/null || :
  for_each_link link_one
  return 0
}

# --- 3. ownership of the agent volumes ----------------------------------------------------
#
# The auth volumes are shared by every session of ONE host and only one uid can own them.
# Recipe sessions are hard-wired to uid 1000 and cannot adapt; a root custom session can.
owner_of() {
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

# agents_owner : "uid:gid" that should own everything we write into the agent volumes —
# the first non-root owner among <home>/.porterclaude/agents/*, else $RECIPE_OWNER.
agents_owner() {
  # TODO(O1): iterate "$HOME"/.porterclaude/agents/*, use owner_of, skip empty and 0:*,
  #           print the first match; fall back to $RECIPE_OWNER.
  printf '%s' "$RECIPE_OWNER"
}

# claim_agents : root only. chown -R the agent root and every link target to agents_owner,
# then tighten obvious credential files (0600 on */\.credentials.json, auth.json, *.key).
# Non-root sessions only warn when an agent dir belongs to a foreign uid (they cannot fix it).
claim_agents() {
  if ! am_root; then
    # TODO(O1): warn once when <home>/.porterclaude/agents/<id> belongs to another uid —
    #           that is the "your image runs as the wrong user" diagnosis.
    return 0
  fi
  # TODO(O1)
  return 0
}

# --- 4. /usr/local/bin wrappers (non-login shells) ----------------------------------------
#
# Root only. For every shim in $TOOLS/bin (except pc-agent and pc-* helpers) write a 3-line
# /usr/local/bin/<name> that execs it — but ONLY when <name> does not already resolve to a
# binary outside $TOOLS (never shadow the image's own tools).
install_agent_wrappers() {
  am_root || return 0
  [ -d "$TOOLS/bin" ] || return 0
  # TODO(O1)
  return 0
}

# --- 5. bridge the image's own home -------------------------------------------------------
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
  lnk="$1"
  tgt="$2"
  if [ -L "$lnk" ] && [ "$(readlink "$lnk" 2>/dev/null || echo)" = "$tgt" ]; then
    return 0
  fi
  park_aside "$lnk" || return 0
  ln -s "$tgt" "$lnk" 2>/dev/null || warn "cannot link $lnk -> $tgt"
}

# Anything resolving `~` through the passwd entry (su -, sudo -i, os.homedir(), bash tilde
# expansion) must land on the same agent state. For every link target below $HOME, create the
# same relative path below $IMAGE_HOME pointing at the SAME source.
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
    warn "$IMAGE_HOME is not writable — agents started with HOME=$IMAGE_HOME will not see"
    warn "the shared login (run them from a terminal, where HOME=$HOME)"
    return 0
  fi
  log "bridging the image home $IMAGE_HOME -> $HOME (shared agent logins)"
  # TODO(O1): for_each_link <cb> where <cb> maps a target under $HOME to
  #           "$IMAGE_HOME/${target#$HOME/}" and calls link_to <that> <source>.
  #           Also bridge "$IMAGE_HOME/.porterclaude" -> "$HOME/.porterclaude".
  return 0
}

# --- 6. best-effort git + tmux (unchanged from v0.1) ---------------------------------------
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

main() {
  # Ownership hand-back only. Called by bin/pc-agent before and after every agent run and by
  # the server as a root exec. Silent, best effort.
  if [ "${1:-}" = "--porterclaude-share" ]; then
    claim_agents
    exit 0
  fi

  # Re-run of everything that needs a writable $HOME / a chowned agent volume. The server
  # calls this as root right after the start (backend.md §13). Idempotent.
  if [ "${1:-}" = "--porterclaude-bootstrap" ]; then
    log "re-bootstrapping session '${PORTERCLAUDE_SESSION:-unknown}' (home: $HOME)"
    setup_path
    install_agent_wrappers
    link_agents
    claim_agents
    bridge_image_home
    log "ready"
    exit 0
  fi

  log "bootstrapping session '${PORTERCLAUDE_SESSION:-unknown}' on host '${PORTERCLAUDE_HOST:-unknown}'"
  log "tools: $TOOLS, home: $HOME, image home: ${IMAGE_HOME:-none}, agents: ${PORTERCLAUDE_AGENT_IDS:-none}"
  setup_path
  install_agent_wrappers
  bootstrap_packages
  link_agents
  claim_agents
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
