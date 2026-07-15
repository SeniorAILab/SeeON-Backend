#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/event-clips-disable.sh
DEPLOY=$REPO_ROOT/scripts/deploy/iwinv-deploy.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/bin" "$TMP/app/shared" "$TMP/app/releases"

SHA=0123456789abcdef0123456789abcdef01234567
BACKEND_IMAGE=eldercare-backend:$SHA
FRONT_IMAGE=eldercare-front:$SHA
cat > "$TMP/app/shared/.env" <<'EOF'
EVENT_CLIPS_ENABLED=true
AUTH_COOKIE_SECURE=true
EOF
cat > "$TMP/app/shared/release-images.env" <<EOF
BACKEND_IMAGE=$BACKEND_IMAGE
FRONT_IMAGE=$FRONT_IMAGE
EOF
cat > "$TMP/app/releases/current.json" <<EOF
{"sha":"$SHA","backend_image":"$BACKEND_IMAGE","backend_image_id":"sha256:backend-$SHA","front_image":"$FRONT_IMAGE","front_image_id":"sha256:front-$SHA","compose_sha256":"compose","env_sha256":"env","pre_migration_dump":"normal-test.dump","timestamp":"2026-07-16T00:00:00Z"}
EOF
chmod 600 "$TMP/app/shared/.env" "$TMP/app/shared/release-images.env" "$TMP/app/releases/current.json"
printf '%s\n' running > "$TMP/backend.state"

cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env sh
log=${MOCK_LOG:?}
printf '%s\n' "docker $*" >> "$log"
if [ "${1:-}" = compose ]; then
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env-file|-f) shift 2 ;;
      *) break ;;
    esac
  done
  case " $* " in
    *' ps -q --status running backend '*)
      [ "$(cat "$MOCK_BACKEND_STATE")" = running ] && printf '%s\n' backend-container
      ;;
    *' ps -q db '*) printf '%s\n' db-container ;;
    *' ps -q backend '*) printf '%s\n' backend-container ;;
    *' ps -q front '*) printf '%s\n' front-container ;;
    *' stop backend '*) printf '%s\n' stopped > "$MOCK_BACKEND_STATE" ;;
    *' up -d --no-deps --wait --wait-timeout 120 backend '*) printf '%s\n' running > "$MOCK_BACKEND_STATE" ;;
    *' config '*) printf '%s\n' 'EVENT_CLIPS_ENABLED: "false"' ;;
    *) printf 'unexpected compose command: %s\n' "$*" >&2; exit 1 ;;
  esac
  exit 0
fi
if [ "${1:-}" = inspect ]; then
  format=${3:-}
  container=${4:-}
  case "$format:$container" in
    *Config.Image*':backend-container') printf '%s\n' "eldercare-backend:$MOCK_SHA" ;;
    *Config.Image*':front-container') printf '%s\n' "eldercare-front:$MOCK_SHA" ;;
    *'{{.Image}}:backend-container') printf '%s\n' "${MOCK_BACKEND_IMAGE_ID:-sha256:backend-$MOCK_SHA}" ;;
    *'{{.Image}}:front-container') printf '%s\n' "sha256:front-$MOCK_SHA" ;;
    *var/lib/postgresql/data*':db-container') printf '%s\n' pgdata-fixture ;;
    *app/backend/clips*':backend-container')
      if [ "${MOCK_CLIP_DRIFT:-0}" = 1 ] && [ "$(cat "$MOCK_BACKEND_STATE")" = running ] && grep -F 'stop backend' "$log" >/dev/null; then
        printf '%s\n' clips-replaced
      else
        printf '%s\n' clips-fixture
      fi
      ;;
    *) printf 'unexpected inspect: %s %s\n' "$format" "$container" >&2; exit 1 ;;
  esac
  exit 0
fi
exit 1
EOF
chmod +x "$TMP/bin/docker"

run_disable() {
  PATH="$TMP/bin:$PATH" \
  APP_ROOT="$TMP/app" \
  APP_DIR="$REPO_ROOT" \
  ENV_FILE="$TMP/app/shared/.env" \
  RELEASE_ENV="$TMP/app/shared/release-images.env" \
  FEATURE_ENV="$TMP/app/shared/event-clips-runtime.env" \
  RELEASE_DIR="$TMP/app/releases" \
  MOCK_LOG="$TMP/docker.log" \
  MOCK_BACKEND_STATE="$TMP/backend.state" \
  MOCK_SHA="$SHA" \
    sh "$SCRIPT" 2>&1
}

assert_failure() { [ "$1" -ne 0 ] || { printf '%s\n' 'feature disable unexpectedly passed' >&2; exit 1; }; }
assert_contains() { case "$1" in *"$2"*) ;; *) printf 'missing expected output: %s\n' "$2" >&2; exit 1;; esac; }
assert_not_contains() { case "$1" in *"$2"*) printf 'unexpected output: %s\n' "$2" >&2; exit 1;; *) ;; esac; }
assert_order() {
  first=$(printf '%s\n' "$1" | grep -n -F "$2" | sed -n '1s/:.*//p')
  second=$(printf '%s\n' "$1" | grep -n -F "$3" | sed -n '1s/:.*//p')
  [ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt "$second" ] || {
    printf 'expected %s before %s\n' "$2" "$3" >&2; exit 1
  }
}

