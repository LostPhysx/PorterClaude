#!/usr/bin/env bash
# PorterClaude — the agent driver. OWNER: O1. v0.2.
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
# --pc-install-one : INTERNAL. Installs the single agent described by the $AGENT_* environment
#          and exits; the driver runs it through `timeout` (§13.9) so that a hanging installer
#          cannot block the sync. Never call it by hand.
set -euo pipefail

# $0-relative: the tools image mirrors docker/tools at /opt/pc-tools, so the same layout
# works in the image and from a checkout (CI runs --plan from the repo).
PC_TOOLS_SRC="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
PC_SELF="$PC_TOOLS_SRC/install-agents.sh"
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
CHILD=0

# The volume as it exists right now: the source of every carry-over (§13.3). Never installed
# into — installs go through $MOUNT so that no absolute path can point at /out (§13.2).
PC_OUT="${OUT:-/out}"
ARCH="$(pc_arch)"
TARGET="linux-$ARCH"          # the tools image is glibc; sessions may still be musl (§13.7)
export TOOLS_MOUNT="$MOUNT"
export PC_OUT ARCH TARGET
export PORTERCLAUDE_AGENT_TIMEOUT="$AGENT_TIMEOUT"

# Manifest rows (compact JSON objects) and the command -> agent id claims.
declare -a MANIFEST_ROWS=()
declare -A COMMAND_OWNER=()
INSTALL_ERROR=""

usage() {
  cat <<'USAGE'
usage: install-agents.sh [--plan]
  env: PORTERCLAUDE_AGENTS       JSON AgentInstallSpec[]        (default: [])
       PORTERCLAUDE_TOOLS_MOUNT  runtime path of the payload    (default: /opt/porterclaude)
       PORTERCLAUDE_TOOLS_FORCE  1 = reinstall everything       (default: 0)
       PORTERCLAUDE_AGENT_TIMEOUT seconds per agent             (default: 900)
       OUT                       the tools volume (carry-over)  (default: /out)
USAGE
}

# ------------------------------------------------------------------------------------------
# spec handling
# ------------------------------------------------------------------------------------------

