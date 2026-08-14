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
FRONT_ORIGINS=https://seeon.seniorsailab.com,http://127.0.0.1
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

cat > "$TMP/render-child.sh" <<'EOF'
#!/usr/bin/env sh
set -eu
# shellcheck source=scripts/deploy/controlled-compose.sh
. "$HELPER"
controlled_compose docker compose --env-file "$HOST_ENV" "$@" \
  --profile full -f "$REPO_ROOT/compose.yaml" -f "$REPO_ROOT/compose.prod.yaml" \
  config --format json |
  node -e 'let value=""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => process.stdout.write(String(JSON.parse(value).services.backend.environment.EVENT_CLIPS_ENABLED)));'
EOF
chmod 700 "$TMP/render-child.sh"

render_flag() {
  inherited=$1
  shift
  env EVENT_CLIPS_ENABLED="$inherited" HELPER="$HELPER" HOST_ENV="$TMP/host.env" \
    REPO_ROOT="$REPO_ROOT" sh "$TMP/render-child.sh" "$@"
}

# A real exported child environment never outranks ordered, verified dotenv
# inputs, regardless of the test process's own ambient value.
for test_ambient in true false; do
  EVENT_CLIPS_ENABLED=$test_ambient
  export EVENT_CLIPS_ENABLED
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
done
unset EVENT_CLIPS_ENABLED

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

cat > "$TMP/output-then-fail.sh" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' db
exit 42
EOF
chmod 700 "$TMP/output-then-fail.sh"
set +e
controlled_command_has_exact_line db "$TMP/output-then-fail.sh"
producer_status=$?
set -e
[ "$producer_status" -eq 42 ] || {
  printf 'captured command failure returned %s, expected 42\n' "$producer_status" >&2
  exit 1
}
set +e
controlled_command_has_exact_line db sh -c 'printf "%s\n" backend'
malformed_status=$?
set -e
[ "$malformed_status" -eq 1 ] || {
  printf 'malformed controlled output returned %s, expected 1\n' "$malformed_status" >&2
  exit 1
}

grep -F 'controlled_command_has_exact_line db compose config --services' "$REPO_ROOT/scripts/deploy/event-media-backup.sh" >/dev/null || {
  printf '%s\n' 'event-media backup bypasses explicit Compose service capture' >&2
  exit 1
}

printf '%s\n' 'controlled Compose environment tests passed'
