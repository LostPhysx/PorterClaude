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
SECRET_ENV_VARS="APP_PASSWORD"     # kept literal in the stack file, passed via the Env array

DRY_RUN=0; DO_BUILD=1; DO_DEPLOY=1; DO_WAIT=1; APP_IMAGE_OVERRIDE=""
PY=""            # python3 or python
TMPDIR_SECURE=""  # mktemp -d, holds the curl config with the API key

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

cleanup() { [ -n "$TMPDIR_SECURE" ] && rm -rf "$TMPDIR_SECURE"; }
trap cleanup EXIT

parse_args() {
  # TODO(O2): parse the flags above; unknown flag -> usage + exit 2
  :
}

# --- env -----------------------------------------------------------------------------------
load_env() {
  # TODO(O2): [ -f "$ENV_FILE" ] || die; set -a; . "$ENV_FILE"; set +a
  #   require: PORTAINER_URL PORTAINER_ENDPOINT_ID PORTAINER_API_KEY APP_HOSTNAME
  #            APP_PASSWORD STACK_NAME
  #   defaults: APP_IMAGE=${APP_IMAGE:-porterclaude:local} (overridden by --tag),
  #             HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-180},
  #             HEALTH_URL=${HEALTH_URL:-https://$APP_HOSTNAME/api/health}
  #   strip a trailing slash from PORTAINER_URL
  :
}

# --- curl plumbing (API key never on the command line) ---------------------------------------
setup_curl_config() {
  # TODO(O2): TMPDIR_SECURE=$(mktemp -d); umask 077
  #   printf 'header = "X-API-Key: %s"\n' "$PORTAINER_API_KEY" > "$TMPDIR_SECURE/curl.cfg"
  #   chmod 600 "$TMPDIR_SECURE/curl.cfg"
  :
}

# curl with the API key config attached. Usage: pcurl <curl args...>
pcurl() {
  # TODO(O2): curl -sS --config "$TMPDIR_SECURE/curl.cfg" "$@"
  :
}

preflight() {
  # TODO(O2): require curl + tar; resolve $PY (python3 || python) or die;
  #   pcurl -o /dev/null -w '%{http_code}' "$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/_ping"
  #   -> expect 200, otherwise die with a hint (URL / endpoint id / key)
  :
}

# --- steps ------------------------------------------------------------------------------------
build_context_tar() {
  # TODO(O2): mkdir -p "$BUILD_DIR"
  #   "$PY" deploy/lib/dockerignore.py --root "$REPO_ROOT" --print0 \
  #     | tar --null -T - -cf "$CONTEXT_TAR" -C "$REPO_ROOT"
  #   print the file count and the tar size (never the file list)
  #   sanity check: tar -tf "$CONTEXT_TAR" must contain docker/Dockerfile and must NOT
  #   contain deploy/.env -> otherwise die (defence in depth on top of .dockerignore)
  :
}

remote_build() {
  # TODO(O2): pcurl -N -X POST \
  #   -H 'Content-Type: application/x-tar' --data-binary "@$CONTEXT_TAR" \
  #   "$PORTAINER_URL/api/endpoints/$PORTAINER_ENDPOINT_ID/docker/build?t=$APP_IMAGE&dockerfile=docker/Dockerfile&rm=1&forcerm=1&pull=1" \
  #   | "$PY" deploy/lib/portainer.py build-stream
  #   (build-stream exits non-zero on error/errorDetail; keep pipefail so we die too)
  :
}

render_stack() {
  # TODO(O2): "$PY" deploy/lib/render_compose.py "$COMPOSE_SRC" \
  #   --keep "$SECRET_ENV_VARS" --out "$STACK_FILE"
  #   (${APP_HOSTNAME}, ${APP_IMAGE}, ... substituted; ${APP_PASSWORD} stays literal and is
  #    delivered through the Portainer stack Env array instead)
  :
}

find_stack_id() {
  # TODO(O2): pcurl "$PORTAINER_URL/api/stacks" \
  #   | "$PY" deploy/lib/portainer.py find-stack --name "$STACK_NAME" --endpoint "$PORTAINER_ENDPOINT_ID"
  #   echoes the id or nothing
  :
}

create_stack() {
  # TODO(O2): body="$("$PY" deploy/lib/portainer.py stack-body --file "$STACK_FILE" \
  #     --name "$STACK_NAME" --env APP_PASSWORD)"
  #   POST "$PORTAINER_URL/api/stacks/create/standalone/string?endpointId=$ID" (JSON body)
  #   on HTTP 404/405 fall back to the legacy
  #   POST "$PORTAINER_URL/api/stacks?type=2&method=string&endpointId=$ID"
  #   pass the body via --data-binary @- from stdin so it never lands in `ps`
  :
}

update_stack() {
  # TODO(O2): PUT "$PORTAINER_URL/api/stacks/$1?endpointId=$ID" with
  #   {"stackFileContent":…, "env":[…], "prune":true, "pullImage":false}
  :
}

wait_healthy() {
  # TODO(O2): poll $HEALTH_URL every 5s until the body contains '"status":"ok"' or
  #   HEALTH_TIMEOUT seconds elapse; print elapsed time; non-zero exit on timeout with the
  #   hint to check the container logs in Portainer
  :
}

main() {
  parse_args "$@"
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
    sid="$(find_stack_id)"
    if [ -n "$sid" ]; then update_stack "$sid"; else create_stack; fi
  fi
  if [ "$DO_WAIT" -eq 1 ] && [ "$DO_DEPLOY" -eq 1 ]; then wait_healthy; fi
  log "done"
}

main "$@"
