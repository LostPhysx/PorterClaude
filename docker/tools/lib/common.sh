#!/usr/bin/env bash
# PorterClaude — build-time helpers for the tools image. OWNER: O1. v0.2.
# Spec: docs/design/orchestration.md §13.
#
# Sourced by populate.sh, install-agents.sh, lib/kinds.sh, lib/runtime.sh and the per-agent
# overrides. Runs ONLY inside the tools image (debian:bookworm-slim): bash, curl, jq, tar,
# xz, unzip and `timeout` are guaranteed. Never sourced inside a session image — that is
# lib/pc-common.sh.
set -uo pipefail

pc_log()  { printf '[tools] %s\n' "$*"; }
pc_warn() { printf '[tools][warn] %s\n' "$*" >&2; }
pc_die()  { printf '[tools][error] %s\n' "$*" >&2; exit 2; }

# --- architecture -------------------------------------------------------------------------
# NEVER hardcode an architecture literal: CI greps for them under docker/ (§18.4).

# pc_arch : `x64` | `arm64`; empty when unknown.
pc_arch() {
  case "$(uname -m)" in
    x86*64|amd64)          printf 'x64' ;;
    aarch*64|arm64|armv8*) printf 'arm64' ;;
    *)                     printf '' ;;
  esac
}

# pc_node_arch / pc_uv_target : the same architecture in the naming schemes of nodejs.org
# (`x64`/`arm64`) and of the uv release assets (`<machine>-unknown-linux-musl`, where
# <machine> is exactly what `uname -m` prints on the two supported architectures — composed,
# never written out as a literal).
pc_node_arch() { pc_arch; }
pc_uv_target() {
  local machine
  [ -n "$(pc_arch)" ] || { printf ''; return 0; }
  machine="$(uname -m)"
  printf '%s-unknown-linux-musl' "$machine"
}

# --- download -----------------------------------------------------------------------------

# pc_fetch <url> <dest> : curl with retries, a connect timeout and no progress noise.
# Returns non-zero on failure (and removes a partial file). Never prints credentials.
pc_fetch() {
  local url="$1" dest="$2" dir status
  dir="$(dirname "$dest")"
  mkdir -p "$dir" 2>/dev/null || :
  if curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$dest.part" "$url"; then
    status=0
  else
    status=$?
  fi
  # WHY a global: a shell function can only hand back a status, but the callers have to put
  # the REASON into the agent manifest — that is what the Agents/Images cards show, and
  # "download failed" without the curl status sent QA looking for a missing url instead
  # (R2-INT2-5a). Always set, so a caller may read it after any pc_fetch.
  PC_FETCH_STATUS="curl exit $status"
  if [ "$status" -eq 0 ]; then
    if [ -s "$dest.part" ]; then
      mv -f "$dest.part" "$dest"
      return 0
    fi
    PC_FETCH_STATUS="empty response"
  fi
  rm -f "$dest.part" 2>/dev/null || :
  return 1
}

# pc_extract <archive> <dir> [strip] : tar.gz / tar.xz / zip into <dir>. `strip` (default 0)
# is the number of leading path components to drop (tar only; a zip is flattened by moving
# the single top-level directory up when strip is 1).
pc_extract() {
  local archive="$1" dir="$2" strip="${3:-0}" inner
  mkdir -p "$dir" || return 1
  case "$archive" in
    *.tar.gz|*.tgz)  tar -xzf "$archive" -C "$dir" --strip-components="$strip" || return 1 ;;
    *.tar.xz|*.txz)  tar -xJf "$archive" -C "$dir" --strip-components="$strip" || return 1 ;;
    *.tar)           tar -xf  "$archive" -C "$dir" --strip-components="$strip" || return 1 ;;
    *.zip)
      unzip -q -o "$archive" -d "$dir" || return 1
      if [ "$strip" != "0" ]; then
        inner="$(find "$dir" -mindepth 1 -maxdepth 1 -type d | head -n1)"
        if [ -n "$inner" ]; then
          (shopt -s dotglob && mv -f "$inner"/* "$dir"/ 2>/dev/null) || :
          rmdir "$inner" 2>/dev/null || :
        fi
      fi
      ;;
    *) pc_warn "unknown archive type: $archive"; return 1 ;;
  esac
  return 0
}

# pc_run <seconds> <cmd…> : run with a hard timeout, stdout+stderr passed through with a
# `[tools]` prefix. Returns the command's status, 124 on timeout.
pc_run() {
  local secs="$1" st
  shift
  if timeout "$secs" "$@" 2>&1 | sed 's/^/[tools] /'; then
    st=0
  else
    st=$?
  fi
  return "$st"
}

# --- json ---------------------------------------------------------------------------------

# pc_json_get <json> <jq-path> : `jq -r '<path> // empty'`. The ONLY way this codebase reads
# JSON — no grep/sed parsing of the spec (a hostile agent name must not be able to change the
# meaning of a command line).
pc_json_get() {
  printf '%s' "$1" | jq -r "($2) // empty" 2>/dev/null || printf ''
}

# pc_sh_quote <string> : single-quote a value for safe embedding into a generated POSIX-sh
# launcher (`'` -> `'\''`). Every agent-controlled string that lands in run.sh/bin shims MUST
# go through this.
pc_sh_quote() {
  printf "'%s'" "$(printf '%s' "${1:-}" | sed "s/'/'\\''/g")"
}

# --- files --------------------------------------------------------------------------------

# pc_write_exec <path> : read a script body from stdin, write it, chmod 0755.
pc_write_exec() {
  local path="$1"
  mkdir -p "$(dirname "$path")" || return 1
  cat > "$path" || return 1
  chmod 0755 "$path" || return 1
  return 0
}

# pc_publish_dir <stage-dir> <target-dir> : the directory swap of §13.4 —
#   mv <target> <target>/../.<name>.old ; mv <stage> <target> ; rm -rf …old
# Safe while a session is executing a binary inside <target> (unlink of a running executable
# is legal; writing into it is not).
pc_publish_dir() {
  local stage="$1" target="$2" name parent old
  [ -d "$stage" ] || { pc_warn "publish: $stage does not exist"; return 1; }
  name="$(basename "$target")"
  parent="$(dirname "$target")"
  old="$parent/.$name.old"
  mkdir -p "$parent" || return 1
  rm -rf "$old" 2>/dev/null || :
  if [ -e "$target" ]; then
    mv "$target" "$old" || { pc_warn "publish: cannot move $target aside"; return 1; }
  fi
  if ! mv "$stage" "$target"; then
    pc_warn "publish: cannot move $stage into place"
    [ -e "$old" ] && mv "$old" "$target" 2>/dev/null
    return 1
  fi
  rm -rf "$old" 2>/dev/null || :
  return 0
}

# pc_publish_file <stage-file> <target-file> : `mv -f` (rename(2)) — never `cp` over a busy
# executable (ETXTBSY).
pc_publish_file() {
  local stage="$1" target="$2"
  [ -f "$stage" ] || { pc_warn "publish: $stage does not exist"; return 1; }
  mkdir -p "$(dirname "$target")" || return 1
  mv -f "$stage" "$target" || { pc_warn "publish: cannot rename $stage -> $target"; return 1; }
  return 0
}
