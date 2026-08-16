#!/usr/bin/env bash
# TODO(O1): remove this line once the bodies below are implemented — it only silences the
# "assigned but never used / arguments never passed" warnings a skeleton necessarily has.
# shellcheck disable=SC2034,SC2119,SC2120,SC2317
# PorterClaude — the agent driver. OWNER: O1. PLANNER SKELETON (v0.2).
# Spec: docs/design/orchestration.md §13.3, §13.5, §13.6, §13.9.
#
# Runs ONLY inside the tools image (debian:bookworm-slim, bash + jq + curl + tar available),
# called by populate.sh after the static payload has been staged. It:
#   1. parses $PORTERCLAUDE_AGENTS (JSON AgentInstallSpec[], server/src/agents/model.ts),
#   2. installs / carries over / drops one agent directory per spec under $MOUNT/agents,
#   3. writes the shims ($MOUNT/bin/<command> + bin/pc-agent) and $MOUNT/AGENTS.json,
#   4. mirrors claude's version into $MOUNT/VERSION (v0.1 compatibility).
#
# EXIT CODE: 0 unless the manifest itself could not be written or $PORTERCLAUDE_AGENTS is not
# valid JSON. A single agent failing is a WARNING (installed:false + error in the manifest).
#
# --plan : parse, validate and PRINT what would happen; touch no file, reach no network,
#          exit 0. CI runs this (orchestration.md §16) — keep it side-effect free.
set -euo pipefail

# $0-relative: the tools image mirrors docker/tools at /opt/pc-tools, so the same layout
# works in the image and from a checkout (CI runs --plan from the repo).
PC_TOOLS_SRC="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=lib/common.sh
. "$PC_TOOLS_SRC/lib/common.sh"
# shellcheck source=lib/kinds.sh
. "$PC_TOOLS_SRC/lib/kinds.sh"
# shellcheck source=lib/runtime.sh
. "$PC_TOOLS_SRC/lib/runtime.sh"

MOUNT="${PORTERCLAUDE_TOOLS_MOUNT:-/opt/porterclaude}"   # symlinked to the stage by populate.sh
AGENTS_JSON="${PORTERCLAUDE_AGENTS:-[]}"
FORCE="${PORTERCLAUDE_TOOLS_FORCE:-0}"
AGENT_TIMEOUT="${PORTERCLAUDE_AGENT_TIMEOUT:-900}"
OVERRIDE_DIR="$PC_TOOLS_SRC/agents"
PLAN=0

usage() {
  cat <<'USAGE'
usage: install-agents.sh [--plan]
  env: PORTERCLAUDE_AGENTS       JSON AgentInstallSpec[]        (default: [])
       PORTERCLAUDE_TOOLS_MOUNT  runtime path of the payload    (default: /opt/porterclaude)
       PORTERCLAUDE_TOOLS_FORCE  1 = reinstall everything       (default: 0)
       PORTERCLAUDE_AGENT_TIMEOUT seconds per agent             (default: 900)
USAGE
}

# ------------------------------------------------------------------------------------------
# spec handling
# ------------------------------------------------------------------------------------------

# validate_specs : jq-validate $AGENTS_JSON. Must be an array of objects with a slug `id`, a
# non-empty `command`, an `install.kind` in script|npm|pip|binary and a non-empty
# `versionCommand` array. A violation is FATAL (exit 2) — it can only be a server bug.
validate_specs() {
  # TODO(O1)
  :
}

# spec_count / spec_at <i> / spec_field <spec> <path> : jq accessors. Keep every JSON read in
# these three functions so the rest of the script never parses JSON by hand.
spec_count() { : ; }   # TODO(O1): jq 'length'
spec_at()    { : ; }   # TODO(O1): jq -c ".[$1]"
spec_field() { : ; }   # TODO(O1): jq -r "$2 // empty" <<<"$1"

