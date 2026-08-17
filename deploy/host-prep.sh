#!/usr/bin/env bash
# PorterClaude — one-off host preparation through the Portainer API. OWNER: O2.
# OPTIONAL and NOT part of deploy.sh: every step is opt-in behind its own flag, and
# --dry-run prints exactly what each one would do without changing anything.
#
# It exists because the reference host needs things deploy.sh must never do behind the
# operator's back:
#   --clean   remove leftover QA session containers (porterclaude.managed=true, named
#             pc-qa-* / pc-o1-*) together with their workspace/history volumes
#   --prune   remove DANGLING images that carry porterclaude.* labels (every recipe rebuild
#             and every tools sync leaves one behind: ~1-2 GB each; since v0.2 the app-image
#             stages built by deploy.sh are labelled porterclaude.image=app and collected too)
#   --vhost   write vhost.d/<portainer-host> and vhost.d/<app-host> for nginx-proxy so that
#             long /docker/build streams and idle terminal WebSockets stop being cut at 60 s
#   --reload  HUP the nginx-proxy container so it picks the new vhost files up
#
# SECURITY RULES: identical to deploy.sh, implemented in deploy/lib/common.sh — the API key
# lives only in a chmod-600 curl config inside a mktemp -d directory, never on a command
# line, never in a log, never in a committed file. Never `set -x`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/deploy/.env"
LIB_DIR="$REPO_ROOT/deploy/lib"

# shellcheck source=lib/common.sh
. "$LIB_DIR/common.sh"

DRY_RUN=0; DO_CLEAN=0; DO_PRUNE=0; DO_VHOST=0; DO_RELOAD=0; OFFLINE=0
PY=""
PLANNED=0                                   # how much a real run would have changed
QA_PREFIXES="${HOST_PREP_PREFIXES:-pc-qa- pc-o1-}"   # --clean only ever touches these names
PROXY_MATCHES="nginx-proxy nginxproxy"      # how the reverse proxy container is recognised
HELPER_IMAGE="${HOST_PREP_IMAGE:-alpine:3.20}"
PORTAINER_HOST=""; APP_HOST=""; VHOST_DIR_DEFAULT=""

usage() {
  cat <<'USAGE'
usage: deploy/host-prep.sh [--dry-run] <action>... [--env-file <path>]

actions (each is opt-in; without one the script does nothing):
  --clean     remove containers labelled porterclaude.managed=true whose name starts with
              pc-qa- or pc-o1-, plus their porterclaude-ws-* / porterclaude-hist-* volumes
  --prune     remove dangling images that carry a porterclaude.* label (recipe and tools
              builds, plus the app-image stages every deploy.sh run leaves behind)
  --vhost     write nginx-proxy vhost.d snippets for the Portainer host (long build streams)
              and for the app host (idle terminal WebSockets)
  --reload    send SIGHUP to the nginx-proxy container so it reloads its configuration
  --all       all four, in that order

options:
  --dry-run           print what every selected action WOULD do and change nothing
  --env-file <path>   default: deploy/.env
  -h, --help          this text

deploy/deploy.sh never calls this script: host preparation stays a deliberate manual step.
USAGE
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run)    DRY_RUN=1 ;;
      --clean)      DO_CLEAN=1 ;;
      --prune)      DO_PRUNE=1 ;;
      --vhost)      DO_VHOST=1 ;;
      --reload)     DO_RELOAD=1 ;;
      --all)        DO_CLEAN=1; DO_PRUNE=1; DO_VHOST=1; DO_RELOAD=1 ;;
      --env-file)   shift; [ $# -gt 0 ] || { usage >&2; exit 2; }; ENV_FILE="$1" ;;
      --env-file=*) ENV_FILE="${1#*=}" ;;
      -h|--help)    usage; exit 0 ;;
      *)            printf 'unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
    shift
  done
  if [ $((DO_CLEAN + DO_PRUNE + DO_VHOST + DO_RELOAD)) -eq 0 ]; then
    printf 'nothing to do: pick at least one action\n\n' >&2
    usage >&2
    exit 2
  fi
}

require_tools() {
  have curl || die "curl not found"
  have base64 || die "base64 not found"
  if have python3; then PY="python3"; elif have python; then PY="python"; else
    die "python3 (or python) not found — deploy/lib/portainer.py needs it"
  fi
}

