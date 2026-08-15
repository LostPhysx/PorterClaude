#!/bin/sh
# PorterClaude — container CMD of the tools image: copy /payload into the mounted volume.
# OWNER: O1. The server runs this once with `porterclaude-tools` mounted rw at /out and
# treats a non-zero exit as a failed tools-sync job (docs/design/backend.md §9).
set -eu

OUT="${OUT:-/out}"

# TODO(O1):
#   [ -d "$OUT" ] || { echo "[tools] $OUT is not mounted" >&2; exit 1; }
#   cp -a /payload/. "$OUT"/
#   chmod -R a+rX "$OUT"
#   chmod 0755 "$OUT/entrypoint.sh" "$OUT"/bin/*
#   ls -l "$OUT" "$OUT/bin"   (so the job log shows what was written)
#   exit 0
echo "[tools] TODO(O1): populate $OUT" >&2
exit 1
