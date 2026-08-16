#!/usr/bin/env bash
# PorterClaude — build + deploy to the reference Portainer host. OWNER: O2.
# Runs under Git Bash on Windows and on Linux. Full spec: docs/design/orchestration.md §7.
#
# SECURITY RULES (non-negotiable):
#   * never `set -x`
#   * never echo $PORTAINER_API_KEY, never pass it as a curl argument (it shows up in `ps`):
#     write it into a chmod-600 curl config file inside a mktemp -d dir removed by an EXIT trap
#   * never write the key into deploy/.build/* or into any committed file
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$REPO_ROOT/deploy/.build"
ENV_FILE="$REPO_ROOT/deploy/.env"
COMPOSE_SRC="$REPO_ROOT/deploy/docker-compose.yml"
STACK_FILE="$BUILD_DIR/stack.yml"
CONTEXT_TAR="$BUILD_DIR/context.tar"
LIB_DIR="$REPO_ROOT/deploy/lib"
SECRET_ENV_VARS="APP_PASSWORD"     # kept literal in the stack file, passed via the Env array

DRY_RUN=0; DO_BUILD=1; DO_DEPLOY=1; DO_WAIT=1; APP_IMAGE_OVERRIDE=""
PY=""             # python3 or python
TMPDIR_SECURE=""  # mktemp -d, holds the curl config with the API key
RESPONSE_FILE=""  # api_json writes response bodies here (inside TMPDIR_SECURE)

usage() {
  cat <<'USAGE'
usage: deploy/deploy.sh [options]
  --dry-run           no network: only tar the context and render the stack file
  --build-only        build the image on the remote engine, do not touch the stack
  --deploy-only       skip the build, only create/update the stack
  --no-wait           do not poll the health endpoint afterwards
  --tag <image-ref>   override APP_IMAGE (default: porterclaude:local)
  --env-file <path>   default: deploy/.env
  -h, --help          this text
USAGE
}

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -n "${TMPDIR_SECURE:-}" ] && [ -d "${TMPDIR_SECURE:-}" ]; then
    rm -rf "$TMPDIR_SECURE"
  fi
}
trap cleanup EXIT

have() { command -v "$1" >/dev/null 2>&1; }

# Secure scratch dir: everything that touches a secret (env copy, curl config, request
# bodies, response bodies) lives here and nowhere else. Removed by the EXIT trap.
ensure_tmpdir() {
  if [ -n "$TMPDIR_SECURE" ]; then return 0; fi
  local old_umask
  old_umask="$(umask)"
  umask 077
  TMPDIR_SECURE="$(mktemp -d 2>/dev/null || mktemp -d -t porterclaude)"
  umask "$old_umask"
  [ -d "$TMPDIR_SECURE" ] || die "could not create a temporary directory"
  chmod 700 "$TMPDIR_SECURE"
  RESPONSE_FILE="$TMPDIR_SECURE/response.json"
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run)     DRY_RUN=1 ;;
      --build-only)  DO_DEPLOY=0 ;;
      --deploy-only) DO_BUILD=0 ;;
      --no-wait)     DO_WAIT=0 ;;
      --tag)         shift; [ $# -gt 0 ] || { usage >&2; exit 2; }; APP_IMAGE_OVERRIDE="$1" ;;
      --tag=*)       APP_IMAGE_OVERRIDE="${1#*=}" ;;
      --env-file)    shift; [ $# -gt 0 ] || { usage >&2; exit 2; }; ENV_FILE="$1" ;;
      --env-file=*)  ENV_FILE="${1#*=}" ;;
      -h|--help)     usage; exit 0 ;;
      *)             printf 'unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
    shift
  done
  if [ "$DO_BUILD" -eq 0 ] && [ "$DO_DEPLOY" -eq 0 ]; then
    die "--build-only and --deploy-only are mutually exclusive"
  fi
}