load_env() {
  pc_load_env_file "$ENV_FILE"
  pc_require_env "$ENV_FILE" PORTAINER_URL PORTAINER_ENDPOINT_ID PORTAINER_API_KEY
  PORTAINER_URL="${PORTAINER_URL%/}"
  PORTAINER_HOST="$(pc_url_host "$PORTAINER_URL")"
  APP_HOST="${APP_HOSTNAME:-}"
  VHOST_DIR_DEFAULT="${NGINX_VHOST_DIR:-/srv/nginx/vhost.d}"
  log "target: $PORTAINER_URL endpoint $PORTAINER_ENDPOINT_ID"
}

# One line per thing that changes state: "would ..." in a dry run, "==> ..." otherwise.
act() {
  PLANNED=$((PLANNED + 1))
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '\033[1;36m  would\033[0m %s\n' "$*"
  else
    log "$*"
  fi
}

pyx() { "$PY" "$LIB_DIR/portainer.py" "$@"; }

# Read-only GET into $RESPONSE_FILE; warns and returns 1 when the call fails.
api_get() {
  local code
  if [ "$OFFLINE" -eq 1 ]; then return 1; fi
  code="$(pc_api_json GET "$1" || true)"
  case "$code" in
    2??) return 0 ;;
    *) warn "GET ${1#"$PORTAINER_URL"} failed (HTTP ${code:-000}): $(pc_response_excerpt)"
       return 1 ;;
  esac
}

# JSON-encode a string (python does the escaping — never hand-rolled concatenation).
json_string() {
  printf '%s' "$1" | "$PY" -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))'
}

# ---------------------------------------------------------------------------------------
# --clean : leftover QA session containers and their volumes
# ---------------------------------------------------------------------------------------
clean_qa_containers() {
  log "--clean: containers labelled porterclaude.managed=true named ${QA_PREFIXES// /, }"
  local base args prefix listing cid name state vols vol code
  base="$(pc_docker_api)"
  if ! api_get "$base/containers/json?all=1"; then
    warn "  cannot list containers — --clean skipped"
    return 0
  fi

  args=""
  for prefix in $QA_PREFIXES; do args="$args --name-prefix $prefix"; done
  listing="$TMPDIR_SECURE/qa-containers.tsv"
  # A name prefix AND the porterclaude.managed label are both required: this must never be
  # able to touch a container someone else owns.
  # shellcheck disable=SC2086
  pyx filter-containers --label porterclaude.managed=true $args < "$RESPONSE_FILE" > "$listing"

  if [ ! -s "$listing" ]; then
    log "  no leftover QA containers"
    return 0
  fi
  while IFS="$(printf '\t')" read -r cid name state; do
    [ -n "$cid" ] || continue
    # Named workspace/history volumes are only reachable through the container spec, so they
    # have to be collected BEFORE the container disappears. The prefix list is deliberately
    # short: the per-agent auth volumes (porterclaude-auth-<agentId>) hold the LOGINS and are
    # shared by every session on the host — they must never be removed with a QA container.
    vols=""
    if api_get "$base/containers/$cid/json"; then
      vols="$(pyx mount-volumes --prefix porterclaude-ws- --prefix porterclaude-hist- \
              < "$RESPONSE_FILE" || true)"
    fi
    act "remove container $name ($state)"
    if [ "$DRY_RUN" -eq 0 ]; then
      code="$(pc_api_json DELETE "$base/containers/$cid?force=1&v=1" || true)"
      case "$code" in
        2??) ;;
        *) warn "  removing $name failed (HTTP $code): $(pc_response_excerpt)"; continue ;;
      esac
    fi
    for vol in $vols; do
      act "remove volume $vol"
      if [ "$DRY_RUN" -eq 0 ]; then
        code="$(pc_api_json DELETE "$base/volumes/$vol" || true)"
        case "$code" in
          2??|404) ;;
          *) warn "  removing volume $vol failed (HTTP $code)" ;;
        esac
      fi
    done
  done < "$listing"
}

