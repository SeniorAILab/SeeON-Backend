#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/iwinv-overlap-readiness.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/bin" "$TMP/root/shared/release-receipts" "$TMP/root/releases" "$TMP/media/event-media-fixture"

SHA=0123456789abcdef0123456789abcdef01234567
cat > "$TMP/host.env" <<'EOF'
NODE_ENV=production
FRONT_ORIGINS=https://seeon.seniorsailab.com,http://49.247.204.81
AUTH_COOKIE_SECURE=auto
ALERT_DASHBOARD_URL=https://seeon.seniorsailab.com
POSTGRES_USER=fall
POSTGRES_PASSWORD=test
POSTGRES_DB=fall_prod
APP_DB_USER=fall_app
APP_DB_PASSWORD=test
DATABASE_URL=postgresql://fall_app:test@db:5432/fall_prod
DIRECT_URL=postgresql://fall:test@db:5432/fall_prod
SESSION_JWT_SECRET=synthetic-session-secret-minimum-32-characters
EDGE_TOKEN_PEPPER=synthetic-edge-pepper
SMTP_HOST=mail
SMTP_USER=user
SMTP_PASSWORD=password
MEDIA_RETENTION_DAYS=60
MEDIA_MIN_FREE_BYTES=1073741824
MEDIA_CLIP_MAX_BYTES=268435456
EVENT_CLIPS_ENABLED=false
VITE_EVENT_CLIPS_ENABLED=false
EOF
chmod 600 "$TMP/host.env"
printf '%s\n' fixture-manifest > "$TMP/media/event-media-fixture/MANIFEST"
manifest_sha=$(shasum -a 256 "$TMP/media/event-media-fixture/MANIFEST" | awk '{print $1}')
now=$(date -u +%s)
printf 'FORMAT=seeon-event-media-backup-receipt-v1\nBUNDLE=%s\nMANIFEST_SHA256=%s\nCOMPLETED_EPOCH=%s\n' \
  "$TMP/media/event-media-fixture" "$manifest_sha" "$now" > "$TMP/root/shared/release-receipts/media-backup.receipt"
printf 'FORMAT=seeon-edge-continuity-seed-v1\nRELEASE_SHA=%s\nLAST_HEARTBEAT_EPOCH=100\nCAPTURED_EPOCH=%s\n' \
  "$SHA" "$now" > "$TMP/root/shared/release-receipts/edge-continuity.receipt"
chmod 600 "$TMP/root/shared/release-receipts"/*.receipt
printf '%s\n' sentinel > "$TMP/root/releases/current.json"

cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env sh
printf 'docker %s\n' "$*" >> "${DOCKER_LOG:?}"
if [ "${1:-}" = image ] && [ "${2:-}" = inspect ]; then
  image=${5:-}
  [ "${MISSING_IMAGE:-}" != "$image" ] || exit 1
  case "$image" in
    eldercare-backend:*) printf '%s\n' sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
    eldercare-api-ingress:*) printf '%s\n' sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc ;;
    eldercare-front:*) printf '%s\n' sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "${1:-}" = compose ]; then
  case " $* " in
    *' config '*) exit "${COMPOSE_CONFIG_EXIT:-0}" ;;
    *' exec -T db sh -c '*) printf '%s\n' "${EDGE_EPOCH:-100}"; exit 0 ;;
  esac
fi
exit 1
EOF
chmod +x "$TMP/bin/docker"

run_readiness() {
  PATH="$TMP/bin:$PATH" APP_ROOT="$TMP/root" APP_DIR="$REPO_ROOT" ENV_FILE="${TEST_ENV_FILE:-$TMP/host.env}" \
    RECEIPT_DIR="$TMP/root/shared/release-receipts" DOCKER_LOG="$TMP/docker.log" \
    MISSING_IMAGE="${TEST_MISSING_IMAGE:-}" INGRESS_CONFIG="${TEST_INGRESS_CONFIG:-$REPO_ROOT/infra/api-ingress/nginx.conf}" \
    sh "$SCRIPT" "$@" 2>&1
}
assert_failure() { [ "$1" -ne 0 ] || { printf '%s\n' 'readiness gate unexpectedly passed' >&2; exit 1; }; }
assert_contains() { case "$1" in *"$2"*) ;; *) printf 'missing expected output: %s\n%s\n' "$2" "$1" >&2; exit 1;; esac; }
assert_pointer_unchanged() { [ "$(cat "$TMP/root/releases/current.json")" = sentinel ] || { printf '%s\n' 'readiness gate changed release pointer' >&2; exit 1; }; }

: > "$TMP/docker.log"
output=$(run_readiness --pre-build "$SHA")
assert_contains "$output" 'overlap pre-build readiness verified'
assert_pointer_unchanged

: > "$TMP/docker.log"
output=$(EDGE_EPOCH=123 run_readiness --capture-edge "$SHA")
assert_contains "$output" 'Edge continuity seed captured'
grep -Fx 'LAST_HEARTBEAT_EPOCH=123' "$TMP/root/shared/release-receipts/edge-continuity.receipt" >/dev/null

: > "$TMP/docker.log"
output=$(run_readiness --pre-deploy "$SHA")
assert_contains "$output" 'overlap pre-deploy readiness verified'
assert_pointer_unchanged

# Missing env, ingress, media receipt, Edge receipt, or exact image fails closed
# without activating or rewriting any release pointer.
set +e
output=$(TEST_ENV_FILE="$TMP/missing.env" run_readiness --pre-build "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'production environment file is required'; assert_pointer_unchanged
set +e
output=$(TEST_INGRESS_CONFIG="$TMP/missing-nginx.conf" run_readiness --pre-build "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'standalone API ingress config is required'; assert_pointer_unchanged

mv "$TMP/root/shared/release-receipts/media-backup.receipt" "$TMP/media.receipt"
set +e
output=$(run_readiness --pre-deploy "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'media backup receipt is required'; assert_pointer_unchanged
mv "$TMP/media.receipt" "$TMP/root/shared/release-receipts/media-backup.receipt"

mv "$TMP/root/shared/release-receipts/edge-continuity.receipt" "$TMP/edge.receipt"
set +e
output=$(run_readiness --pre-deploy "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Edge continuity receipt is required'; assert_pointer_unchanged
mv "$TMP/edge.receipt" "$TMP/root/shared/release-receipts/edge-continuity.receipt"

set +e
output=$(TEST_MISSING_IMAGE="eldercare-api-ingress:$SHA" run_readiness --pre-deploy "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'exact API ingress image is unavailable'; assert_pointer_unchanged

printf '%s\n' 'iwinv overlap readiness tests passed'
