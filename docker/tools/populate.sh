#!/usr/bin/env bash
# PorterClaude — container CMD of the tools image. OWNER: O1. v0.2.
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
PC_TOOLS_SRC="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
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
  if [ -L "$MOUNT" ]; then
    rm -f "$MOUNT" 2>/dev/null || :
  fi
}

# stage_payload : copy the static payload into the stage. That is entrypoint.sh,
# lib/pc-common.sh and the empty bin/ + agents/ + runtime/ skeleton — the agents themselves
# are added in step 4.
stage_payload() {
  mkdir -p "$STAGE"
  cp -a "$PAYLOAD"/. "$STAGE"/ || pc_die "cannot copy $PAYLOAD into the stage"
  mkdir -p "$STAGE/bin" "$STAGE/lib" "$STAGE/agents" "$STAGE/runtime"
  chmod -R a+rX "$STAGE"
  [ -f "$STAGE/entrypoint.sh" ] || pc_die "the payload has no entrypoint.sh"
  chmod 0755 "$STAGE/entrypoint.sh"
  chmod 0755 "$STAGE"/bin/* 2>/dev/null || :
  pc_log "staged the payload in $STAGE"
}

# link_mount : make $MOUNT point at the stage FOR THIS CONTAINER ONLY, so every absolute path
# an installer bakes (npm bin shims, uv tool scripts, pyvenv.cfg) is the path the sessions
# will see. Refuse when $MOUNT exists as a real directory — that would mean the tools image
# itself ships one and every baked path would be wrong.
link_mount() {
  if [ -d "$MOUNT" ] && [ ! -L "$MOUNT" ]; then
    pc_die "$MOUNT exists as a real directory inside the tools image — refusing to install through it"
  fi
  rm -f "$MOUNT" 2>/dev/null || :
  mkdir -p "$(dirname "$MOUNT")"
  ln -sfn "$STAGE" "$MOUNT" || pc_die "cannot point $MOUNT at $STAGE"
  pc_log "$MOUNT -> $STAGE (installs bake this path, §13.2)"
}

# promote : §13.4.
#   * agents/<id> and runtime/<name>: pc_publish_dir (swap, then rm -rf the .old copy)
#   * everything else: pc_publish_file (mv -f = rename(2), legal on a busy executable)
#   * an agents/<id> (or a bin/ or lib/ entry) present in $OUT but no longer in the stage is
#     REMOVED — the agent was disabled, or it is a leftover of the v0.1 payload. Its auth
#     volume lives on a different volume and is never touched here.
promote() {
  local group d name rel
  mkdir -p "$OUT"

  for group in agents runtime; do
    mkdir -p "$OUT/$group" "$STAGE/$group"
    for d in "$OUT/$group"/*; do
      [ -e "$d" ] || continue
      name="$(basename "$d")"
      case "$name" in .*) continue ;; esac
      if [ ! -e "$STAGE/$group/$name" ]; then
        pc_log "removing $group/$name from the volume (no longer part of the payload)"
        rm -rf "$d"
      fi
    done
    for d in "$STAGE/$group"/*; do
      [ -d "$d" ] || continue
      name="$(basename "$d")"
      pc_publish_dir "$d" "$OUT/$group/$name" || pc_die "cannot publish $group/$name"
    done
  done

  # stale files of an older payload (v0.1 shipped bin/claude-linux-*)
  for group in bin lib; do
    mkdir -p "$OUT/$group" "$STAGE/$group"
    for d in "$OUT/$group"/*; do
      [ -e "$d" ] || continue
      name="$(basename "$d")"
      if [ ! -e "$STAGE/$group/$name" ]; then
        pc_log "removing $group/$name from the volume (no longer part of the payload)"
        rm -f "$d"
      fi
    done
  done

  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    pc_publish_file "$STAGE/$rel" "$OUT/$rel" || pc_die "cannot publish $rel"
    case "$rel" in
      entrypoint.sh|bin/*) chmod 0755 "$OUT/$rel" ;;
      *)                   chmod 0644 "$OUT/$rel" ;;
    esac
  done < <(cd "$STAGE" && find . -type f -not -path './agents/*' -not -path './runtime/*' \
                         | sed 's|^\./||' | sort)

  chmod -R a+rX "$OUT" 2>/dev/null || :
  pc_log "promoted the payload into $OUT"
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
  OUT="$OUT" PORTERCLAUDE_TOOLS_MOUNT="$MOUNT" "$PC_TOOLS_SRC/install-agents.sh"

  promote
  cleanup
  trap - EXIT INT TERM
  verify
  pc_log "done"
  exit 0
}

main "$@"
