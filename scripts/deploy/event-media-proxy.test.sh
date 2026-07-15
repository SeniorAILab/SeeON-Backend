#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
CONFIG=$REPO_ROOT/front/nginx.conf
PACKAGE=$REPO_ROOT/package.json
HOST_ENV_EXAMPLE=$REPO_ROOT/.env.host.prod.example

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "media proxy block is missing: $2" ;;
  esac
}

upload_block=$(sed -n '/# Event media raw upload/,/^  }/p' "$CONFIG")
[ -n "$upload_block" ] || fail 'dedicated event media upload proxy block is required'

# Given the edge-authenticated raw clip route, when a maximum-sized request is
# proxied, then nginx accepts the exact host contract and streams it upstream.
assert_contains "$upload_block" 'location ~ ^/api/v1/events/clips/[^/]+$ {'
assert_contains "$upload_block" 'proxy_pass http://backend:8080;'
assert_contains "$upload_block" 'proxy_http_version 1.1;'
assert_contains "$upload_block" 'proxy_request_buffering off;'
maximum_clip_bytes=$(sed -n 's/^MEDIA_CLIP_MAX_BYTES=//p' "$HOST_ENV_EXAMPLE")
[ -n "$maximum_clip_bytes" ] || fail 'host env maximum clip size is required'
upload_limit=$(printf '%s\n' "$upload_block" | sed -n 's/^[[:space:]]*client_max_body_size[[:space:]]\([0-9][0-9]*\);$/\1/p')
[ "$upload_limit" = "$maximum_clip_bytes" ] || {
  fail 'nginx upload limit must equal MEDIA_CLIP_MAX_BYTES'
}

# The larger body limit belongs only to the exact raw upload route. The state
# endpoint, playback route, and generic API proxy retain their existing limits.
[ "$(grep -c 'client_max_body_size' "$CONFIG")" -eq 1 ] || {
  fail 'maximum clip body size must be scoped to one nginx location'
}
case "$upload_block" in
  *Authorization*|*EDGE_FACILITY_TOKEN*|*X-Camera-Id*)
    fail 'upload proxy block must not synthesize machine credentials' ;;
  *) ;;
esac

block=$(sed -n '/# Event media byte streaming/,/^  }/p' "$CONFIG")
[ -n "$block" ] || fail 'dedicated event media proxy block is required'

# Given the authenticated media route, when nginx proxies a native video
# request, then byte-range validators pass through without response buffering.
assert_contains "$block" 'location ~ ^/api/v1/alerts/[^/]+/media/content$ {'
assert_contains "$block" 'proxy_pass http://backend:8080;'
assert_contains "$block" 'proxy_http_version 1.1;'
assert_contains "$block" 'proxy_set_header Range $http_range;'
assert_contains "$block" 'proxy_set_header If-Range $http_if_range;'
assert_contains "$block" 'proxy_buffering off;'
assert_contains "$block" 'proxy_request_buffering off;'
assert_contains "$block" 'proxy_cache off;'
assert_contains "$block" 'proxy_max_temp_file_size 0;'

# Given a cookie-authenticated browser request, when proxied, then no alternate
# bearer or edge credential is synthesized at the proxy boundary.
case "$block" in
  *Authorization*|*EDGE_FACILITY_TOKEN*|*X-Camera-Id*)
    fail 'media proxy block must not synthesize machine credentials' ;;
  *) ;;
esac

# Given the full nginx file, when statically inspected, then the media block is
# ordered before the generic API location and therefore owns matching requests.
media_line=$(grep -n '# Event media byte streaming' "$CONFIG" | cut -d: -f1)
upload_line=$(grep -n '# Event media raw upload' "$CONFIG" | cut -d: -f1)
api_line=$(grep -n 'location /api/' "$CONFIG" | cut -d: -f1)
case "$upload_line:$media_line:$api_line" in
  :*|*::*|*:) fail 'unable to locate proxy ordering anchors' ;;
esac
[ "$upload_line" -lt "$api_line" ] || fail 'event media upload block must precede generic API proxying'
[ "$media_line" -lt "$api_line" ] || fail 'event media proxy block must precede generic API proxying'

package_contract=$(sed -n '/"scripts"/,/^[[:space:]]*}/p' "$PACKAGE")
assert_contains "$package_contract" 'sh scripts/deploy/event-media-proxy.test.sh'
assert_contains "$package_contract" 'sh scripts/deploy/event-media-backup-inputs.test.sh'
assert_contains "$package_contract" '"deploy:event-media:restore-test"'
assert_contains "$package_contract" 'sh scripts/deploy/event-media-restore-harness.test.sh'

printf '%s\n' 'event media proxy contract tests passed'
