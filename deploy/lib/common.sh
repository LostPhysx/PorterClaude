#!/usr/bin/env bash
# PorterClaude — shared Portainer/curl plumbing. OWNER: O2.
# Sourced by deploy/deploy.sh and deploy/host-prep.sh; never executed on its own.
#
# SECURITY RULES (non-negotiable — they are the reason this lives in ONE file instead of
# being copy-pasted into every script):
#   * never `set -x`
#   * never echo $PORTAINER_API_KEY and never pass it as a curl argument (it would show up
#     in `ps`): it goes into a chmod-600 curl config file inside a `mktemp -d` directory
#     that the EXIT trap removes
#   * never write the key into deploy/.build/* or into any committed file
#
# Everything here is prefixed `pc_` except the four one-word helpers (log/warn/die/have)
# that both scripts use everywhere.

if [ -n "${PC_COMMON_SH_LOADED:-}" ]; then return 0; fi
PC_COMMON_SH_LOADED=1

TMPDIR_SECURE=""   # mktemp -d; holds the curl config, request and response bodies
RESPONSE_FILE=""   # pc_api_json writes response bodies here (inside TMPDIR_SECURE)

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

pc_cleanup() {
  if [ -n "${TMPDIR_SECURE:-}" ] && [ -d "${TMPDIR_SECURE:-}" ]; then
    rm -rf "$TMPDIR_SECURE"
  fi
}
trap pc_cleanup EXIT

