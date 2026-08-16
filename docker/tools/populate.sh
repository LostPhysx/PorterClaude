#!/bin/sh
# PorterClaude — container CMD of the tools image: copy /payload into the mounted volume.
# OWNER: O1. The server runs this once with `porterclaude-tools` mounted rw at /out and
# treats a non-zero exit as a failed tools-sync job (docs/design/backend.md §9).
#
# RE-SYNC WITH LIVE SESSIONS (docker/tools/README.md promises this works): running sessions
# have $OUT/bin/claude-linux-* mmap'ed, so writing INTO those files fails with ETXTBSY
# ("Text file busy") and leaves the volume half-updated. Therefore we never write in place:
# everything lands in a staging directory on the same filesystem first and is then moved
# over the target with rename(2), which the kernel allows on a busy executable (the running
# process keeps the old, now-unlinked inode; the next start picks up the new one).
set -eu

OUT="${OUT:-/out}"
PAYLOAD="${PAYLOAD:-/payload}"
STAGE="$OUT/.pc-stage.$$"

if [ ! -d "$PAYLOAD" ]; then
  echo "[tools] $PAYLOAD is missing — the image was not built correctly" >&2
  exit 1
fi
if [ ! -d "$OUT" ]; then
  echo "[tools] $OUT is not mounted — run this container with the tools volume at $OUT" >&2
  exit 1
fi
if [ ! -w "$OUT" ]; then
  echo "[tools] $OUT is not writable — mount the tools volume read-write" >&2
  exit 1
fi

cleanup() {
  rm -rf "$STAGE" 2>/dev/null || :
}
trap cleanup EXIT INT TERM

# Leftovers from an interrupted earlier run (same filesystem, never mounted by sessions).
for old in "$OUT"/.pc-stage.*; do
  [ -e "$old" ] || continue
  echo "[tools] removing a stale staging directory: $old"
  rm -rf "$old" 2>/dev/null || :
done

echo "[tools] staging $PAYLOAD -> $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -a "$PAYLOAD"/. "$STAGE"/

# sessions mount this volume read-only and run as arbitrary uids
chmod -R a+rX "$STAGE"
if [ -f "$STAGE/entrypoint.sh" ]; then
  chmod 0755 "$STAGE/entrypoint.sh"
fi
if [ -d "$STAGE/bin" ]; then
  for f in "$STAGE"/bin/*; do
    if [ -f "$f" ]; then
      chmod 0755 "$f"
    fi
  done
fi

# Promote: directories are created, then every file/symlink is renamed over its target.
# rename(2) is atomic and works even when the destination is a running executable.
echo "[tools] publishing $STAGE -> $OUT"
find "$STAGE" -mindepth 1 -type d | while IFS= read -r d; do
  rel=${d#"$STAGE"/}
  mkdir -p "$OUT/$rel"
  chmod a+rX "$OUT/$rel" 2>/dev/null || :
done
find "$STAGE" -mindepth 1 ! -type d | while IFS= read -r f; do
  rel=${f#"$STAGE"/}
  # `mv -f` on an existing regular file is rename(2): no ETXTBSY, no partially written file.
  mv -f "$f" "$OUT/$rel" || {
    echo "[tools] could not publish $rel into $OUT" >&2
    exit 1
  }
done

cleanup
trap - EXIT INT TERM

if [ ! -x "$OUT/entrypoint.sh" ]; then
  echo "[tools] $OUT/entrypoint.sh is missing or not executable after the sync" >&2
  exit 1
fi

echo "[tools] contents of $OUT:"
ls -l "$OUT"
if [ -d "$OUT/bin" ]; then
  echo "[tools] contents of $OUT/bin:"
  ls -l "$OUT/bin"
fi
if [ -f "$OUT/VERSION" ]; then
  echo "[tools] claude version: $(cat "$OUT/VERSION")"
fi
echo "[tools] done"
exit 0
