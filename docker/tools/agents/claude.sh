#!/usr/bin/env bash
# PorterClaude — per-agent installer override for `claude`. OWNER: O1. v0.2.
# Spec: docs/design/orchestration.md §13.7, §13.8, §13.9.
#
# WHY an override: the generic `script` installer runs claude.ai/install.sh inside the tools
# image, which is glibc — the resulting binary cannot run in a musl session (alpine). v0.1
# solved that by downloading the NATIVE binaries for all four targets
# (docker/tools/fetch-claude.sh); this file is that logic, moved into the agent framework and
# reduced to the architecture of THIS host (the tools volume belongs to exactly one host, so
# the foreign architecture would only be dead weight). `fetch-claude.sh` is deleted; its
# download/dispatcher code lives on here and in git history.
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

# pc_claude_resolve_version : print the concrete version for the requested channel.
pc_claude_resolve_version() {
  local want="$PC_CLAUDE_VERSION" tmp resolved
  case "$want" in
    stable|latest|"")
      tmp="$(mktemp)"
      if pc_fetch "$PC_CLAUDE_DIST_BASE/stable" "$tmp"; then
        resolved="$(head -n1 "$tmp" | tr -d ' \t\r\n')"
      else
        resolved=""
      fi
      rm -f "$tmp"
      if [ -n "$resolved" ]; then
        printf '%s' "$resolved"
      else
        pc_warn "claude: could not resolve the current stable version"
        printf ''
      fi
      ;;
    *) printf '%s' "$want" ;;
  esac
}

# pc_claude_verify <manifest> <platform> <file> : best-effort sha256 check. A missing
# manifest, a missing entry or a missing sha256sum is NOT an error — only a real mismatch is.
pc_claude_verify() {
  local manifest="$1" plat="$2" file="$3" want have
  [ -s "$manifest" ] || return 0
  command -v sha256sum >/dev/null 2>&1 || return 0
  want="$(jq -r --arg p "$plat" '((.platforms[$p].checksum) // (.[$p].checksum)) // empty' \
          "$manifest" 2>/dev/null)"
  [ -n "$want" ] || return 0
  have="$(sha256sum "$file" | cut -d' ' -f1)"
  if [ "$want" != "$have" ]; then
    pc_warn "claude: checksum mismatch for $plat (manifest $want, got $have)"
    return 1
  fi
  pc_log "claude: checksum verified for $plat"
  return 0
}

# Fallback for the glibc flavour only: the official installer, run with HOME inside the agent
# directory so it cannot write anywhere else. It produces a binary for the architecture AND
# libc of the TOOLS image, i.e. glibc — musl sessions stay uncovered and we say so loudly.
pc_claude_installer_fallback() {
  local dest="$1" work launcher resolved
  work="$AGENT_DIR/.install"
  rm -rf "$work"
  mkdir -p "$work"
  pc_warn "==============================================================================="
  pc_warn "claude: falling back to the official installer (glibc only)."
  pc_warn "musl sessions (alpine) will NOT find a claude binary until the release bucket"
  pc_warn "is reachable again — re-run Settings -> Images -> Sync tools later."
  pc_warn "==============================================================================="
  if ! ( export HOME="$work"; pc_run 600 sh -c 'curl -fsSL https://claude.ai/install.sh | bash' ); then
    pc_warn "claude: the official installer failed as well"
    rm -rf "$work"
    return 1
  fi
  launcher=""
  if [ -x "$work/.local/bin/claude" ]; then
    launcher="$work/.local/bin/claude"
  else
    launcher="$(find "$work" -type f -name claude -perm -u+x 2>/dev/null | head -n1)"
  fi
  if [ -z "$launcher" ]; then
    pc_warn "claude: the installer produced no claude binary"
    rm -rf "$work"
    return 1
  fi
  resolved="$(readlink -f "$launcher" 2>/dev/null || printf '')"
  [ -n "$resolved" ] || resolved="$launcher"
  cp -f "$resolved" "$dest" || { rm -rf "$work"; return 1; }
  chmod 0755 "$dest"
  rm -rf "$work"
  pc_log "claude: installed from the official installer"
  return 0
}

pc_agent_install_claude() {
  local version manifest suffix plat dest fetched=""
  if [ -z "$ARCH" ]; then
    echo "unsupported machine '$(uname -m)'" >&2
    return 1
  fi
  version="$(pc_claude_resolve_version)"
  if [ -z "$version" ]; then
    echo "cannot resolve the claude version from $PC_CLAUDE_DIST_BASE" >&2
    return 1
  fi
  pc_log "claude: version $version, architecture $ARCH (glibc + musl)"

  mkdir -p "$AGENT_DIR/bin"
  manifest="$(mktemp)"
  pc_fetch "$PC_CLAUDE_DIST_BASE/$version/manifest.json" "$manifest" \
    || pc_warn "claude: no manifest.json for $version — skipping checksum verification"

  for suffix in "" "-musl"; do
    plat="linux-$ARCH$suffix"
    dest="$AGENT_DIR/bin/claude-$plat"
    if pc_fetch "$PC_CLAUDE_DIST_BASE/$version/$plat/claude" "$dest"; then
      if pc_claude_verify "$manifest" "$plat" "$dest"; then
        chmod 0755 "$dest"
        fetched="$fetched $plat"
        pc_log "claude: fetched $plat"
      else
        rm -f "$dest"
      fi
    else
      pc_warn "claude: download failed for $plat"
    fi
  done
  rm -f "$manifest"

  if [ ! -x "$AGENT_DIR/bin/claude-linux-$ARCH" ]; then
    pc_claude_installer_fallback "$AGENT_DIR/bin/claude-linux-$ARCH" \
      && fetched="$fetched linux-$ARCH(installer)"
  fi

  if [ -z "$fetched" ]; then
    echo "no claude binary could be obtained for this host ($ARCH)" >&2
    return 1
  fi
  pc_log "claude: installed:$fetched"
  pc_write_dispatch_run_sh "bin" "claude-"
}