# validate_specs : jq-validate $AGENTS_JSON. Must be an array of objects with a slug `id`, a
# non-empty `command`, an `install.kind` in script|npm|pip|binary and a non-empty
# `versionCommand` array. A violation is FATAL (exit 2) — it can only be a server bug.
validate_specs() {
  local bad
  if ! printf '%s' "$AGENTS_JSON" | jq -e 'type == "array"' >/dev/null 2>&1; then
    pc_die "PORTERCLAUDE_AGENTS is not a JSON array"
  fi
  if ! printf '%s' "$AGENTS_JSON" | jq -e 'all(type == "object")' >/dev/null 2>&1; then
    pc_die "PORTERCLAUDE_AGENTS must contain objects only"
  fi
  bad="$(printf '%s' "$AGENTS_JSON" | jq -r '
    [ .[]
      | select(
          (((.id // "") | type != "string") or ((.id // "") | test("^[a-z0-9][a-z0-9-]{0,31}$") | not))
          or (((.command // "") | type != "string") or ((.command // "") == ""))
          or (((.install.kind // "") | IN("script", "npm", "pip", "binary")) | not)
          or (((.versionCommand // []) | type != "array") or ((.versionCommand // []) | length == 0))
        )
      | ((.id // "?") | tostring) ]
    | join(", ")' 2>/dev/null)"
  if [ -n "$bad" ]; then
    pc_die "invalid agent spec(s): $bad"
  fi
  return 0
}

# spec_count / spec_at <i> / spec_field <spec> <path> : jq accessors. Keep every JSON read in
# these three functions so the rest of the script never parses JSON by hand.
spec_count() { printf '%s' "$AGENTS_JSON" | jq 'length'; }
spec_at()    { printf '%s' "$AGENTS_JSON" | jq -c ".[$1]"; }
spec_field() { pc_json_get "$1" "$2"; }

# carry_over <id> <spec> : 0 when the agent already sits in the volume with an identical
# SPEC.json, a non-empty VERSION and no ERROR file, and $FORCE is 0. The directory is then
# copied from the volume into the stage instead of being installed again (§13.3).
carry_over() {
  local id="$1" spec="$2" dir="$PC_OUT/agents/$1" have want
  if [ "$FORCE" = "1" ]; then
    return 1
  fi
  if [ ! -d "$dir" ] || [ ! -x "$dir/run.sh" ] || [ ! -f "$dir/SPEC.json" ]; then
    return 1
  fi
  if [ ! -s "$dir/VERSION" ] || [ -e "$dir/ERROR" ]; then
    return 1
  fi
  have="$(jq -S -c . "$dir/SPEC.json" 2>/dev/null || printf '')"
  want="$(printf '%s' "$spec" | jq -S -c . 2>/dev/null || printf '')"
  if [ -z "$have" ] || [ "$have" != "$want" ]; then
    return 1
  fi
  rm -rf "${MOUNT:?}/agents/$id"
  if ! cp -a "$dir" "$MOUNT/agents/$id"; then
    pc_warn "$id: carry-over failed — reinstalling"
    rm -rf "${MOUNT:?}/agents/$id"
    return 1
  fi
  return 0
}

# pc_dispatch_install : the §13.9 dispatch, executed in the --pc-install-one child. An
# override in agents/<id>.sh wins over the kind installer.
pc_dispatch_install() {
  local kind override fn
  kind="$(pc_json_get "$AGENT_SPEC" '.install.kind')"
  override="$OVERRIDE_DIR/$AGENT_ID.sh"
  if [ -f "$override" ]; then
    # shellcheck source=/dev/null
    . "$override"
    fn="pc_agent_install_$AGENT_ID"
    if declare -F "$fn" >/dev/null 2>&1; then
      pc_log "$AGENT_ID: using the per-agent installer agents/$AGENT_ID.sh"
      "$fn"
      return $?
    fi
    pc_warn "$override defines no $fn() — falling back to the '$kind' installer"
  fi
  case "$kind" in
    script) pc_install_script ;;
    npm)    pc_install_npm ;;
    pip)    pc_install_pip ;;
    binary) pc_install_binary ;;
    *)      echo "unknown install kind '$kind'" >&2; return 1 ;;
  esac
}

# install_child : the body of --pc-install-one. stderr is collected in $AGENT_DIR/.reason so
# that the driver can put a one-line reason into the manifest; it is printed afterwards, so
# the job log still carries it.
install_child() {
  local st
  : "${AGENT_ID:?}" "${AGENT_COMMAND:?}" "${AGENT_DIR:?}" "${AGENT_SPEC:?}"
  if pc_dispatch_install 2>"$AGENT_DIR/.reason"; then
    st=0
  else
    st=1
  fi
  cat "$AGENT_DIR/.reason" >&2 2>/dev/null || :
  if [ "$st" = "0" ] && [ ! -x "$AGENT_DIR/run.sh" ]; then
    echo "the installer wrote no run.sh" >> "$AGENT_DIR/.reason"
    echo "the installer of '$AGENT_ID' wrote no run.sh" >&2
    st=1
  fi
  return "$st"
}

# install_one <spec> : the per-agent pipeline (§13.9). Exports the installer contract, runs
# the installer in a child wrapped in `timeout`, and leaves the reason in $INSTALL_ERROR.
# Returns 0/1; never exits.
install_one() {
  local spec="$1" id command dir st
  id="$(spec_field "$spec" '.id')"
  command="$(spec_field "$spec" '.command')"
  dir="$MOUNT/agents/$id"
  INSTALL_ERROR=""
  rm -rf "$dir"
  mkdir -p "$dir"

  pc_log "installing agent '$id' ($(spec_field "$spec" '.install.kind'))"
  export AGENT_ID="$id" AGENT_COMMAND="$command" AGENT_DIR="$dir" AGENT_SPEC="$spec"
  # -k: an installer that ignores SIGTERM is killed 30 s later, so one hanging agent can
  # never hold the whole sync (and therefore the job) open
  if timeout -k 30 "$AGENT_TIMEOUT" bash "$PC_SELF" --pc-install-one; then
    st=0
  else
    st=$?
  fi
  unset AGENT_ID AGENT_COMMAND AGENT_DIR AGENT_SPEC

  if [ "$st" = "0" ]; then
    rm -f "$dir/.reason"
    pc_log "agent '$id' installed"
    return 0
  fi
  if [ "$st" = "124" ] || [ "$st" = "137" ]; then
    INSTALL_ERROR="timed out after ${AGENT_TIMEOUT}s"
  else
    INSTALL_ERROR="$(grep -v '^[[:space:]]*$' "$dir/.reason" 2>/dev/null | tail -n1 || printf '')"
    [ -n "$INSTALL_ERROR" ] || INSTALL_ERROR="install failed (see the job log)"
  fi
  rm -f "$dir/.reason"
  pc_warn "agent '$id' could not be installed: $INSTALL_ERROR"
  return 1
}

# version_of <command> <spec> : run the agent's versionCommand THROUGH the generated shim
# ("$MOUNT/bin/<command>" …) with a short timeout and a scratch HOME, print the first line
# trimmed. Empty when it fails — that is not an install failure (§17).
version_of() {
  local command="$1" spec="$2" out
  local -a vc=()
  [ -x "$MOUNT/bin/$command" ] || { printf ''; return 0; }
  # tr: jq on a non-unix host may emit CRLF; a stray \r inside an argv element is invisible
  # in a log and turns `--version` into something the agent does not recognise
  mapfile -t vc < <(printf '%s' "$spec" | jq -r '.versionCommand[]? // empty' 2>/dev/null | tr -d '\r')
  mkdir -p /tmp/pc-version
  out="$(env HOME=/tmp/pc-version PORTERCLAUDE_TOOLS="$MOUNT" \
         timeout 120 "$MOUNT/bin/$command" ${vc[@]+"${vc[@]:1}"} 2>/dev/null \
         | head -n1 | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' || printf '')"
  printf '%s' "$out"
}

# ------------------------------------------------------------------------------------------
# shims (§13.6)
# ------------------------------------------------------------------------------------------

# write_pc_agent : $MOUNT/bin/pc-agent — the ONE shim implementation. POSIX sh, no agent input.
write_pc_agent() {
  pc_write_exec "$MOUNT/bin/pc-agent" <<'PC_AGENT'
#!/bin/sh
# PorterClaude agent shim (generated by docker/tools/install-agents.sh). POSIX sh.
# Called through bin/<command>, which sets PORTERCLAUDE_AGENT_ID. It resolves the payload
# root, refuses politely when the agent is not installed on this host, and brackets the run
# with the ownership hand-back so that "log in once per host" works for every uid.
set -u

PC_TOOLS="${PORTERCLAUDE_TOOLS:-}"
if [ -z "$PC_TOOLS" ]; then
  PC_TOOLS="$(CDPATH='' cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd)"
  [ -n "$PC_TOOLS" ] || PC_TOOLS=/opt/porterclaude
fi
PORTERCLAUDE_TOOLS="$PC_TOOLS"; export PORTERCLAUDE_TOOLS
if [ -f "$PC_TOOLS/lib/pc-common.sh" ]; then
  . "$PC_TOOLS/lib/pc-common.sh"
fi

PC_ID="${PORTERCLAUDE_AGENT_ID:-}"
if [ -z "$PC_ID" ]; then
  echo "porterclaude: pc-agent must be called through $PC_TOOLS/bin/<command>" >&2
  exit 127
fi

PC_RUN="$PC_TOOLS/agents/$PC_ID/run.sh"
if [ ! -x "$PC_RUN" ]; then
  if [ -f "$PC_TOOLS/agents/$PC_ID/ERROR" ]; then
    echo "porterclaude: the last install of '$PC_ID' failed:" >&2
    cat "$PC_TOOLS/agents/$PC_ID/ERROR" >&2
  fi
  echo "porterclaude: agent '$PC_ID' is not installed on this host — Settings -> Images -> Sync tools" >&2
  exit 127
fi

# Ownership hand-back of the shared auth volumes. An agent run as ROOT writes its credentials
# as root:root, which no recipe session (uid 1000, and it cannot change that) could read
# afterwards. Before AND after the run: before picks up what another session already wrote.
pc_share() {
  [ -x "$PC_TOOLS/entrypoint.sh" ] && "$PC_TOOLS/entrypoint.sh" --porterclaude-share >/dev/null 2>&1
  return 0
}

pc_share
# the agent itself keeps the default signal handlers (a trap set to a command is reset to the
# default in the child); trapping here only keeps this shell alive for the hand-back.
trap ':' INT TERM HUP
"$PC_RUN" "$@"
PC_ST=$?
pc_share
exit $PC_ST
PC_AGENT
}

# write_shim <id> <command> : $MOUNT/bin/<command>, 0755, POSIX sh, three lines. The FIRST
# spec claiming a command keeps the shim (§13.6); the caller enforces that.
write_shim() {
  local id="$1" command="$2"
  {
    printf '%s\n' '#!/bin/sh'
    printf '# PorterClaude shim for the agent %s (generated by install-agents.sh).\n' "$id"
    printf 'PORTERCLAUDE_AGENT_ID=%s; export PORTERCLAUDE_AGENT_ID\n' "$(pc_sh_quote "$id")"
    printf '%s\n' 'exec "$(dirname "$0")/pc-agent" "$@"'
  } | pc_write_exec "$MOUNT/bin/$command"
}

# ------------------------------------------------------------------------------------------
# manifest (§13.5)
# ------------------------------------------------------------------------------------------

# manifest_row <id> <command> <installed:true|false> <version> <error> : one compact JSON
# object, built with jq (never string concatenation).
manifest_row() {
  jq -c -n --arg id "$1" --arg command "$2" --argjson installed "$3" \
           --arg version "$4" --arg error "$5" \
    '{ id: $id,
       command: $command,
       installed: $installed,
       version: (if $version == "" then null else $version end),
       error: (if $error == "" then null else $error end) }'
}

# write_manifest : $MOUNT/AGENTS.json via `jq -n`, matching ToolsAgentManifest EXACTLY:
#   { "syncedAt": <iso>, "agents": [ {id, command, installed, version, error} ] }
# and $MOUNT/VERSION = the claude entry's version (empty file when claude is absent).
write_manifest() {
  local ts rows claude_version
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  rows="$(printf '%s\n' ${MANIFEST_ROWS[@]+"${MANIFEST_ROWS[@]}"} | jq -s '.')" \
    || pc_die "could not assemble the agent manifest"
  jq -n --arg syncedAt "$ts" --argjson agents "$rows" '{ syncedAt: $syncedAt, agents: $agents }' \
    > "$MOUNT/AGENTS.json" || pc_die "could not write $MOUNT/AGENTS.json"
  chmod 0644 "$MOUNT/AGENTS.json"

  claude_version="$(printf '%s' "$rows" | jq -r '.[] | select(.id == "claude") | .version // empty')"
  if [ -n "$claude_version" ]; then
    printf '%s\n' "$claude_version" > "$MOUNT/VERSION"
  else
    : > "$MOUNT/VERSION"
  fi
  chmod 0644 "$MOUNT/VERSION"
}

# ------------------------------------------------------------------------------------------
# plan mode
# ------------------------------------------------------------------------------------------

print_plan() {
  local n i spec id command kind what needs_node=0 needs_uv=0
  n="$(spec_count)"
  i=0
  while [ "$i" -lt "$n" ]; do
    spec="$(spec_at "$i")"
    id="$(spec_field "$spec" '.id')"
    command="$(spec_field "$spec" '.command')"
    kind="$(spec_field "$spec" '.install.kind')"
    case "$kind" in
      script) what="$(spec_field "$spec" '.install.url')" ;;
      npm)    what="$(spec_field "$spec" '.install.package')@$(spec_field "$spec" '.install.version')"
              needs_node=1 ;;
      pip)    what="$(spec_field "$spec" '.install.package')"; needs_uv=1 ;;
      binary) what="$(printf '%s' "$spec" | jq -r '[.install.urls | keys[]] | join(",")')" ;;
      *)      what="?" ;;
    esac
    if [ -f "$OVERRIDE_DIR/$id.sh" ]; then
      kind="$kind (override agents/$id.sh)"
    fi
    pc_log "plan: $id ($command): $kind ${what%@} -> agents/$id"
    i=$((i + 1))
  done
  if [ "$needs_node" = "1" ]; then
    pc_log "runtimes: node $PC_NODE_VERSION would be fetched into runtime/node"
  fi
  if [ "$needs_uv" = "1" ]; then
    pc_log "runtimes: uv $PC_UV_VERSION + CPython $PC_PYTHON_VERSION would be fetched into runtime/"
  fi
  pc_log "plan mode: nothing was installed"
}

# ------------------------------------------------------------------------------------------

# ensure_runtimes : stage the runtimes the ENABLED KINDS need, whether or not an agent is
# actually reinstalled this run. Without this a run in which every npm agent is carried over
# would not stage runtime/node, and the promotion (which drops what the stage does not carry)
# would delete the interpreter those agents launch with. Cheap: pc_ensure_* copy an unchanged
# runtime out of the existing volume instead of downloading it. Failures are warnings — the
# agents of that kind then fail individually with the same reason (§17).
ensure_runtimes() {
  local kinds
  kinds=" $(printf '%s' "$AGENTS_JSON" | jq -r '[.[].install.kind] | unique | join(" ")') "
  case "$kinds" in
    *" npm "*)
      pc_ensure_node >/dev/null \
        || pc_warn "the bundled node runtime is unavailable — every npm agent will fail" ;;
  esac
  case "$kinds" in
    *" pip "*)
      pc_ensure_python >/dev/null \
        || pc_warn "the bundled python runtime is unavailable — every pip agent will fail" ;;
  esac
  return 0
}

sync_agents() {
  local n i spec id command dir installed version err carried
  mkdir -p "$MOUNT/bin" "$MOUNT/lib" "$MOUNT/agents" "$MOUNT/runtime"
  write_pc_agent
  ensure_runtimes

  n="$(spec_count)"
  pc_log "$n agent(s) requested for this host (architecture: ${ARCH:-unknown})"
  # the upgrade path: without this the carry-over keeps every installed agent at the version
  # it was first installed with (a spec does not change when upstream ships a release).
  if [ "$FORCE" = "1" ]; then
    pc_log "PORTERCLAUDE_TOOLS_FORCE=1: no carry-over, every agent is reinstalled from source"
  fi
  i=0
  while [ "$i" -lt "$n" ]; do
    spec="$(spec_at "$i")"
    id="$(spec_field "$spec" '.id')"
    command="$(spec_field "$spec" '.command')"
    dir="$MOUNT/agents/$id"
    installed=false
    version=""
    err=""
    carried=0

    if ! printf '%s' "$command" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'; then
      err="'$command' is not a usable command name"
      pc_warn "$id: $err"
    elif carry_over "$id" "$spec"; then
      carried=1
      installed=true
      version="$(head -n1 "$dir/VERSION" 2>/dev/null | tr -d '\r' || printf '')"
      pc_log "agent '$id' carried over unchanged (version ${version:-unknown})"
    elif install_one "$spec"; then
      installed=true
    else
      err="$INSTALL_ERROR"
    fi

    # the shim belongs to the FIRST spec claiming the command (§13.6); it is written even for
    # a failed install, so that calling it prints the recorded reason instead of "not found"
    if [ -n "${COMMAND_OWNER[$command]:-}" ]; then
      if [ -z "$err" ]; then
        err="command '$command' is already provided by agent '${COMMAND_OWNER[$command]}'"
        pc_warn "$id: $err"
      fi
    elif [ -z "$err" ] || [ -d "$dir" ]; then
      COMMAND_OWNER["$command"]="$id"
      write_shim "$id" "$command"
    fi

    if [ -d "$dir" ]; then
      printf '%s' "$spec" | jq -S . > "$dir/SPEC.json"
      chmod 0644 "$dir/SPEC.json"
      if [ "$installed" = "true" ] && [ "$carried" = "0" ]; then
        version="$(version_of "$command" "$spec")"
        [ -n "$version" ] || pc_warn "$id: the version probe produced no output"
      fi
      printf '%s' "$version" > "$dir/VERSION"
      chmod 0644 "$dir/VERSION"
      if [ -n "$err" ]; then
        printf '%s\n' "$err" > "$dir/ERROR"
        chmod 0644 "$dir/ERROR"
      else
        rm -f "$dir/ERROR"
      fi
    fi

    MANIFEST_ROWS+=("$(manifest_row "$id" "$command" "$installed" "$version" "$err")")
    i=$((i + 1))
  done

  # agents that are no longer enabled never reach the stage; drop leftovers defensively.
  # Their AUTH VOLUME is a different volume and is never touched here.
  local d leftover
  for d in "$MOUNT"/agents/*; do
    [ -d "$d" ] || continue
    leftover="$(basename "$d")"
    if ! printf '%s' "$AGENTS_JSON" | jq -e --arg id "$leftover" 'any(.id == $id)' >/dev/null 2>&1; then
      pc_log "dropping the disabled agent '$leftover' from the payload"
      rm -rf "$d"
    fi
  done

  write_manifest
  chmod -R a+rX "$MOUNT"
  chmod 0755 "$MOUNT/bin"/* 2>/dev/null || :
  [ -f "$MOUNT/entrypoint.sh" ] && chmod 0755 "$MOUNT/entrypoint.sh"
  pc_log "manifest:"
  cat "$MOUNT/AGENTS.json"
}

main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --plan) PLAN=1 ;;
      --pc-install-one) CHILD=1 ;;
      -h|--help) usage; exit 0 ;;
      *) pc_die "unknown argument: $1" ;;
    esac
    shift
  done

  if [ "$CHILD" = "1" ]; then
    install_child
    exit $?
  fi

  validate_specs

  if [ "$PLAN" = "1" ]; then
    print_plan
    exit 0
  fi

  sync_agents
  exit 0
}

main "$@"
