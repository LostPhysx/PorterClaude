#!/usr/bin/env bash
# TODO(O1): remove this line once the bodies below are implemented — it only silences the
# "assigned but never used / arguments never passed" warnings a skeleton necessarily has.
# shellcheck disable=SC2034,SC2119,SC2120,SC2317
# PorterClaude — per-agent installer override for `claude`. OWNER: O1. PLANNER SKELETON (v0.2).
# Spec: docs/design/orchestration.md §13.7, §13.8, §13.9.
#
# WHY an override: the generic `script` installer runs claude.ai/install.sh inside the tools
# image, which is glibc — the resulting binary cannot run in a musl session (alpine). v0.1
# solved that by downloading the NATIVE binaries for all four targets
# (docker/tools/fetch-claude.sh); this file is that logic, moved into the agent framework.
# `fetch-claude.sh` is deleted once this works — its download/dispatcher code is the
# reference implementation and is preserved in git history.
#
# The driver sources this file when the spec id is `claude` and calls the function below
# INSTEAD of pc_install_script, with the §13.9 contract:
#   in : $AGENT_ID=claude $AGENT_COMMAND=claude $AGENT_DIR $AGENT_SPEC $TOOLS_MOUNT $ARCH
#   out: 0 and $AGENT_DIR/run.sh, or non-zero + a reason on stderr
set -uo pipefail

# The public distribution base of the native binaries (v0.1, unchanged) and the requested
# channel. `stable`/`latest` are resolved through "$CLAUDE_DIST_BASE/stable".
PC_CLAUDE_DIST_BASE="${CLAUDE_DIST_BASE:-https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases}"
PC_CLAUDE_VERSION="${PORTERCLAUDE_CLAUDE_VERSION:-stable}"

# Targets: the host architecture in BOTH libc flavours. Cross-architecture binaries are no
# longer fetched — the tools volume belongs to exactly one host, so its architecture is known
# (v0.1 shipped all four because there was only one volume for one engine anyway; dropping
# the foreign arch halves the payload).
pc_agent_install_claude() {
  # TODO(O1):
  #  1. resolve the version:  "$PC_CLAUDE_DIST_BASE/stable" when the channel is stable/latest
  #  2. for suffix in "" "-musl":
  #       pc_fetch "$PC_CLAUDE_DIST_BASE/$version/linux-$ARCH$suffix/claude" \
  #                "$AGENT_DIR/bin/claude-linux-$ARCH$suffix"     (chmod 0755)
  #       best-effort sha256 check against "$PC_CLAUDE_DIST_BASE/$version/manifest.json"
  #  3. fallback when the glibc download failed: run the official installer
  #     (HOME="$AGENT_DIR/install" sh -c 'curl -fsSL https://claude.ai/install.sh | bash')
  #     and copy the produced binary to bin/claude-linux-$ARCH; warn loudly that musl
  #     sessions are not covered
  #  4. fail (return 1) only when NEITHER flavour could be obtained
  #  5. pc_write_run_sh with the arch+libc dispatch: musl session -> -musl binary; glibc
  #     session -> the plain binary, falling back to the -musl one (it is statically linked,
  #     which is exactly the v0.1 dispatcher rule)
  return 1
}
