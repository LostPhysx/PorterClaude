#!/bin/sh
# PorterClaude — sh helpers shared by the RUNTIME payload. OWNER: O1. v0.2.
# Spec: docs/design/orchestration.md §13.1 / §13.7.
#
# This file SHIPS INSIDE THE TOOLS VOLUME (<toolsMount>/lib/pc-common.sh) and is sourced by
# bin/pc-agent, by the generated agents/<id>/run.sh launchers and by entrypoint.sh. It
# therefore runs inside ARBITRARY session images: strict POSIX sh (busybox ash / dash), no
# bashisms, no GNU-only flags, no `local`, and nothing here may exit the caller.
#
# Every function is prefixed `pc_` and touches only variables prefixed `_pc_` or `PC_`.

# ---------------------------------------------------------------------------------------
# logging
# ---------------------------------------------------------------------------------------
pc_log()  { printf '[porterclaude] %s\n' "$*"; }
pc_warn() { printf '[porterclaude][warn] %s\n' "$*" >&2; }
pc_err()  { printf '[porterclaude][error] %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------------------
# architecture / libc detection  (§13.7 — NEVER hardcode an architecture literal)
# ---------------------------------------------------------------------------------------

# pc_arch : prints `x64` | `arm64`, or nothing when the machine is unknown.
pc_arch() {
  case "$(uname -m 2>/dev/null || echo)" in
    x86*64|amd64)          printf 'x64' ;;
    aarch*64|arm64|armv8*) printf 'arm64' ;;
    *)                     printf '' ;;
  esac
}

# pc_is_musl : 0 when this container's libc is musl.
pc_is_musl() {
  if ls /lib/ld-musl-* >/dev/null 2>&1; then return 0; fi
  if ldd --version 2>&1 | grep -qi musl; then return 0; fi
  return 1
}

# pc_libc : prints `musl` | `glibc`.
pc_libc() {
  if pc_is_musl; then printf 'musl'; else printf 'glibc'; fi
}

# pc_target : prints the payload target name, e.g. `linux-arm64` / `linux-x64-musl`.
# Empty when the architecture is unknown (callers must handle that with a clear message).
pc_target() {
  _pc_a="$(pc_arch)"
  [ -n "$_pc_a" ] || { printf ''; return 0; }
  if pc_is_musl; then printf 'linux-%s-musl' "$_pc_a"; else printf 'linux-%s' "$_pc_a"; fi
}

# ---------------------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------------------

# pc_tools_root <argv0> : the tools mount root. $PORTERCLAUDE_TOOLS wins; otherwise it is
# derived from the caller's own location (a shim lives in <root>/bin, a launcher in
# <root>/agents/<id>), which is what makes the payload relocatable.
pc_tools_root() {
  if [ -n "${PORTERCLAUDE_TOOLS:-}" ]; then
    printf '%s' "${PORTERCLAUDE_TOOLS%/}"
    return 0
  fi
  # No `readlink -f`: it is not portable to every busybox. Walk up from the caller's own
  # directory instead and stop at the first level that looks like the payload root, so the
  # same helper works for a shim (<root>/bin/x) and for a launcher (<root>/agents/<id>/x).
  _pc_d="$(CDPATH='' cd -- "$(dirname -- "${1:-$0}")" 2>/dev/null && pwd)"
  if [ -z "$_pc_d" ]; then
    printf '%s' '/opt/porterclaude'
    return 0
  fi
  _pc_n=0
  while [ "$_pc_n" -lt 4 ]; do
    _pc_d="$(CDPATH='' cd -- "$_pc_d/.." 2>/dev/null && pwd)"
    [ -n "$_pc_d" ] || break
    if [ -f "$_pc_d/entrypoint.sh" ] || [ -f "$_pc_d/AGENTS.json" ]; then
      printf '%s' "${_pc_d%/}"
      return 0
    fi
    [ "$_pc_d" != '/' ] || break
    _pc_n=$((_pc_n + 1))
  done
  printf '%s' '/opt/porterclaude'
}

# pc_path_compose <colon-list> ... : join PATH-like lists, dropping empty and duplicate
# entries (first occurrence wins). Copied verbatim into the persisted profile snippet by
# entrypoint.sh — keep the two in sync.
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