env_before=$(sha256sum "$TMP/app/shared/.env")
release_before=$(sha256sum "$TMP/app/shared/release-images.env")
manifest_before=$(sha256sum "$TMP/app/releases/current.json")
compose_before=$(sha256sum "$REPO_ROOT/compose.yaml" "$REPO_ROOT/compose.prod.yaml")
: > "$TMP/docker.log"
output=$(run_disable)
assert_contains "$output" 'event clip feature disabled on current compatible images'
assert_not_contains "$output" "$SHA"
[ "$(cat "$TMP/app/shared/event-clips-runtime.env")" = 'EVENT_CLIPS_ENABLED=false' ]
[ "$(stat -c '%a' "$TMP/app/shared/event-clips-runtime.env")" = 600 ]
[ "$env_before" = "$(sha256sum "$TMP/app/shared/.env")" ]
[ "$release_before" = "$(sha256sum "$TMP/app/shared/release-images.env")" ]
[ "$manifest_before" = "$(sha256sum "$TMP/app/releases/current.json")" ]
[ "$compose_before" = "$(sha256sum "$REPO_ROOT/compose.yaml" "$REPO_ROOT/compose.prod.yaml")" ]
log=$(cat "$TMP/docker.log")
assert_order "$log" 'stop backend' 'ps -q --status running backend'
assert_order "$log" 'ps -q --status running backend' 'up -d --no-deps --wait --wait-timeout 120 backend'
assert_not_contains "$log" 'stop db'
assert_not_contains "$log" 'stop front'
assert_not_contains "$log" 'up -d db'
assert_not_contains "$log" 'up -d front'
assert_not_contains "$log" 'image rm'

# A volume identity change fails after restart instead of claiming preservation.
printf '%s\n' running > "$TMP/backend.state"
: > "$TMP/docker.log"
set +e
output=$(MOCK_CLIP_DRIFT=1 run_disable); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'clip volume identity changed during feature disable'

# A retagged backend with a different immutable image ID is not considered the
# same compatible release and fails before any stop/start action.
printf '%s\n' running > "$TMP/backend.state"
: > "$TMP/docker.log"
set +e
output=$(MOCK_BACKEND_IMAGE_ID=sha256:unexpected run_disable); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'running services do not use current compatible images'
log=$(cat "$TMP/docker.log")
assert_not_contains "$log" 'stop backend'
assert_not_contains "$log" 'up -d --no-deps'

# A release-env/image mismatch fails before any container state change.
printf '%s\n' running > "$TMP/backend.state"
cp "$TMP/app/shared/release-images.env" "$TMP/release.good"
sed 's/eldercare-backend:/eldercare-backend:bad-/' "$TMP/release.good" > "$TMP/app/shared/release-images.env"
chmod 600 "$TMP/app/shared/release-images.env"
: > "$TMP/docker.log"
set +e
output=$(run_disable); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'release image environment does not match current manifest'
[ ! -s "$TMP/docker.log" ] || { printf '%s\n' 'image mismatch reached Docker' >&2; exit 1; }
mv "$TMP/release.good" "$TMP/app/shared/release-images.env"

# A symlinked runtime override is never replaced.
rm -f "$TMP/app/shared/event-clips-runtime.env"
printf '%s\n' sentinel > "$TMP/elsewhere"
ln -s "$TMP/elsewhere" "$TMP/app/shared/event-clips-runtime.env"
: > "$TMP/docker.log"
set +e
output=$(run_disable); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'feature override must not be a symbolic link'
[ "$(cat "$TMP/elsewhere")" = sentinel ]
[ ! -s "$TMP/docker.log" ] || { printf '%s\n' 'symlinked override reached Docker' >&2; exit 1; }
rm "$TMP/app/shared/event-clips-runtime.env"

# Feature disable shares the normal deployment lock, so it cannot inspect or
# restart containers concurrently with a release or restore.
mkdir "$TMP/app/shared/deploy.lock"
: > "$TMP/docker.log"
set +e
output=$(run_disable); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'another deployment or feature-disable operation is running'
[ ! -s "$TMP/docker.log" ] || {
  printf '%s\n' 'locked feature disable reached Docker' >&2
  exit 1
}
rmdir "$TMP/app/shared/deploy.lock"

# The normal deploy path must retain the disable override and must prove that
# old backend work is stopped before any new backend can start.
deploy_source=$(cat "$DEPLOY")
assert_contains "$deploy_source" 'FEATURE_ENV=${FEATURE_ENV:-$APP_ROOT/shared/event-clips-runtime.env}'
assert_contains "$deploy_source" '--env-file "$FEATURE_ENV"'
assert_contains "$deploy_source" 'assert_backend_stopped'
assert_contains "$deploy_source" 'run compose stop front backend'
assert_contains "$deploy_source" 'run compose up -d --wait --wait-timeout 120 backend front'
stop_line=$(grep -n -F 'run compose stop front backend' "$DEPLOY" | sed -n '1s/:.*//p')
assert_line=$(grep -n -F 'assert_backend_stopped' "$DEPLOY" | sed -n '2s/:.*//p')
start_line=$(grep -n -F 'run compose up -d --wait --wait-timeout 120 backend front' "$DEPLOY" | sed -n '1s/:.*//p')
[ -n "$stop_line" ] && [ -n "$assert_line" ] && [ -n "$start_line" ] && \
  [ "$stop_line" -lt "$assert_line" ] && [ "$assert_line" -lt "$start_line" ] || {
  printf '%s\n' 'deploy path does not prove zero-overlap backend replacement' >&2
  exit 1
}

printf '%s\n' 'event clip feature-disable tests passed'