# ---------------------------------------------------------------------------------------
# --prune : dangling images that carry porterclaude.* labels
# ---------------------------------------------------------------------------------------
prune_dangling_images() {
  log "--prune: dangling images labelled porterclaude.*"
  local base listing iid size labels total code
  base="$(pc_docker_api)"
  # filters={"dangling":["true"]}
  if ! api_get "$base/images/json?filters=%7B%22dangling%22%3A%5B%22true%22%5D%7D"; then
    warn "  cannot list images — --prune skipped"
    return 0
  fi

  listing="$TMPDIR_SECURE/dangling.tsv"
  # Only images this project produced: a bare `docker image prune` would also eat unrelated
  # build cache belonging to whoever else uses the host.
  pyx filter-images --label-prefix porterclaude. < "$RESPONSE_FILE" > "$listing"
  if [ ! -s "$listing" ]; then
    log "  no dangling porterclaude images"
    return 0
  fi
  total=0
  while IFS="$(printf '\t')" read -r iid size labels; do
    [ -n "$iid" ] || continue
    total=$((total + ${size:-0}))
    act "remove dangling image ${iid#sha256:} ($(( ${size:-0} / 1048576 )) MiB, $labels)"
    if [ "$DRY_RUN" -eq 0 ]; then
      code="$(pc_api_json DELETE "$base/images/$iid" || true)"
      case "$code" in
        2??) ;;
        409) warn "  ${iid#sha256:} is still referenced — kept" ;;
        *) warn "  removing ${iid#sha256:} failed (HTTP $code): $(pc_response_excerpt)" ;;
      esac
    fi
  done < "$listing"
  log "  $(( total / 1048576 )) MiB in dangling porterclaude images"
}

# ---------------------------------------------------------------------------------------
# --vhost : nginx-proxy per-host snippets
# ---------------------------------------------------------------------------------------
# The Portainer vhost carries the long-stream settings — they cover the app-image build, the
# recipe/tools image builds and the tools-sync container's log stream (a first sync downloads
# the host's coding agents and runs for minutes). The app vhost only needs the two timeouts
# (terminals are idle WebSockets — buffering stays on for ordinary app traffic).
portainer_vhost_body() {
  cat <<'CONF'
# PorterClaude (deploy/host-prep.sh --vhost): Portainer proxies long-running docker streams
# (POST /api/endpoints/*/docker/build, container logs/attach). With nginx defaults a build is
# cut after 60s with an HTML 504 and docker aborts it.
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;
proxy_request_buffering off;
client_max_body_size 0;
CONF
}

app_vhost_body() {
  cat <<'CONF'
# PorterClaude (deploy/host-prep.sh --vhost): terminal WebSockets sit idle between keystrokes
# and nginx's default proxy_read_timeout (60s) would drop them.
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
CONF
}

# id of the nginx-proxy container, or nothing.
find_proxy_container() {
  local base args match
  base="$(pc_docker_api)"
  api_get "$base/containers/json?all=1" || return 0
  args=""
  for match in $PROXY_MATCHES; do args="$args --match $match"; done
  # shellcheck disable=SC2086
  pyx find-container $args < "$RESPONSE_FILE" | cut -f1
}

# Host directory the nginx-proxy container has mounted at /etc/nginx/vhost.d (asking the
# container beats guessing: the reference host and a stock nginx-proxy differ).
find_vhost_dir() {
  local base cid dir
  base="$(pc_docker_api)"
  cid="$(find_proxy_container || true)"
  if [ -n "$cid" ] && api_get "$base/containers/$cid/json"; then
    # No leading slash on --dest: under Git Bash an argument that looks like an absolute
    # POSIX path is rewritten into a Windows path before it reaches (native) python.
    dir="$(pyx mount-source --dest etc/nginx/vhost.d < "$RESPONSE_FILE" || true)"
    if [ -n "$dir" ]; then printf '%s' "$dir"; return 0; fi
  fi
  printf '%s' "$VHOST_DIR_DEFAULT"
}

apply_vhosts() {
  log "--vhost: nginx-proxy per-host configuration"
  local dir cmds b64 which host body spec
  dir="$(find_vhost_dir)"
  log "  vhost.d on the host: $dir"

  cmds="set -e; mkdir -p /vhost"
  for which in portainer app; do
    if [ "$which" = "portainer" ]; then
      host="$PORTAINER_HOST"; body="$(portainer_vhost_body)"
    else
      host="$APP_HOST"; body="$(app_vhost_body)"
    fi
    if [ -z "$host" ]; then
      warn "  no hostname for the $which vhost (APP_HOSTNAME unset?) — skipped"
      continue
    fi
    # base64 keeps quoting, newlines and '#' out of the container command line entirely.
    b64="$(printf '%s\n' "$body" | base64 | tr -d '\r\n')"
    cmds="$cmds; echo $b64 | base64 -d > /vhost/$host; chmod 0644 /vhost/$host"
    act "write $dir/$host"
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '%s\n' "$body" | sed 's/^/        /'
    fi
  done

  if [ "$DRY_RUN" -eq 1 ]; then
    act "run a throwaway $HELPER_IMAGE container with $dir bind-mounted at /vhost to write them"
    return 0
  fi

  spec="$TMPDIR_SECURE/vhost-container.json"
  printf '{"Image":"%s","Cmd":["sh","-c",%s],"Tty":true,'\
'"Labels":{"porterclaude.managed":"true","porterclaude.role":"host-prep"},'\
'"HostConfig":{"Binds":[%s],"AutoRemove":false,"NetworkMode":"none"}}\n' \
    "$HELPER_IMAGE" "$(json_string "$cmds")" "$(json_string "$dir:/vhost")" > "$spec"
  chmod 600 "$spec"
  run_helper_container "$spec" "pc-hostprep-vhost-$$" \
    || warn "  writing the vhost files failed — do it by hand, see docs/DEPLOYMENT.md"
}

