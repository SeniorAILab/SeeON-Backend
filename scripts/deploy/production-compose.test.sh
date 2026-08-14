#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/production-compose.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
APP_DIR=$TMP/repo
APP_ROOT=$TMP/root
HOST_ENV=$APP_DIR/.env.host.prod
RUNTIME_ENV=$APP_ROOT/shared/event-clips-runtime.env
mkdir -p "$APP_DIR/scripts/deploy" "$APP_ROOT/shared" "$TMP/bin"
cp "$REPO_ROOT/compose.yaml" "$APP_DIR/compose.yaml"
cp "$REPO_ROOT/compose.prod.yaml" "$APP_DIR/compose.prod.yaml"

write_host_env() {
  cat > "$HOST_ENV" <<'EOF'
MEDIA_RETENTION_DAYS=60
MEDIA_MIN_FREE_BYTES=1073741824
MEDIA_CLIP_MAX_BYTES=268435456
EOF
  chmod 600 "$HOST_ENV"
}
write_host_env

cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env sh
[ "${EVENT_CLIPS_ENABLED+x}" != x ] || exit 91
printf '%s\n' "$*" >> "${DOCKER_LOG:?}"
exit "${MOCK_COMPOSE_STATUS:-0}"
EOF
chmod 700 "$TMP/bin/docker"

run_production_compose() {
  env EVENT_CLIPS_ENABLED="${TEST_AMBIENT:-true}" \
    PATH="$TMP/bin:$PATH" APP_DIR="$APP_DIR" APP_ROOT="$APP_ROOT" \
    DOCKER_LOG="$TMP/docker.log" MOCK_COMPOSE_STATUS="${TEST_COMPOSE_STATUS:-0}" \
    sh "$SCRIPT" "$@" 2>&1
}

assert_failure() {
  [ "$1" -ne 0 ] || { printf '%s\n' 'production Compose unexpectedly passed' >&2; exit 1; }
}
assert_contains() {
  case "$1" in *"$2"*) ;; *) printf 'missing expected output: %s\n%s\n' "$2" "$1" >&2; exit 1;; esac
}

[ -f "$SCRIPT" ] || { printf '%s\n' 'owned production Compose script is required' >&2; exit 1; }

# Normal operation validates the host file, passes only that file, and clears a
# truly exported ambient feature value before launching Docker Compose.
: > "$TMP/docker.log"
run_production_compose config
normal_log=$(cat "$TMP/docker.log")
assert_contains "$normal_log" "compose --env-file $HOST_ENV --profile full -f $APP_DIR/compose.yaml -f $APP_DIR/compose.prod.yaml config"
case "$normal_log" in *event-clips-runtime.env*) printf '%s\n' 'absent emergency override was passed to Compose' >&2; exit 1;; esac

# The one authorized emergency file is discovered at the fixed shared path,
# validated as exact owner-only false, and ordered after the normal host file.
printf '%s\n' 'EVENT_CLIPS_ENABLED=false' > "$RUNTIME_ENV"
chmod 600 "$RUNTIME_ENV"
: > "$TMP/docker.log"
TEST_AMBIENT=false run_production_compose config
emergency_log=$(cat "$TMP/docker.log")
assert_contains "$emergency_log" "--env-file $HOST_ENV --env-file $RUNTIME_ENV --profile full"

# Any normal-host declaration is rejected before Docker, including bare lookup.
rm -f "$RUNTIME_ENV"
printf '%s\n' 'EVENT_CLIPS_ENABLED' >> "$HOST_ENV"
: > "$TMP/docker.log"
set +e
output=$(run_production_compose config); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'EVENT_CLIPS_ENABLED must not appear in the production environment'
[ ! -s "$TMP/docker.log" ]
write_host_env

# The emergency file cannot be a different value, weakly permissioned, or a symlink.
for fixture in wrong-value weak-mode symlink; do
  rm -f "$RUNTIME_ENV" "$APP_ROOT/shared/runtime.real"
  case "$fixture" in
    wrong-value) printf '%s\n' 'EVENT_CLIPS_ENABLED=true' > "$RUNTIME_ENV"; chmod 600 "$RUNTIME_ENV" ;;
    weak-mode) printf '%s\n' 'EVENT_CLIPS_ENABLED=false' > "$RUNTIME_ENV"; chmod 644 "$RUNTIME_ENV" ;;
    symlink) printf '%s\n' 'EVENT_CLIPS_ENABLED=false' > "$APP_ROOT/shared/runtime.real"; chmod 600 "$APP_ROOT/shared/runtime.real"; ln -s "$APP_ROOT/shared/runtime.real" "$RUNTIME_ENV" ;;
  esac
  : > "$TMP/docker.log"
  set +e
  output=$(run_production_compose config); status=$?
  set -e
  assert_failure "$status"
  assert_contains "$output" 'invalid event clip emergency override'
  [ ! -s "$TMP/docker.log" ]
done
rm -f "$RUNTIME_ENV" "$APP_ROOT/shared/runtime.real"

# The owned wrapper returns the exact Docker Compose producer status.
: > "$TMP/docker.log"
set +e
TEST_COMPOSE_STATUS=47 run_production_compose config >/dev/null
status=$?
set -e
[ "$status" -eq 47 ] || { printf 'production Compose returned %s, expected 47\n' "$status" >&2; exit 1; }

grep -F '"compose:prod:up": "sh scripts/deploy/production-compose.sh up -d"' "$REPO_ROOT/package.json" >/dev/null || {
  printf '%s\n' 'package production Compose command bypasses the owned policy script' >&2
  exit 1
}

printf '%s\n' 'owned production Compose policy tests passed'