# --- env -----------------------------------------------------------------------------------
load_env() {
  [ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE (copy deploy/.env.example to deploy/.env)"
  ensure_tmpdir
  # Strip CR so a CRLF .env edited on Windows does not smuggle \r into values (and into URLs).
  local safe_env="$TMPDIR_SECURE/env.sh"
  tr -d '\r' < "$ENV_FILE" > "$safe_env"
  chmod 600 "$safe_env"
  set -a
  # shellcheck disable=SC1090
  . "$safe_env"
  set +a
  rm -f "$safe_env"

  local missing="" var
  for var in PORTAINER_URL PORTAINER_ENDPOINT_ID PORTAINER_API_KEY APP_HOSTNAME APP_PASSWORD STACK_NAME; do
    if [ -z "${!var:-}" ]; then missing="$missing $var"; fi
  done
  [ -z "$missing" ] || die "missing in $ENV_FILE:$missing"

  PORTAINER_URL="${PORTAINER_URL%/}"
  APP_IMAGE="${APP_IMAGE_OVERRIDE:-${APP_IMAGE:-porterclaude:local}}"
  HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
  HEALTH_URL="${HEALTH_URL:-https://$APP_HOSTNAME/api/health}"
  export PORTAINER_URL APP_IMAGE HEALTH_TIMEOUT HEALTH_URL
  log "target: $PORTAINER_URL endpoint $PORTAINER_ENDPOINT_ID, stack '$STACK_NAME', image '$APP_IMAGE'"
}

# --- curl plumbing (API key never on the command line) ---------------------------------------
setup_curl_config() {
  ensure_tmpdir
  local cfg="$TMPDIR_SECURE/curl.cfg"
  ( umask 077; printf 'header = "X-API-Key: %s"\n' "$PORTAINER_API_KEY" > "$cfg" )
  chmod 600 "$cfg"
}

# curl with the API key config attached. Usage: pcurl <curl args...>
pcurl() {
  curl -sS --config "$TMPDIR_SECURE/curl.cfg" "$@"
}

# api_json <METHOD> <URL> [<body-file>] -> prints the HTTP status, body lands in $RESPONSE_FILE
api_json() {
  local method="$1" url="$2" body="${3:-}"
  if [ -n "$body" ]; then
    pcurl -o "$RESPONSE_FILE" -w '%{http_code}' -X "$method" \
      -H 'Content-Type: application/json' --data-binary "@$body" "$url"
  else
    pcurl -o "$RESPONSE_FILE" -w '%{http_code}' -X "$method" "$url"
  fi
}

response_excerpt() {
  [ -f "$RESPONSE_FILE" ] || return 0
  head -c 400 "$RESPONSE_FILE" | tr -d '\r\n'
}

# Last `HTTP/x nnn` status line of a `curl --dump-header` file (skips 100-continue and
# redirect hops). Prints nothing when curl never got a response.
http_status_from_headers() {
  [ -s "$1" ] || return 0
  tr -d '\r' < "$1" | awk '/^[Hh][Tt][Tt][Pp]\// { code = $2 } END { if (code != "") print code }'
}

require_tools() {
  have tar || die "tar not found"
  if have python3; then PY="python3"; elif have python; then PY="python"; else
    die "python3 (or python) not found — deploy/lib/*.py need it"
  fi
}

preflight() {
  have curl || die "curl not found"
  local code
  code="$(api_json GET "$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/_ping" || true)"
  case "$code" in
    200) log "portainer reachable (docker _ping ok)" ;;
    401|403) die "portainer rejected the API key (HTTP $code) — check PORTAINER_API_KEY" ;;
    404) die "endpoint $PORTAINER_ENDPOINT_ID not found (HTTP 404) — check PORTAINER_ENDPOINT_ID" ;;
    000|"") die "cannot reach $PORTAINER_URL — check PORTAINER_URL / network / TLS" ;;
    *) die "unexpected reply from $PORTAINER_URL (HTTP $code): $(response_excerpt)" ;;
  esac
}

