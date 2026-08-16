#!/usr/bin/env bash
# PorterClaude — build + deploy to the reference Portainer host. OWNER: O2.
# Runs under Git Bash on Windows and on Linux. Full spec: docs/design/orchestration.md §7.
#
# SECURITY RULES (non-negotiable, implemented in deploy/lib/common.sh):
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

# shellcheck source=lib/common.sh
. "$LIB_DIR/common.sh"

DRY_RUN=0; DO_BUILD=1; DO_DEPLOY=1; DO_WAIT=1; APP_IMAGE_OVERRIDE=""; PULL_IMAGE=0
IMAGE_MODE=0     # --image: no remote build, the stack points at a pullable/pre-built image
PY=""            # python3 or python

usage() {
  cat <<'USAGE'
usage: deploy/deploy.sh [options]
  --dry-run           no network: only tar the context and render the stack file
  --build-only        build the image on the remote engine, do not touch the stack
  --deploy-only       skip the build, only create/update the stack
  --no-wait           do not poll the health endpoint afterwards
  --tag <image-ref>   override APP_IMAGE for the remote build (default: porterclaude:local)
  --image <image-ref> skip the remote build entirely and deploy this already-built or
                      pullable image (e.g. ghcr.io/<owner>/porterclaude:v1.2.3). The stack
                      update asks Portainer to pull it. Use this when the proxy in front of
                      Portainer cuts long /docker/build requests — see docs/DEPLOYMENT.md.
  --env-file <path>   default: deploy/.env
  -h, --help          this text
USAGE
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
      --image)       shift; [ $# -gt 0 ] || { usage >&2; exit 2; }
                     APP_IMAGE_OVERRIDE="$1"; IMAGE_MODE=1 ;;
      --image=*)     APP_IMAGE_OVERRIDE="${1#*=}"; IMAGE_MODE=1 ;;
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
  if [ "$IMAGE_MODE" -eq 1 ]; then
    [ -n "$APP_IMAGE_OVERRIDE" ] || die "--image needs an image reference"
    if [ "$DO_DEPLOY" -eq 0 ]; then
      die "--image and --build-only are mutually exclusive (--image is the no-build mode)"
    fi
    DO_BUILD=0
    PULL_IMAGE=1
  fi
}

# --- env -----------------------------------------------------------------------------------
load_env() {
  pc_load_env_file "$ENV_FILE"
  pc_require_env "$ENV_FILE" PORTAINER_URL PORTAINER_ENDPOINT_ID PORTAINER_API_KEY \
                 APP_HOSTNAME APP_PASSWORD STACK_NAME

  PORTAINER_URL="${PORTAINER_URL%/}"
  APP_IMAGE="${APP_IMAGE_OVERRIDE:-${APP_IMAGE:-porterclaude:local}}"
  HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
  HEALTH_URL="${HEALTH_URL:-https://$APP_HOSTNAME/api/health}"
  export PORTAINER_URL APP_IMAGE HEALTH_TIMEOUT HEALTH_URL
  log "target: $PORTAINER_URL endpoint $PORTAINER_ENDPOINT_ID, stack '$STACK_NAME', image '$APP_IMAGE'"
  if [ "$IMAGE_MODE" -eq 1 ]; then
    log "--image: no remote build; the stack update pulls '$APP_IMAGE'"
  fi
}

require_tools() {
  have tar || die "tar not found"
  if have python3; then PY="python3"; elif have python; then PY="python"; else
    die "python3 (or python) not found — deploy/lib/*.py need it"
  fi
}

