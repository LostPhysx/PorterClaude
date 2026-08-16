#!/usr/bin/env bash
# TODO(O1): remove this line once the bodies below are implemented — it only silences the
# "assigned but never used / arguments never passed" warnings a skeleton necessarily has.
# shellcheck disable=SC2034,SC2119,SC2120,SC2317
# PorterClaude — container CMD of the tools image. OWNER: O1. PLANNER SKELETON (v0.2).
# Spec: docs/design/orchestration.md §13.2 (the mount symlink), §13.3, §13.4 (promotion).
#
# The server runs ONE container from the tools image per "Sync tools", with the host's tools
# volume mounted rw at /out and `PORTERCLAUDE_AGENTS` (JSON AgentInstallSpec[]) in the
# environment, and treats a non-zero exit as a failed job (backend.md §15).
#
# Sequence:
#   1. sanity-check /out and remove leftovers from an interrupted run
#   2. STAGE = /out/.pc-stage.$$ ; copy the static payload (/payload) into it
#   3. point the RUNTIME path at the stage:  ln -sfn "$STAGE" "$MOUNT"   (§13.2)
#      -> every absolute path an installer bakes is already the path sessions will see
#   4. carry over / install the agents:  install-agents.sh
#   5. promote: directories by swap, files by rename(2) — never write in place (ETXTBSY)
#   6. drop the symlink, remove the stage, print what is in the volume
#
# v0.1 was `bash`-free (POSIX sh) because it did nothing but copy. v0.2 needs bash + jq, both
# of which exist in the tools image and NOWHERE ELSE — nothing in this file ever runs inside
# a session image.
set -euo pipefail

# The tools image mirrors this directory 1:1 at /opt/pc-tools, so $0-relative sourcing works
# both in the image and from a checkout (CI runs install-agents.sh --plan straight from the
# repo). PC_TOOLS_SRC is the directory holding populate.sh, install-agents.sh, lib/ and agents/.
PC_TOOLS_SRC="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=lib/common.sh
. "$PC_TOOLS_SRC/lib/common.sh"

OUT="${OUT:-/out}"
PAYLOAD="${PAYLOAD:-/payload}"
MOUNT="${PORTERCLAUDE_TOOLS_MOUNT:-/opt/porterclaude}"
STAGE="$OUT/.pc-stage.$$"

preflight() {
  [ -d "$PAYLOAD" ] || pc_die "$PAYLOAD is missing — the image was not built correctly"
  [ -d "$OUT" ]     || pc_die "$OUT is not mounted — run this container with the tools volume at $OUT"
  [ -w "$OUT" ]     || pc_die "$OUT is not writable — mount the tools volume read-write"
  # Leftovers from an interrupted earlier run (same filesystem, never mounted by sessions).
  for old in "$OUT"/.pc-stage.* "$OUT"/agents/.*.old "$OUT"/runtime/.*.old; do
    [ -e "$old" ] || continue
    pc_log "removing a stale directory: $old"
    rm -rf "$old" 2>/dev/null || :
  done
}

cleanup() {
  rm -rf "$STAGE" 2>/dev/null || :
  # only ever remove OUR symlink, never a real directory an image might ship
  [ -L "$MOUNT" ] && rm -f "$MOUNT" 2>/dev/null || :
}

# stage_payload : cp -a "$PAYLOAD"/. "$STAGE"/ ; chmod -R a+rX ; 0755 on entrypoint.sh,
# bin/* and lib/*.sh. The static payload is entrypoint.sh, lib/pc-common.sh and the empty
# bin/ + agents/ + runtime/ skeleton — the agents themselves are added in step 4.
stage_payload() {
  # TODO(O1)
  :
}

# link_mount : rm -f the symlink if it exists, then `ln -sfn "$STAGE" "$MOUNT"`. Refuse (die)
# when $MOUNT exists as a real directory — that would mean the tools image itself ships one
# and every baked path would be wrong.
link_mount() {
  # TODO(O1)
  :
}

# promote : §13.4.
#   * agents/<id> and runtime/<name>: pc_publish_dir (swap, then rm -rf the .old copy)
#   * everything else: pc_publish_file (mv -f = rename(2), legal on a busy executable)
#   * create missing directories in $OUT first, chmod a+rX them
#   * agents/<id> present in $OUT but not in $STAGE is REMOVED (the agent was disabled);
#     its auth volume lives on a different volume and is never touched here
promote() {
  # TODO(O1)
  :
}

verify() {
  [ -x "$OUT/entrypoint.sh" ] || pc_die "$OUT/entrypoint.sh is missing or not executable after the sync"
  [ -f "$OUT/AGENTS.json" ]   || pc_die "$OUT/AGENTS.json was not written"
  pc_log "contents of $OUT:"; ls -l "$OUT"
  if [ -d "$OUT/bin" ];    then pc_log "bin:";    ls -l "$OUT/bin"; fi
  if [ -d "$OUT/agents" ]; then pc_log "agents:"; ls -l "$OUT/agents"; fi
  pc_log "manifest:"; cat "$OUT/AGENTS.json"
}

main() {
  trap cleanup EXIT INT TERM
  preflight
  mkdir -p "$STAGE"
  stage_payload
  link_mount

  # Agent failures are warnings inside install-agents.sh; a non-zero exit here means the spec
  # was invalid or the manifest could not be written, and must fail the sync.
  PORTERCLAUDE_TOOLS_MOUNT="$MOUNT" "$PC_TOOLS_SRC/install-agents.sh"

  promote
  cleanup
  trap - EXIT INT TERM
  verify
  pc_log "done"
  exit 0
}

main "$@"