# carry_over <id> <spec> : 0 when the agent already sits in the volume with an identical
# SPEC.json, a non-empty VERSION and no ERROR file, and $FORCE is 0. The caller then `cp -a`s
# $OUT/agents/<id> into the stage instead of installing it again (§13.3).
carry_over() {
  # TODO(O1)
  return 1
}

# install_one <spec> : the per-agent pipeline.
#   * AGENT_ID / AGENT_COMMAND / AGENT_DIR ($MOUNT/agents/<id>) / AGENT_SPEC / ARCH / TARGET
#     are exported for the installer (§13.9)
#   * an override in $OVERRIDE_DIR/<id>.sh wins over the kind installer: source it and call
#     `pc_agent_install_<id>`
#   * otherwise dispatch on install.kind -> pc_install_script | _npm | _pip | _binary
#   * the call is wrapped in `timeout "$AGENT_TIMEOUT"`; a timeout is an ordinary failure
#   * on success: write SPEC.json, run the version probe, write VERSION
#     on failure : write ERROR (one line, no secrets) and keep going
# Returns 0/1; never exits.
install_one() {
  # TODO(O1)
  return 1
}

# version_of <id> : run the agent's versionCommand THROUGH the generated shim
# ("$MOUNT/bin/<command>" …) with a short timeout and a scratch HOME, print the first line
# trimmed. Empty when it fails — that is not an install failure (§17).
version_of() {
  # TODO(O1)
  printf ''
}

# ------------------------------------------------------------------------------------------
# shims (§13.6)
# ------------------------------------------------------------------------------------------

# write_pc_agent : $MOUNT/bin/pc-agent — the ONE shim implementation. POSIX sh. It sources
# $TOOLS/lib/pc-common.sh, refuses a missing agents/<id>/run.sh with exit 127 and the
# "…not installed on this host — Settings → Images → Sync tools" message, calls
# `$TOOLS/entrypoint.sh --porterclaude-share` before and after the run and propagates the
# exit status.
write_pc_agent() {
  # TODO(O1)
  :
}

# write_shim <id> <command> : $MOUNT/bin/<command>, 0755, POSIX sh, three lines:
#   #!/bin/sh
#   PORTERCLAUDE_AGENT_ID=<id>; export PORTERCLAUDE_AGENT_ID
#   exec "$(dirname "$0")/pc-agent" "$@"
# Collision rule (§13.6): the FIRST spec claiming a command keeps the shim; a later one is
# recorded with error "command '<cmd>' is already provided by agent '<id>'".
write_shim() {
  # TODO(O1)
  :
}

# ------------------------------------------------------------------------------------------
# manifest (§13.5)
# ------------------------------------------------------------------------------------------

# write_manifest : $MOUNT/AGENTS.json via `jq -n`, matching ToolsAgentManifest EXACTLY:
#   { "syncedAt": <iso>, "agents": [ {id, command, installed, version, error} ] }
# and $MOUNT/VERSION = the claude entry's version (empty file when claude is absent).
write_manifest() {
  # TODO(O1)
  :
}

main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --plan) PLAN=1 ;;
      -h|--help) usage; exit 0 ;;
      *) pc_die "unknown argument: $1" ;;
    esac
    shift
  done

  validate_specs

  if [ "$PLAN" = "1" ]; then
    # TODO(O1): print one line per spec — "<id> (<command>): <kind> <package/url> -> agents/<id>"
    #           plus the runtimes that would be fetched. NO writes, NO network. exit 0.
    pc_log "plan mode: nothing was installed"
    exit 0
  fi

  # TODO(O1): for each spec -> carry_over || install_one; then write_pc_agent, the shims,
  #           write_manifest, drop $MOUNT/agents/<id> directories that are no longer in the
  #           spec (their AUTH VOLUME is never touched), and `chmod -R a+rX "$MOUNT"`.
  pc_log "install-agents.sh is a skeleton — TODO(O1)"
}

main "$@"
