#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
PUBLIC_ORIGIN=${PUBLIC_ORIGIN:-}
PRODUCTION_ENV_FILE=${PRODUCTION_ENV_FILE:-}
MEDIA_HEADER_PROOF_DIR=${MEDIA_HEADER_PROOF_DIR:-}
OUTER_PROXY_ACCESS_LOG=${OUTER_PROXY_ACCESS_LOG:-}
MEDIA_OUTCOMES='200 206 401 403 404 416'

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

regular_proof() {
  path=$1
  message=$2
  [ -n "$path" ] || fail "$message"
  [ ! -L "$path" ] && [ -f "$path" ] || fail "$message must be a regular non-symbolic file"
  [ -s "$path" ] || fail "$message must not be empty"
}

case "$PUBLIC_ORIGIN" in
  https://*) ;;
  *) fail 'public origin must be a bare HTTPS origin' ;;
esac
origin_authority=${PUBLIC_ORIGIN#https://}
case "$origin_authority" in
  ''|*/*|*'?'*|*'#'*|*@*|*' '*) fail 'public origin must be a bare HTTPS origin' ;;
esac

regular_proof "$PRODUCTION_ENV_FILE" 'production environment proof'
env_mode=$(stat -c '%a' "$PRODUCTION_ENV_FILE" 2>/dev/null || stat -f '%Lp' "$PRODUCTION_ENV_FILE") || fail 'unable to inspect production environment proof'
case "$env_mode" in 400|600) ;; *) fail 'production environment proof permissions must be 400 or 600' ;; esac
secure_count=$(grep -Ec '^AUTH_COOKIE_SECURE=' "$PRODUCTION_ENV_FILE" || :)
[ "$secure_count" -eq 1 ] && grep -Fx 'AUTH_COOKIE_SECURE=true' "$PRODUCTION_ENV_FILE" >/dev/null || {
  fail 'production cookies must be explicitly Secure'
}
origin_count=$(grep -Ec '^FRONT_ORIGIN=' "$PRODUCTION_ENV_FILE" || :)
[ "$origin_count" -eq 1 ] || fail 'production public origin proof must be unique'
configured_origin=$(sed -n 's/^FRONT_ORIGIN=//p' "$PRODUCTION_ENV_FILE")
[ "$configured_origin" = "$PUBLIC_ORIGIN" ] || fail 'production public origin does not match the probed HTTPS origin'

[ -d "$MEDIA_HEADER_PROOF_DIR" ] && [ ! -L "$MEDIA_HEADER_PROOF_DIR" ] || {
  fail 'media outcome header proof directory is required'
}
for outcome in $MEDIA_OUTCOMES; do
  proof=$MEDIA_HEADER_PROOF_DIR/$outcome.headers
  regular_proof "$proof" 'media outcome header proof is required'
  first_line=$(sed -n '1p' "$proof" | tr -d '\r')
  case "$first_line" in "HTTP/"*" $outcome "*) ;; *) fail 'media outcome status proof failed' ;; esac
  cache_count=$(awk 'tolower($0) ~ /^cache-control:[[:space:]]*/ { count++ } END { print count + 0 }' "$proof")
  [ "$cache_count" -eq 1 ] || fail 'media outcome cache policy proof failed'
  cache_value=$(awk 'tolower($0) ~ /^cache-control:[[:space:]]*/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/[[:space:]\r]/, ""); print tolower($0) }' "$proof")
  [ "$cache_value" = 'private,no-store,no-transform' ] || fail 'media outcome cache policy proof failed'
done

[ -n "$OUTER_PROXY_ACCESS_LOG" ] || fail 'outer proxy access log proof is required'
regular_proof "$OUTER_PROXY_ACCESS_LOG" 'outer proxy access log proof'
for outcome in $MEDIA_OUTCOMES; do
  grep -Fx "route=event-media outcome=$outcome" "$OUTER_PROXY_ACCESS_LOG" >/dev/null || {
    fail 'outer proxy media outcome log proof is incomplete'
  }
done
if grep -Eiq '(/api/v1/alerts/|media/content|[.]mp4|/app/backend/clips|/var/lib/docker/volumes|media_clip_dir|authorization|bearer[[:space:]]|(^|[^a-z])cookie|set-cookie|edge_facility_token|access[_-]?token|refresh[_-]?token|token=|cache-control|(^|[^a-z])etag|content-range|if-range|(^|[^a-z])range[=:])' "$OUTER_PROXY_ACCESS_LOG"; then
  fail 'outer proxy access log redaction proof failed'
fi

need_loopback='"127.0.0.1:3000:3000"'
grep -F "$need_loopback" "$REPO_ROOT/compose.prod.yaml" >/dev/null || {
  fail 'frontend must remain loopback-only behind the outer proxy'
}
backend_compose=$(sed -n '/^  backend:/,/^  front:/p' "$REPO_ROOT/compose.prod.yaml")
printf '%s\n' "$backend_compose" | grep -F 'ports: !reset []' >/dev/null || {
  fail 'backend must remain private behind the outer proxy'
}

command -v curl >/dev/null 2>&1 || fail 'curl is required for external TLS proof'
tls_headers=$(curl --silent --show-error --head --proto '=https' --tlsv1.2 --max-time 15 "$PUBLIC_ORIGIN/" 2>/dev/null) || {
  fail 'external HTTPS probe failed'
}
tls_status=$(printf '%s\n' "$tls_headers" | tr -d '\r' | sed -n '1p')
case "$tls_status" in "HTTP/"*" 2"*|"HTTP/"*" 3"*) ;; *) fail 'external HTTPS probe returned an invalid status' ;; esac
hsts=$(printf '%s\n' "$tls_headers" | tr -d '\r' | awk 'tolower($0) ~ /^strict-transport-security:[[:space:]]*/ { sub(/^[^:]*:[[:space:]]*/, ""); print tolower($0) }' | sed -n '$p')
case "$hsts" in
  *max-age=31536000*includesubdomains*) ;;
  *) fail 'outer proxy HSTS proof failed' ;;
esac

printf '%s\n' 'event media release security verified'
