#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
HELPER=$REPO_ROOT/scripts/deploy/controlled-compose.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

[ -f "$HELPER" ] || {
  printf '%s\n' 'controlled Compose helper is required' >&2
  exit 1
}
# shellcheck source=scripts/deploy/controlled-compose.sh
. "$HELPER"

cat > "$TMP/host.env" <<'EOF'
FRONT_ORIGINS=https://seeon.seniorsailab.com,http://49.247.204.81
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
BACKEND_IMAGE=eldercare-backend:0123456789abcdef0123456789abcdef01234567
API_INGRESS_IMAGE=eldercare-api-ingress:0123456789abcdef0123456789abcdef01234567
MEDIA_RETENTION_DAYS=60
MEDIA_MIN_FREE_BYTES=1073741824
MEDIA_CLIP_MAX_BYTES=268435456
EOF
printf '%s\n' 'EVENT_CLIPS_ENABLED=false' > "$TMP/event-clips-runtime.env"
chmod 600 "$TMP/host.env" "$TMP/event-clips-runtime.env"

render_flag() {
  inherited=$1
  shift
  EVENT_CLIPS_ENABLED=$inherited controlled_compose \
    docker compose --env-file "$TMP/host.env" "$@" \
      --profile full -f "$REPO_ROOT/compose.yaml" -f "$REPO_ROOT/compose.prod.yaml" \
      config --format json |
    node -e 'let value=""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => process.stdout.write(String(JSON.parse(value).services.backend.environment.EVENT_CLIPS_ENABLED)));'
}

# Inherited state never outranks the ordered, verified dotenv inputs.
[ "$(render_flag true --env-file "$TMP/event-clips-runtime.env")" = false ] || {
  printf '%s\n' 'exact false emergency override lost to inherited true' >&2
  exit 1
}
[ "$(render_flag false)" = true ] || {
  printf '%s\n' 'inherited false disabled normal active render' >&2
  exit 1
}
[ "$(render_flag true)" = true ] || {
  printf '%s\n' 'inherited true altered normal active render' >&2
  exit 1
}

# The seam returns the command producer status unchanged in sourced and direct modes.
set +e
controlled_compose sh -c 'exit 37'
status=$?
sh "$HELPER" sh -c 'exit 38'
direct_status=$?
set -e
[ "$status" -eq 37 ] || {
  printf 'controlled Compose command failure returned %s, expected 37\n' "$status" >&2
  exit 1
}
[ "$direct_status" -eq 38 ] || {
  printf 'direct controlled Compose failure returned %s, expected 38\n' "$direct_status" >&2
  exit 1
}

grep -F '"compose:prod:up": "sh scripts/deploy/controlled-compose.sh docker compose' "$REPO_ROOT/package.json" >/dev/null || {
  printf '%s\n' 'production package Compose command bypasses the controlled seam' >&2
  exit 1
}

printf '%s\n' 'controlled Compose environment tests passed'