# Secure scratch dir: everything that touches a secret (env copy, curl config, request and
# response bodies) lives here and nowhere else. Removed by the EXIT trap.
pc_ensure_tmpdir() {
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

# pc_load_env_file <path> — export every assignment in the file. CR is stripped first so a
# CRLF .env edited on Windows cannot smuggle \r into a value (and from there into a URL).
pc_load_env_file() {
  local file="$1" safe_env
  [ -f "$file" ] || die "env file not found: $file (copy deploy/.env.example to deploy/.env)"
  pc_ensure_tmpdir
  safe_env="$TMPDIR_SECURE/env.sh"
  tr -d '\r' < "$file" > "$safe_env"
  chmod 600 "$safe_env"
  set -a
  # shellcheck disable=SC1090
  . "$safe_env"
  set +a
  rm -f "$safe_env"
}

# pc_require_env <file> <VAR>... — die naming every variable that is missing or empty.
pc_require_env() {
  local file="$1" missing="" var
  shift
  for var in "$@"; do
    if [ -z "${!var:-}" ]; then missing="$missing $var"; fi
  done
  [ -z "$missing" ] || die "missing in $file:$missing"
}

# The API key becomes a curl config file and never anything else.
pc_setup_curl_config() {
  pc_ensure_tmpdir
  local cfg="$TMPDIR_SECURE/curl.cfg"
  ( umask 077; printf 'header = "X-API-Key: %s"\n' "$PORTAINER_API_KEY" > "$cfg" )
  chmod 600 "$cfg"
}

# curl with the API key config attached. Usage: pcurl <curl args...>
pcurl() {
  curl -sS --config "$TMPDIR_SECURE/curl.cfg" "$@"
}

# pc_api_json <METHOD> <URL> [<body-file>] -> prints the HTTP status; body lands in $RESPONSE_FILE
pc_api_json() {
  local method="$1" url="$2" body="${3:-}"
  if [ -n "$body" ]; then
    pcurl -o "$RESPONSE_FILE" -w '%{http_code}' -X "$method" \
      -H 'Content-Type: application/json' --data-binary "@$body" "$url"
  else
    pcurl -o "$RESPONSE_FILE" -w '%{http_code}' -X "$method" "$url"
  fi
}

pc_response_excerpt() {
  [ -f "$RESPONSE_FILE" ] || return 0
  head -c 400 "$RESPONSE_FILE" | tr -d '\r\n'
}

# Last `HTTP/x nnn` status line of a `curl --dump-header` file (skips 100-continue and
# redirect hops). Prints nothing when curl never got a response.
pc_http_status_from_headers() {
  [ -s "$1" ] || return 0
  tr -d '\r' < "$1" | awk '/^[Hh][Tt][Tt][Pp]\// { code = $2 } END { if (code != "") print code }'
}

# 1 when the response was an HTML page (a reverse-proxy error page, never Docker's JSON).
pc_response_is_html() {
  [ -s "$1" ] || return 1
  tr -d '\r' < "$1" | grep -qi '^content-type:[[:space:]]*text/html'
}

# Base URL of the Docker proxy of the configured endpoint.
pc_docker_api() {
  printf '%s/api/endpoints/%s/docker' "$PORTAINER_URL" "$PORTAINER_ENDPOINT_ID"
}

# The hostname part of a URL ("https://portainer.example.com:9443/x" -> portainer.example.com).
pc_url_host() {
  local rest="${1#*://}"
  rest="${rest%%/*}"
  rest="${rest%%\?*}"
  printf '%s' "${rest%%:*}"
}

# The remedy for the failure mode that blocks every long build on the reference host.
# Printed instead of a bare "HTTP 504", which tells an operator nothing.
pc_proxy_timeout_hint() {
  local host="${1:-<portainer-host>}"
  cat >&2 <<HINT

  ------------------------------------------------------------------------------------
  This is the reverse proxy in front of Portainer, not Portainer and not Docker.
  nginx cuts a request after proxy_read_timeout (60 s by default) and buffers the whole
  response, so any build longer than a minute dies with an HTML 504 and docker aborts it.

  Fix it once, on the proxy host, in vhost.d/$host :

      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;
      proxy_buffering off;          # stream the build output as it is produced
      proxy_request_buffering off;  # stream the (large) build-context upload
      client_max_body_size 0;       # a build context can be tens of MB

  then reload nginx-proxy (docker kill -s HUP <nginx-proxy>).
  deploy/host-prep.sh --vhost --reload does both through the Portainer API;
  docs/DEPLOYMENT.md "Reverse-proxy requirements for the Portainer vhost" has the details.

  Until then, use a pre-built image instead of a remote build:
      deploy/deploy.sh --image ghcr.io/<owner>/porterclaude:<tag>
  ------------------------------------------------------------------------------------

HINT
}

# pc_start_container <docker-api-base> <container-id> -> prints the HTTP status
#
# Portainer's docker proxy re-encodes a bodyless POST /containers/<id>/start so the engine
# sees a chunked request body and answers 400 "starting container with non-empty request
# body was deprecated ... removed in v1.24" (verified on the reference host: EE 2.39.5 /
# Docker 29.1.3, with no body, Content-Length: 0 and an empty body alike). /restart has no
# such check and starts a `created` container, so it is the fallback — the same one
# server/src/backends/portainer.ts uses.
pc_start_container() {
  local base="$1" cid="$2" code
  code="$(pc_api_json POST "$base/containers/$cid/start" || true)"
  case "$code" in
    400)
      if grep -qi 'non-empty request body' "$RESPONSE_FILE" 2>/dev/null; then
        code="$(pc_api_json POST "$base/containers/$cid/restart" || true)"
      fi
      ;;
  esac
  printf '%s' "$code"
}

# Preflight: the endpoint must answer /docker/_ping with 200.
pc_preflight() {
  have curl || die "curl not found"
  local code
  code="$(pc_api_json GET "$(pc_docker_api)/_ping" || true)"
  case "$code" in
    200) log "portainer reachable (docker _ping ok)" ;;
    401|403) die "portainer rejected the API key (HTTP $code) — check PORTAINER_API_KEY" ;;
    404) die "endpoint $PORTAINER_ENDPOINT_ID not found (HTTP 404) — check PORTAINER_ENDPOINT_ID" ;;
    000|"") die "cannot reach $PORTAINER_URL — check PORTAINER_URL / network / TLS" ;;
    *) die "unexpected reply from $PORTAINER_URL (HTTP $code): $(pc_response_excerpt)" ;;
  esac
}
