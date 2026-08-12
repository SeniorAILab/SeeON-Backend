#!/usr/bin/env sh
# shellcheck disable=SC2016 # Quoted SQL expands database env inside the container.
set -eu
set +x

APP_ROOT=${APP_ROOT:-/opt/eldercare-fall-ai}
APP_DIR=${APP_DIR:-$APP_ROOT/repo}
ENV_FILE=${ENV_FILE:-$APP_ROOT/shared/.env}
RECEIPT_DIR=${RECEIPT_DIR:-$APP_ROOT/shared/release-receipts}
MEDIA_RECEIPT=${MEDIA_RECEIPT:-$RECEIPT_DIR/media-backup.receipt}
EDGE_RECEIPT=${EDGE_RECEIPT:-$RECEIPT_DIR/edge-continuity.receipt}
INGRESS_CONFIG=${INGRESS_CONFIG:-$APP_DIR/infra/api-ingress/nginx.conf}
RECEIPT_MAX_AGE_SECONDS=${RECEIPT_MAX_AGE_SECONDS:-3600}

fail() { printf '%s\n' "$1" >&2; exit 1; }
valid_sha() { [ "${#1}" -eq 40 ] && printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }
owner_only_file() {
  path=$1
  label=$2
  [ ! -L "$path" ] && [ -f "$path" ] || fail "$label is required"
  mode=$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path") || fail "unable to inspect $label permissions"
  case "$mode" in 400|600) ;; *) fail "$label permissions must be 400 or 600" ;; esac
}
env_value() {
  key=$1
  value=$(awk -v key="$key" '
    index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 2; print value }
  ' "$ENV_FILE") || fail "$key must appear exactly once in the production environment"
  printf '%s\n' "$value"
}
receipt_value() {
  key=$1
  file=$2
  value=$(awk -F= -v key="$key" '
    $1 == key { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 2; print value }
  ' "$file") || fail "receipt field is missing or duplicated: $key"
  printf '%s\n' "$value"
}
require_fresh_epoch() {
  value=$1
  label=$2
  case "$value" in ''|*[!0-9]*) fail "$label timestamp is invalid" ;; esac
  now=$(date -u +%s)
  age=$((now - value))
  [ "$age" -ge 0 ] && [ "$age" -le "$RECEIPT_MAX_AGE_SECONDS" ] || fail "$label is stale"
}
sha256_file() { sha256sum "$1" | awk '{print $1}'; }
compose() {
  BACKEND_IMAGE="eldercare-backend:$SHA" \
  API_INGRESS_IMAGE="eldercare-api-ingress:$SHA" \
  FRONT_IMAGE="eldercare-front:$SHA" \
    docker compose --env-file "$ENV_FILE" -f compose.yaml -f compose.prod.yaml "$@"
}
validate_tooling() {
  # The release-manifest grammar is dependency-free, but its complete POSIX
  # command contract and jq for GitHub JSON validation are mandatory host tools.
  for tool in awk cat cmp curl date docker grep jq mktemp rm sed sha256sum stat tail tr wc; do
    command -v "$tool" >/dev/null 2>&1 || fail "required release validation tool is missing: $tool"
  done
}
validate_pre_build() {
  validate_tooling
  owner_only_file "$ENV_FILE" 'production environment file'
  [ -d "$APP_DIR" ] || fail 'application directory is required'
  [ -f "$APP_DIR/compose.yaml" ] && [ -f "$APP_DIR/compose.prod.yaml" ] || fail 'both Compose files are required'
  [ -f "$INGRESS_CONFIG" ] && [ ! -L "$INGRESS_CONFIG" ] || fail 'standalone API ingress config is required'
  [ -f "$APP_DIR/infra/api-ingress/Dockerfile" ] || fail 'standalone API ingress Dockerfile is required'
  [ "$(env_value FRONT_ORIGINS)" = 'https://seeon.seniorsailab.com,http://49.247.204.81' ] || fail 'production FRONT_ORIGINS must equal the overlap allowlist'
  [ "$(env_value AUTH_COOKIE_SECURE)" = auto ] || fail 'production AUTH_COOKIE_SECURE must be auto during overlap'
  sh "$APP_DIR/scripts/deploy/validate-event-clip-env.sh" "$ENV_FILE"
  sh "$APP_DIR/infra/api-ingress/nginx-config.test.sh"
  (
    cd "$APP_DIR"
    compose --profile full config >/dev/null
  ) || fail 'production Compose configuration is invalid'
}
validate_media_receipt() {
  owner_only_file "$MEDIA_RECEIPT" 'media backup receipt'
  [ "$(wc -l < "$MEDIA_RECEIPT" | awk '{print $1}')" -eq 4 ] || fail 'media backup receipt is malformed'
  [ "$(receipt_value FORMAT "$MEDIA_RECEIPT")" = seeon-event-media-backup-receipt-v1 ] || fail 'media backup receipt format is invalid'
  bundle=$(receipt_value BUNDLE "$MEDIA_RECEIPT")
  case "$bundle" in /*) ;; *) fail 'media backup receipt bundle path is invalid' ;; esac
  [ -d "$bundle" ] && [ ! -L "$bundle" ] || fail 'media backup receipt bundle is unavailable'
  expected=$(receipt_value MANIFEST_SHA256 "$MEDIA_RECEIPT")
  case "$expected" in *[!0-9a-f]*|'') fail 'media backup receipt checksum is invalid' ;; esac
  [ "${#expected}" -eq 64 ] || fail 'media backup receipt checksum is invalid'
  [ -f "$bundle/MANIFEST" ] && [ "$(sha256_file "$bundle/MANIFEST")" = "$expected" ] || fail 'media backup receipt checksum does not match its bundle'
  require_fresh_epoch "$(receipt_value COMPLETED_EPOCH "$MEDIA_RECEIPT")" 'media backup receipt'
}
validate_edge_receipt() {
  owner_only_file "$EDGE_RECEIPT" 'Edge continuity receipt'
  [ "$(wc -l < "$EDGE_RECEIPT" | awk '{print $1}')" -eq 4 ] || fail 'Edge continuity receipt is malformed'
  [ "$(receipt_value FORMAT "$EDGE_RECEIPT")" = seeon-edge-continuity-seed-v1 ] || fail 'Edge continuity receipt format is invalid'
  [ "$(receipt_value RELEASE_SHA "$EDGE_RECEIPT")" = "$SHA" ] || fail 'Edge continuity receipt SHA does not match the release'
  heartbeat=$(receipt_value LAST_HEARTBEAT_EPOCH "$EDGE_RECEIPT")
  case "$heartbeat" in ''|*[!0-9]*) fail 'Edge continuity receipt heartbeat is invalid' ;; esac
  [ "$heartbeat" -gt 0 ] || fail 'Edge continuity receipt heartbeat is invalid'
  require_fresh_epoch "$(receipt_value CAPTURED_EPOCH "$EDGE_RECEIPT")" 'Edge continuity receipt'
}
verify_image() {
  image=$1
  label=$2
  image_id=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null) || fail "exact $label image is unavailable: $image"
  printf '%s\n' "$image_id" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "exact $label image ID is invalid: $image"
}
capture_edge() {
  mkdir -p "$RECEIPT_DIR"
  chmod 700 "$RECEIPT_DIR"
  heartbeat=$(
    cd "$APP_DIR"
    compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -Atc "SELECT COALESCE(FLOOR(EXTRACT(EPOCH FROM MAX(observed_at)))::bigint, 0) FROM (SELECT last_heartbeat_at AS observed_at FROM edge_installations UNION ALL SELECT last_seen_at FROM cameras) edge_observations;"'
  ) || fail 'unable to capture Edge continuity seed'
  case "$heartbeat" in ''|*[!0-9]*) fail 'Edge continuity seed is invalid' ;; esac
  [ "$heartbeat" -gt 0 ] || fail 'Edge continuity seed has no observed heartbeat'
  temp=$EDGE_RECEIPT.$$.tmp
  umask 077
  printf 'FORMAT=seeon-edge-continuity-seed-v1\nRELEASE_SHA=%s\nLAST_HEARTBEAT_EPOCH=%s\nCAPTURED_EPOCH=%s\n' "$SHA" "$heartbeat" "$(date -u +%s)" > "$temp"
  mv "$temp" "$EDGE_RECEIPT"
  printf 'Edge continuity seed captured. sha=%s\n' "$SHA"
}

[ "$#" -eq 2 ] || fail 'Usage: iwinv-overlap-readiness.sh --pre-build|--capture-edge|--pre-deploy <release-sha>'
MODE=$1
SHA=$2
valid_sha "$SHA" || fail 'release SHA must be exactly 40 lowercase hexadecimal characters'

case "$MODE" in
  --pre-build)
    validate_pre_build
    printf 'overlap pre-build readiness verified. sha=%s\n' "$SHA"
    ;;
  --capture-edge)
    validate_pre_build
    capture_edge
    ;;
  --pre-deploy)
    validate_pre_build
    validate_media_receipt
    validate_edge_receipt
    verify_image "eldercare-backend:$SHA" backend
    verify_image "eldercare-api-ingress:$SHA" 'API ingress'
    verify_image "eldercare-front:$SHA" frontend
    printf 'overlap pre-deploy readiness verified. sha=%s\n' "$SHA"
    ;;
  *) fail 'Usage: iwinv-overlap-readiness.sh --pre-build|--capture-edge|--pre-deploy <release-sha>' ;;
esac
