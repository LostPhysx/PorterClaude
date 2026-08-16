#!/usr/bin/env bash
# TODO(O1): remove this line once the bodies below are implemented — it only silences the
# "assigned but never used / arguments never passed" warnings a skeleton necessarily has.
# shellcheck disable=SC2034,SC2119,SC2120,SC2317
# PorterClaude — the bundled runtimes in the tools volume. OWNER: O1. PLANNER SKELETON (v0.2).
# Spec: docs/design/orchestration.md §13.1, §13.7.
#
# npm agents need a Node that exists inside ARBITRARY session images, pip agents need a
# Python. Neither may be assumed to be in the image, so both ship in the tools volume:
#
#   $TOOLS_MOUNT/runtime/node/bin/node        POSIX-sh dispatcher: glibc or musl build
#   $TOOLS_MOUNT/runtime/node/glibc/…         nodejs.org distribution
#   $TOOLS_MOUNT/runtime/node/musl/…          unofficial-builds.nodejs.org (best effort)
#   $TOOLS_MOUNT/runtime/node/VERSION
#   $TOOLS_MOUNT/runtime/uv/bin/uv            static musl build → runs on glibc AND musl
#   $TOOLS_MOUNT/runtime/python/…             uv-managed CPython (glibc; musl unsupported)
#
# All three are LAZY: they are only fetched when at least one enabled agent needs them, and
# they are carried over from the existing volume when the pinned version already matches.
set -uo pipefail

# Pinned so a sync is reproducible and the payload size is predictable. O1: verify these are
# current at implementation time; both are plain version strings, never URLs with an arch.
PC_NODE_VERSION="${PORTERCLAUDE_NODE_VERSION:-22.20.0}"
PC_UV_VERSION="${PORTERCLAUDE_UV_VERSION:-latest}"
PC_PYTHON_VERSION="${PORTERCLAUDE_PYTHON_VERSION:-3.12}"

PC_NODE_BASE="${PORTERCLAUDE_NODE_BASE:-https://nodejs.org/dist}"
PC_NODE_MUSL_BASE="${PORTERCLAUDE_NODE_MUSL_BASE:-https://unofficial-builds.nodejs.org/download/release}"
PC_UV_BASE="${PORTERCLAUDE_UV_BASE:-https://github.com/astral-sh/uv/releases}"

# pc_ensure_node : make $TOOLS_MOUNT/runtime/node usable and print the path of the npm
# executable of the GLIBC build (that is what installs packages inside the tools container).
#   * glibc: $PC_NODE_BASE/v$V/node-v$V-linux-<arch>.tar.xz          (required)
#   * musl : $PC_NODE_MUSL_BASE/v$V/node-v$V-linux-<arch>-musl.tar.xz (best effort — arm64
#            is frequently missing; a warning, not a failure)
#   * writes runtime/node/bin/node, a POSIX-sh dispatcher that picks glibc|musl at RUNTIME
#     (pc-common.sh pc_libc) and prints a clear error when the needed flavour is absent
# Returns non-zero when the glibc build could not be obtained: every npm agent then fails
# with that one reason (§17).
pc_ensure_node() {
  # TODO(O1)
  return 1
}

# pc_ensure_uv : fetch the STATIC uv release for this architecture into
# $TOOLS_MOUNT/runtime/uv/bin/uv and print its path. uv's linux assets are musl-static, so
# one binary covers glibc and musl hosts alike.
pc_ensure_uv() {
  # TODO(O1)
  return 1
}

# pc_ensure_python : `uv python install $PC_PYTHON_VERSION` with
# UV_PYTHON_INSTALL_DIR=$TOOLS_MOUNT/runtime/python and print the interpreter path. The
# download is a glibc build (the tools image is Debian): pip agents are documented as
# glibc-only (§13.7) and their run.sh says so.
pc_ensure_python() {
  # TODO(O1)
  return 1
}