# run_helper_container <body-file> <name> — create, start, wait, echo logs, remove
run_helper_container() {
  local body="$1" name="$2" base code cid exit_code
  base="$(pc_docker_api)"
  code="$(pc_api_json POST \
    "$base/images/create?fromImage=${HELPER_IMAGE%:*}&tag=${HELPER_IMAGE##*:}" || true)"
  case "$code" in
    2??) ;;
    *) warn "could not pull $HELPER_IMAGE (HTTP $code) — trying anyway, it may be present" ;;
  esac

  code="$(pc_api_json POST "$base/containers/create?name=$name" "$body" || true)"
  case "$code" in
    2??) ;;
    *) warn "creating $name failed (HTTP $code): $(pc_response_excerpt)"; return 1 ;;
  esac
  cid="$(pyx json-get --path Id < "$RESPONSE_FILE")"
  [ -n "$cid" ] || { warn "no container id in the create response"; return 1; }

  code="$(pc_start_container "$base" "$cid")"
  case "$code" in
    2??) ;;
    *) warn "starting $name failed (HTTP $code): $(pc_response_excerpt)"
       pc_api_json DELETE "$base/containers/$cid?force=1&v=1" >/dev/null 2>&1 || true
       return 1 ;;
  esac
  pc_api_json POST "$base/containers/$cid/wait" >/dev/null 2>&1 || true
  exit_code="$(pyx json-get --path StatusCode < "$RESPONSE_FILE" || true)"
  pcurl -o "$TMPDIR_SECURE/helper.log" "$base/containers/$cid/logs?stdout=1&stderr=1" \
    >/dev/null 2>&1 || true
  if [ -s "$TMPDIR_SECURE/helper.log" ]; then
    sed 's/^/    /' "$TMPDIR_SECURE/helper.log" || true
  fi
  pc_api_json DELETE "$base/containers/$cid?force=1&v=1" >/dev/null 2>&1 || true
  if [ "${exit_code:-1}" != "0" ]; then
    warn "$name exited with ${exit_code:-?}"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------------------
# --reload : HUP nginx-proxy
# ---------------------------------------------------------------------------------------
reload_proxy() {
  log "--reload: reloading nginx-proxy"
  local base cid code
  base="$(pc_docker_api)"
  cid="$(find_proxy_container || true)"
  if [ -z "$cid" ]; then
    warn "  no container matching ${PROXY_MATCHES// /, } — nothing to reload"
    return 0
  fi
  act "send SIGHUP to the nginx-proxy container (${cid:0:12})"
  if [ "$DRY_RUN" -eq 0 ]; then
    code="$(pc_api_json POST "$base/containers/$cid/kill?signal=HUP" || true)"
    case "$code" in
      2??) log "  reloaded" ;;
      *) warn "  SIGHUP failed (HTTP $code): $(pc_response_excerpt)" ;;
    esac
  fi
}

main() {
  parse_args "$@"
  require_tools
  load_env
  pc_setup_curl_config
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY RUN — read-only queries only; nothing is created, removed or written"
    # A dry run must still work without a reachable Portainer: it then describes the plan
    # instead of listing the concrete containers/images it found.
    if ! ( pc_preflight >/dev/null 2>&1 ); then
      OFFLINE=1
      warn "portainer is not reachable — describing the actions without inspecting the host"
    fi
  else
    pc_preflight
  fi
  if [ "$DO_CLEAN"  -eq 1 ]; then clean_qa_containers; fi
  if [ "$DO_PRUNE"  -eq 1 ]; then prune_dangling_images; fi
  if [ "$DO_VHOST"  -eq 1 ]; then apply_vhosts; fi
  if [ "$DO_RELOAD" -eq 1 ]; then reload_proxy; fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "dry run finished: $PLANNED change(s) would be made"
  else
    log "done"
  fi
}

main "$@"