# --- the gid of /var/run/docker.sock ----------------------------------------------------------
# The image runs as uid 10001, so socket mode only works when the container joins the group
# that owns the socket — a host-specific gid. When DOCKER_GID is not in the env file, ask the
# engine itself: a throwaway container that bind-mounts the socket read-only and prints
# `stat -c %g`. Failure is never fatal; the compose default (999) and a warning take over.
detect_docker_gid() {
  if [ -n "${DOCKER_GID:-}" ]; then
    log "DOCKER_GID=$DOCKER_GID (from $ENV_FILE)"
    return 0
  fi
  local base image repo tag name body code cid gid
  base="$(pc_docker_api)"
  image="${DOCKER_GID_PROBE_IMAGE:-alpine:3.20}"
  repo="${image%:*}"; tag="${image##*:}"
  [ "$repo" != "$image" ] || tag="latest"
  name="pc-deploy-gid-$$"
  log "DOCKER_GID unset in $ENV_FILE — probing the engine with a throwaway $image container"

  code="$(pc_api_json POST "$base/images/create?fromImage=$repo&tag=$tag" || true)"
  case "$code" in
    2??) ;;
    *) warn "could not pull $image (HTTP $code) — trying anyway, it may already be present" ;;
  esac

  body="$TMPDIR_SECURE/gid-probe.json"
  # Tty:true keeps the log stream unmultiplexed, NetworkMode:none keeps the probe offline,
  # and the socket is mounted READ-ONLY: this container only ever runs `stat`.
  printf '{"Image":"%s","Cmd":["stat","-c","%%g","/var/run/docker.sock"],"Tty":true,'\
'"Labels":{"porterclaude.managed":"true","porterclaude.role":"gid-probe"},'\
'"HostConfig":{"Binds":["/var/run/docker.sock:/var/run/docker.sock:ro"],'\
'"AutoRemove":false,"NetworkMode":"none"}}\n' "$image" > "$body"
  chmod 600 "$body"

  code="$(pc_api_json POST "$base/containers/create?name=$name" "$body" || true)"
  case "$code" in
    2??) ;;
    *) warn "could not create the gid probe (HTTP $code): $(pc_response_excerpt)"; gid="" ;;
  esac
  cid=""
  case "$code" in
    2??) cid="$("$PY" "$LIB_DIR/portainer.py" json-get --path Id < "$RESPONSE_FILE")" ;;
  esac

  gid=""
  if [ -n "$cid" ]; then
    if [ "$(pc_start_container "$base" "$cid")" = "204" ]; then
      pc_api_json POST "$base/containers/$cid/wait" >/dev/null 2>&1 || true
      pcurl -o "$TMPDIR_SECURE/gid.log" "$base/containers/$cid/logs?stdout=1&stderr=1" \
        >/dev/null 2>&1 || true
      gid="$(tr -cd '0-9\n' < "$TMPDIR_SECURE/gid.log" 2>/dev/null | grep -m1 '[0-9]' || true)"
    else
      warn "the gid probe container did not start: $(pc_response_excerpt)"
    fi
    pc_api_json DELETE "$base/containers/$cid?force=1&v=1" >/dev/null 2>&1 || true
  fi

  if [ -n "$gid" ]; then
    DOCKER_GID="$gid"
    export DOCKER_GID
    log "detected DOCKER_GID=$DOCKER_GID (stat -c %g /var/run/docker.sock)"
  else
    warn "could not detect the docker socket gid — the stack falls back to the compose"
    warn "default (999). If Settings reports the socket as unavailable, run"
    warn "  stat -c %g /var/run/docker.sock   on the docker host and set DOCKER_GID in $ENV_FILE"
  fi
}

