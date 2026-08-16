#!/usr/bin/env bash
# TODO(O1): remove this line once the bodies below are implemented — it only silences the
# "assigned but never used / arguments never passed" warnings a skeleton necessarily has.
# shellcheck disable=SC2034,SC2119,SC2120,SC2317
# PorterClaude — the four generic agent installers. OWNER: O1. PLANNER SKELETON (v0.2).
# Spec: docs/design/orchestration.md §13.6, §13.7, §13.9.
#
# CONTRACT (identical for every function here and for every per-agent override):
#   in : $AGENT_ID $AGENT_COMMAND $AGENT_DIR (exists, empty) $AGENT_SPEC (JSON object)
#        $TOOLS_MOUNT (= the runtime path, /opt/porterclaude) $ARCH ($TARGET)
#   out: 0  -> $AGENT_DIR/run.sh exists, is 0755 and execs the agent
#        >0 -> the reason was printed to stderr; the driver records installed:false
#   never: exit the caller, write outside $AGENT_DIR and $TOOLS_MOUNT/runtime, prompt, or
#          bake a `/out` path into anything (§13.2 — install through $TOOLS_MOUNT only).
#
# All four end by calling pc_write_run_sh, which is what guarantees the launcher shape.
set -uo pipefail

# pc_write_run_sh <exec-line> : write $AGENT_DIR/run.sh (POSIX sh, 0755). <exec-line> is
# already-quoted shell that ends in `"$@"`; the generated file resolves its own directory
# ($AGENT_DIR) and $TOOLS from $0, so the payload stays relocatable.
pc_write_run_sh() {
  # TODO(O1)
  return 1
}

# kind=script — curl the installer and pipe it into sh with HOME/PREFIX pointed at
# $AGENT_DIR. `binPath` is a HINT: look for $AGENT_DIR/$binPath, then
# $AGENT_DIR/.local/$binPath, then `find $AGENT_DIR -type f -name "$AGENT_COMMAND" -perm -u+x`.
# `install.env` is exported for the installer run only. Multi-libc coverage is best effort
# for this kind (§13.7) — an agent that needs more ships an override in agents/<id>.sh.
pc_install_script() {
  # TODO(O1)
  return 1
}

# kind=npm — needs the bundled Node runtime (pc_ensure_node). Install with
#   "$NODE_BIN/npm" install --prefix "$AGENT_DIR" --no-audit --no-fund --omit=dev <pkg>@<ver>
# then resolve the package's bin entry from $AGENT_DIR/node_modules/<pkg>/package.json
# (`.bin` is a string or an object; `install.bin` names the wanted one, default
# $AGENT_COMMAND) and generate a run.sh that execs
#   "$TOOLS/runtime/node/bin/node" "$AGENT_DIR/node_modules/<pkg>/<binjs>" "$@"
# — never the npm-generated .bin symlink (its shebang is `/usr/bin/env node`, which does not
# exist in a session image).
pc_install_npm() {
  # TODO(O1)
  return 1
}

# kind=pip — needs uv (pc_ensure_uv) and a managed CPython (pc_ensure_python). Install with
#   UV_TOOL_DIR="$AGENT_DIR/tools" UV_TOOL_BIN_DIR="$AGENT_DIR/bin"
#   UV_PYTHON_INSTALL_DIR="$TOOLS_MOUNT/runtime/python" uv tool install <pkg>[==<version>]
# (fall back to `python -m venv` + pip when install.preferUv is false or uv is unavailable).
# run.sh execs the generated console script; because everything was installed through
# $TOOLS_MOUNT the shebang inside it already points at the runtime path (§13.2).
# musl sessions are NOT supported for this kind: run.sh must detect musl (pc-common.sh) and
# exit with "…requires a glibc image on this host" instead of a confusing loader error.
pc_install_pip() {
  # TODO(O1)
  return 1
}

# kind=binary — pick install.urls[$TARGET] (glibc target first, then the -musl one; install
# BOTH when both are present so a musl session on this host is covered), download, verify it
# is executable, unpack when install.archive is tar.gz/zip and take install.path from inside.
# run.sh dispatches on pc_target when two flavours were installed.
pc_install_binary() {
  # TODO(O1)
  return 1
}