# --- steps ------------------------------------------------------------------------------------
build_context_tar() {
  ensure_tmpdir
  mkdir -p "$BUILD_DIR"
  local list="$TMPDIR_SECURE/context.files"
  "$PY" "$LIB_DIR/dockerignore.py" --root "$REPO_ROOT" --print0 > "$list"
  local count size
  count="$(tr -cd '\0' < "$list" | wc -c | tr -d ' ')"
  [ "${count:-0}" -gt 0 ] || die "the build context is empty — check .dockerignore"
  rm -f "$CONTEXT_TAR"
  ( cd "$REPO_ROOT" && tar -cf "$CONTEXT_TAR" --null -T "$list" )
  size="$(wc -c < "$CONTEXT_TAR" | tr -d ' ')"
  log "context: $count files, $((size / 1024)) KiB -> $CONTEXT_TAR"

  local listing="$TMPDIR_SECURE/context.listing"
  tar -tf "$CONTEXT_TAR" > "$listing"
  grep -qE '(^|/)docker/Dockerfile$' "$listing" || die "context tar does not contain docker/Dockerfile"
  if grep -qE '(^|/)deploy/\.env' "$listing"; then
    die "SECURITY: deploy/.env leaked into the build context — fix .dockerignore before deploying"
  fi
  # A DATA_DIR inside the checkout (data/, data.dev.*, data.qa.* ...) holds secret.key plus
  # config.json — i.e. the encrypted Portainer API key AND the key that decrypts it. The
  # `build` stage does `COPY . .`, so anything in the tar is baked into an image layer on
  # the remote host. Defence in depth on top of .dockerignore's `data*` rule.
  if grep -qE '(^|/)secret\.key$' "$listing"; then
    die "SECURITY: a secret.key leaked into the build context — fix .dockerignore before deploying"
  fi
  if grep -qE '(^|/)data[^/]*/(.*/)?config\.json$' "$listing"; then
    die "SECURITY: a DATA_DIR config.json leaked into the build context — fix .dockerignore before deploying"
  fi
  if grep -qE '(^|/)(node_modules|\.git)/' "$listing"; then
    warn "the context contains node_modules/ or .git/ — the build will be slow; check .dockerignore"
  fi
}

remote_build() {
  log "building $APP_IMAGE on endpoint $PORTAINER_ENDPOINT_ID (this runs on the remote engine)"
  ensure_tmpdir
  local url hdr code stream_rc=0
  hdr="$TMPDIR_SECURE/build.headers"
  rm -f "$hdr"
  url="$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/build"
  url="$url?t=$APP_IMAGE&dockerfile=docker/Dockerfile&rm=1&forcerm=1&pull=1"
  # Two independent failure channels, both of which must be checked:
  #   * the HTTP status — a rejected key, or a reverse proxy in front of Portainer timing the
  #     upload out, answers non-2xx with JSON or an HTML error page and never builds anything;
  #     it is captured with --dump-header so the body can still stream live through the pipe.
  #   * the JSON-lines body — docker answers 200 and reports build failures inside the stream;
  #     build-stream also fails when the stream carries no success marker at all.
  # Trusting only the pipe (or only the status) is how a stale image gets deployed silently.
  if ! pcurl -N --dump-header "$hdr" -X POST -H 'Content-Type: application/x-tar' \
        --data-binary "@$CONTEXT_TAR" "$url" | "$PY" "$LIB_DIR/portainer.py" build-stream; then
    stream_rc=1
  fi
  code="$(http_status_from_headers "$hdr")"
  case "${code:-}" in
    2??) ;;
    "")  die "no HTTP response from the build endpoint — check PORTAINER_URL / network / TLS" ;;
    401|403) die "portainer rejected the API key on /docker/build (HTTP $code) — nothing was built" ;;
    502|503|504)
      die "the build request never reached the engine (HTTP $code from the proxy in front of Portainer) — nothing was built; raise that proxy's read timeout for /api/endpoints/*/docker/build" ;;
    *) die "the build request failed (HTTP $code) — nothing was built" ;;
  esac
  [ "$stream_rc" -eq 0 ] || die "image build failed on the remote engine (see the log above)"
  log "image built: $APP_IMAGE"
}

render_stack() {
  mkdir -p "$BUILD_DIR"
  "$PY" "$LIB_DIR/render_compose.py" "$COMPOSE_SRC" \
    --keep "$SECRET_ENV_VARS" --out "$STACK_FILE" \
    || die "rendering $COMPOSE_SRC failed (see the message above)"
  log "rendered $STACK_FILE (secrets stay literal and travel in the stack env array)"
}