# --- steps ------------------------------------------------------------------------------------
build_context_tar() {
  pc_ensure_tmpdir
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
  pc_ensure_tmpdir
  local url hdr code stream_rc=0 started elapsed proxy_cut=0 html=0
  hdr="$TMPDIR_SECURE/build.headers"
  rm -f "$hdr"
  url="$(pc_docker_api)/build"
  url="$url?t=$APP_IMAGE&dockerfile=docker/Dockerfile&rm=1&forcerm=1&pull=1"
  started="$(date +%s)"
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
  elapsed=$(( $(date +%s) - started ))
  code="$(pc_http_status_from_headers "$hdr")"
  if pc_response_is_html "$hdr"; then html=1; fi

  case "${code:-}" in
    401|403) die "portainer rejected the API key on /docker/build (HTTP $code) — nothing was built" ;;
  esac

  # The reference host's failure mode: nginx in front of Portainer answers an HTML 504 after
  # ~60 s and docker aborts the build. Recognise it (proxy status, HTML body, or a failure
  # landing suspiciously close to the 60 s default) and print the remedy instead of a raw
  # status code that tells the operator nothing.
  case "${code:-}" in 502|503|504) proxy_cut=1 ;; esac
  if [ "$html" -eq 1 ]; then proxy_cut=1; fi
  if [ "$stream_rc" -ne 0 ] && [ "$elapsed" -ge 55 ] && [ "$elapsed" -le 95 ]; then proxy_cut=1; fi
  if [ "$proxy_cut" -eq 1 ]; then
    if [ "$html" -eq 1 ]; then
      warn "the build request ended after ${elapsed}s with HTTP ${code:-<no status>} and an HTML body"
    else
      warn "the build request ended after ${elapsed}s with HTTP ${code:-<no status>}"
    fi
    pc_proxy_timeout_hint "$(pc_url_host "$PORTAINER_URL")"
    die "the build never reached the engine (proxy timeout) — nothing was built, nothing was deployed"
  fi

  case "${code:-}" in
    2??) ;;
    "")  die "no HTTP response from the build endpoint — check PORTAINER_URL / network / TLS" ;;
    *) die "the build request failed (HTTP $code) — nothing was built" ;;
  esac
  [ "$stream_rc" -eq 0 ] || die "image build failed on the remote engine (see the log above)"
  log "image built: $APP_IMAGE (${elapsed}s)"
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
  code="$(pc_api_json GET "$PORTAINER_URL/api/stacks" || true)"
  case "$code" in
    200) ;;
    *) die "GET /api/stacks failed (HTTP $code): $(pc_response_excerpt)" ;;
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
  code="$(pc_api_json POST \
    "$PORTAINER_URL/api/stacks/create/standalone/string?endpointId=$PORTAINER_ENDPOINT_ID" "$body" || true)"
  if [ "$code" = "404" ] || [ "$code" = "405" ]; then
    warn "standalone/string endpoint unavailable (HTTP $code) — retrying the legacy stack API"
    body="$(stack_body_file "--legacy")"
    code="$(pc_api_json POST \
      "$PORTAINER_URL/api/stacks?type=2&method=string&endpointId=$PORTAINER_ENDPOINT_ID" "$body" || true)"
  fi
  case "$code" in
    2??) log "stack created" ;;
    *) die "stack create failed (HTTP $code): $(pc_response_excerpt)" ;;
  esac
}

update_stack() {
  local sid="$1" body code flags="--update"
  # The image was just built on that engine -> pullImage:false. With --image it comes from a
  # registry instead and Portainer has to fetch it.
  if [ "$PULL_IMAGE" -eq 1 ]; then flags="--update --pull"; fi
  log "updating stack '$STACK_NAME' (id $sid)"
  body="$(stack_body_file "$flags")"
  code="$(pc_api_json PUT "$PORTAINER_URL/api/stacks/$sid?endpointId=$PORTAINER_ENDPOINT_ID" "$body" || true)"
  case "$code" in
    2??)
      if [ "$PULL_IMAGE" -eq 1 ]; then
        log "stack updated (prune=true, pullImage=true — the image comes from a registry)"
      else
        log "stack updated (prune=true, pullImage=false — the image was just built there)"
      fi
      ;;
    *) die "stack update failed (HTTP $code): $(pc_response_excerpt)" ;;
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
    if [ -z "${DOCKER_GID:-}" ]; then
      warn "DOCKER_GID is unset — a real run probes the engine for it; the rendered file"
      warn "falls back to the compose default (999)"
    fi
    if [ "$DO_BUILD" -eq 1 ]; then
      build_context_tar
      render_stack
      log "wrote $CONTEXT_TAR and $STACK_FILE"
    else
      render_stack
      log "wrote $STACK_FILE (--image / --deploy-only: no build context)"
    fi
    return 0
  fi
  pc_setup_curl_config
  pc_preflight
  if [ "$DO_BUILD" -eq 1 ]; then build_context_tar; remote_build; fi
  if [ "$DO_DEPLOY" -eq 1 ]; then
    detect_docker_gid
    render_stack
    local sid
    sid="$(find_stack_id)"
    if [ -n "$sid" ]; then update_stack "$sid"; else create_stack; fi
  fi
  if [ "$DO_WAIT" -eq 1 ] && [ "$DO_DEPLOY" -eq 1 ]; then wait_healthy; fi
  log "done"
}

main "$@"
