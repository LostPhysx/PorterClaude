#!/usr/bin/env bash
# TODO(O1): remove this line once the bodies below are implemented — it only silences the
# "assigned but never used / arguments never passed" warnings a skeleton necessarily has.
# shellcheck disable=SC2034,SC2119,SC2120,SC2317
# PorterClaude — build-time helpers for the tools image. OWNER: O1. PLANNER SKELETON (v0.2).
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
# (`x64`/`arm64`) and of the uv release assets (`x86_64-unknown-linux-musl` /
# `aarch64-unknown-linux-musl` — built from pc_arch, never written out as a literal).
pc_node_arch() { pc_arch; }
pc_uv_target() {
  # TODO(O1): map pc_arch -> the uv asset triple without spelling an arch literal in a
  #           download URL (compose it: "${machine}-unknown-linux-musl").
  printf ''
}

# --- download -----------------------------------------------------------------------------

# pc_fetch <url> <dest> : curl with retries, a connect timeout and no progress noise.
# Returns non-zero on failure (and removes a partial file). Never prints credentials.
pc_fetch() {
  # TODO(O1): curl -fsSL --retry 3 --connect-timeout 20 -o "$2.part" "$1" && mv -f …
  return 1
}

# pc_extract <archive> <dir> [--strip N] : tar.gz / tar.xz / zip into <dir>.
pc_extract() {
  # TODO(O1)
  return 1
}

# pc_run <seconds> <cmd…> : run with a hard timeout, stdout+stderr passed through with a
# `[tools]` prefix. Returns the command's status, 124 on timeout.
pc_run() {
  # TODO(O1)
  return 1
}

# --- json ---------------------------------------------------------------------------------

# pc_json_get <json> <jq-path> : `jq -r '<path> // empty'`. The ONLY way this codebase reads
# JSON — no grep/sed parsing of the spec (a hostile agent name must not be able to change the
# meaning of a command line).
pc_json_get() {
  # TODO(O1)
  printf ''
}

# pc_sh_quote <string> : single-quote a value for safe embedding into a generated POSIX-sh
# launcher (`'` -> `'\''`). Every agent-controlled string that lands in run.sh/bin shims MUST
# go through this.
pc_sh_quote() {
  # TODO(O1)
  printf "''"
}

# --- files --------------------------------------------------------------------------------

# pc_write_exec <path> : read a script body from stdin, write it, chmod 0755.
pc_write_exec() {
  # TODO(O1)
  return 1
}

# pc_publish_dir <stage-dir> <target-dir> : the directory swap of §13.4 —
#   mv <target> <target>/../.<name>.old ; mv <stage> <target> ; rm -rf …old
# Safe while a session is executing a binary inside <target> (unlink of a running executable
# is legal; writing into it is not).
pc_publish_dir() {
  # TODO(O1)
  return 1
}

# pc_publish_file <stage-file> <target-file> : `mv -f` (rename(2)) — never `cp` over a busy
# executable (ETXTBSY).
pc_publish_file() {
  # TODO(O1)
  return 1
}