find_stack_id() {
  local code
  code="$(api_json GET "$PORTAINER_URL/api/stacks" || true)"
  case "$code" in
    200) ;;
    *) die "GET /api/stacks failed (HTTP $code): $(response_excerpt)" ;;
  esac
  "$PY" "$LIB_DIR/portainer.py" find-stack --name "$STACK_NAME" --endpoint "$PORTAINER_ENDPOINT_ID" \
    < "$RESPONSE_FILE"
}

stack_body_file() {
  # $1 = extra flags for portainer.py stack-body; prints the path of the generated body file
  local body="$TMPDIR_SECURE/stack-body.json"
  # shellcheck disable=SC2086
  "$PY" "$LIB_DIR/portainer.py" stack-body --file "$STACK_FILE" --name "$STACK_NAME" \
    --env "$SECRET_ENV_VARS" $1 > "$body"
  chmod 600 "$body"
  printf '%s' "$body"
}

create_stack() {
  log "creating stack '$STACK_NAME'"
  local body code
  body="$(stack_body_file "")"
  code="$(api_json POST \
    "$PORTAINER_URL/api/stacks/create/standalone/string?endpointId=$PORTAINER_ENDPOINT_ID" "$body" || true)"
  if [ "$code" = "404" ] || [ "$code" = "405" ]; then
    warn "standalone/string endpoint unavailable (HTTP $code) — retrying the legacy stack API"
    body="$(stack_body_file "--legacy")"
    code="$(api_json POST \
      "$PORTAINER_URL/api/stacks?type=2&method=string&endpointId=$PORTAINER_ENDPOINT_ID" "$body" || true)"
  fi
  case "$code" in
    2??) log "stack created" ;;
    *) die "stack create failed (HTTP $code): $(response_excerpt)" ;;
  esac
}

update_stack() {
  local sid="$1" body code
  log "updating stack '$STACK_NAME' (id $sid)"
  body="$(stack_body_file "--update")"
  code="$(api_json PUT "$PORTAINER_URL/api/stacks/$sid?endpointId=$PORTAINER_ENDPOINT_ID" "$body" || true)"
  case "$code" in
    2??) log "stack updated (prune=true, pullImage=false)" ;;
    *) die "stack update failed (HTTP $code): $(response_excerpt)" ;;
  esac
}

wait_healthy() {
  log "waiting for $HEALTH_URL (timeout ${HEALTH_TIMEOUT}s)"
  local started now elapsed body
  started="$(date +%s)"
  while :; do
    body="$(curl -sS -m 10 "$HEALTH_URL" 2>/dev/null || true)"
    if printf '%s' "$body" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
      now="$(date +%s)"; elapsed=$((now - started))
      log "healthy after ${elapsed}s"
      return 0
    fi
    now="$(date +%s)"; elapsed=$((now - started))
    if [ "$elapsed" -ge "$HEALTH_TIMEOUT" ]; then
      die "health check timed out after ${elapsed}s — check the container logs for '$STACK_NAME' in Portainer"
    fi
    sleep 5
  done
}

main() {
  parse_args "$@"
  require_tools
  load_env
  if [ "$DRY_RUN" -eq 1 ]; then
    log "dry run: tarring context and rendering the stack file only"
    build_context_tar
    render_stack
    log "wrote $CONTEXT_TAR and $STACK_FILE"
    return 0
  fi
  setup_curl_config
  preflight
  if [ "$DO_BUILD" -eq 1 ]; then build_context_tar; remote_build; fi
  if [ "$DO_DEPLOY" -eq 1 ]; then
    render_stack
    local sid
    sid="$(find_stack_id)"
    if [ -n "$sid" ]; then update_stack "$sid"; else create_stack; fi
  fi
  if [ "$DO_WAIT" -eq 1 ] && [ "$DO_DEPLOY" -eq 1 ]; then wait_healthy; fi
  log "done"
}

main "$@"
