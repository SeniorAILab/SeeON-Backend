#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
CONFIG=$REPO_ROOT/infra/api-ingress/nginx.conf
DOCKERFILE=$REPO_ROOT/infra/api-ingress/Dockerfile

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "standalone API ingress contract is missing: $2" ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "standalone API ingress must not contain frontend behavior: $2" ;;
    *) ;;
  esac
}

location_block() {
  marker=$1
  awk -v marker="$marker" '
    index($0, marker) { printing = 1 }
    printing { print }
    printing && /^  }$/ { exit }
  ' "$CONFIG"
}

[ -f "$CONFIG" ] || fail 'standalone API ingress nginx.conf is required'
[ -f "$DOCKERFILE" ] || fail 'standalone API ingress Dockerfile is required'
config=$(cat "$CONFIG")
dockerfile=$(cat "$DOCKERFILE")

# The image owns API ingress only; it must never become another SPA/static server.
assert_contains "$dockerfile" 'FROM nginx:1.27-alpine'
assert_contains "$dockerfile" 'COPY infra/api-ingress/nginx.conf /etc/nginx/conf.d/default.conf'
assert_contains "$config" 'listen 3000;'
assert_contains "$config" 'resolver 127.0.0.11 valid=30s;'
assert_contains "$config" 'set $backend_upstream http://backend:8080;'
assert_not_contains "$config" 'try_files'
assert_not_contains "$config" '/usr/share/nginx/html'
assert_not_contains "$config" 'location /assets/'
assert_not_contains "$config" 'index.html'

assert_forwarding_contract() {
  block=$1
  label=$2
  [ -n "$block" ] || fail "$label location is required"
  assert_contains "$block" 'proxy_pass $backend_upstream;'
  assert_contains "$block" 'proxy_http_version 1.1;'
  assert_contains "$block" 'proxy_set_header Host $host;'
  assert_contains "$block" 'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
  assert_contains "$block" 'proxy_set_header X-Forwarded-Proto $scheme;'
  assert_contains "$block" 'proxy_set_header Authorization $http_authorization;'
  assert_contains "$block" 'proxy_set_header X-Edge-Relay-Token $http_x_edge_relay_token;'
}

health_block=$(location_block 'location = /health')
assert_forwarding_contract "$health_block" health

generic_block=$(location_block 'location /api/')
assert_forwarding_contract "$generic_block" generic-api

sse_block=$(location_block 'location = /api/v1/dashboard/stream')
assert_forwarding_contract "$sse_block" sse
assert_contains "$sse_block" "proxy_set_header Connection '';"
assert_contains "$sse_block" 'proxy_buffering off;'
assert_contains "$sse_block" 'proxy_cache off;'
assert_contains "$sse_block" 'proxy_read_timeout 1h;'
assert_contains "$sse_block" 'add_header X-Accel-Buffering "no" always;'
assert_contains "$sse_block" 'add_header Cache-Control "no-cache" always;'

upload_block=$(location_block 'location ~ ^/api/v1/events/clips/')
assert_forwarding_contract "$upload_block" media-upload
assert_contains "$upload_block" 'client_max_body_size 268435456;'
assert_contains "$upload_block" 'proxy_request_buffering off;'
[ "$(grep -c 'client_max_body_size' "$CONFIG")" -eq 1 ] || fail '256 MiB body limit must be scoped to only the clip upload route'

media_block=$(location_block 'location ~ ^/api/v1/alerts/')
assert_forwarding_contract "$media_block" media-content
assert_contains "$media_block" 'proxy_set_header Range $http_range;'
assert_contains "$media_block" 'proxy_set_header If-Range $http_if_range;'
assert_contains "$media_block" 'proxy_buffering off;'
assert_contains "$media_block" 'proxy_request_buffering off;'
assert_contains "$media_block" 'proxy_cache off;'
assert_contains "$media_block" 'proxy_max_temp_file_size 0;'

sse_line=$(grep -n 'location = /api/v1/dashboard/stream' "$CONFIG" | cut -d: -f1)
upload_line=$(grep -n 'location ~ ^/api/v1/events/clips/' "$CONFIG" | cut -d: -f1)
media_line=$(grep -n 'location ~ ^/api/v1/alerts/' "$CONFIG" | cut -d: -f1)
generic_line=$(grep -n 'location /api/' "$CONFIG" | cut -d: -f1)
[ "$sse_line" -lt "$generic_line" ] || fail 'SSE route must precede generic API proxying'
[ "$upload_line" -lt "$generic_line" ] || fail 'upload route must precede generic API proxying'
[ "$media_line" -lt "$generic_line" ] || fail 'media route must precede generic API proxying'

printf '%s\n' 'standalone API ingress config contract tests passed'
