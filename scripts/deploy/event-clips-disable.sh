#!/usr/bin/env sh
set -eu

APP_ROOT=${APP_ROOT:-/opt/eldercare-fall-ai}
APP_DIR=${APP_DIR:-$APP_ROOT/repo}
ENV_FILE=${ENV_FILE:-$APP_ROOT/shared/.env}
RELEASE_ENV=${RELEASE_ENV:-$APP_ROOT/shared/release-images.env}
FEATURE_ENV=${FEATURE_ENV:-$APP_ROOT/shared/event-clips-runtime.env}
RELEASE_DIR=${RELEASE_DIR:-$APP_ROOT/releases}
LOCK_DIR=$APP_ROOT/shared/deploy.lock
COMPOSE_FILES='-f compose.yaml -f compose.prod.yaml'
LOCK_HELD=0
TEMP_FILE=''
FEATURE_OVERRIDE_REQUIRED=0

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

owner_only_file() {
  file=$1
  label=$2
  [ ! -L "$file" ] || fail "$label must not be a symbolic link"
  [ -f "$file" ] || fail "$label must be a regular file"
  mode=$(stat -c '%a' "$file") || fail "unable to inspect $label permissions"
  case "$mode" in 400|600) ;; *) fail "$label permissions must be 400 or 600" ;; esac
}

cleanup() {
  status=$?
  cleanup_status=0
  if [ -n "$TEMP_FILE" ] && [ -e "$TEMP_FILE" ] && ! rm -f "$TEMP_FILE"; then
    printf '%s\n' 'failed to remove feature override temporary file' >&2
    cleanup_status=1
  fi
  if [ "$LOCK_HELD" -eq 1 ] && ! rmdir "$LOCK_DIR"; then
    printf '%s\n' 'failed to release feature-disable lock' >&2
    cleanup_status=1
  fi
  trap - 0 HUP INT TERM
  [ "$status" -ne 0 ] && exit "$status"
  exit "$cleanup_status"
}

json_value() {
  sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" "$1"
}

valid_sha() {
  [ "${#1}" -eq 40 ] && printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'
}

compose() {
  if [ "$FEATURE_OVERRIDE_REQUIRED" -eq 1 ]; then
    [ -f "$FEATURE_ENV" ] || fail 'feature override disappeared after activation'
    owner_only_file "$FEATURE_ENV" 'feature override'
    printf '%s\n' 'EVENT_CLIPS_ENABLED=false' | cmp -s - "$FEATURE_ENV" || fail 'feature override changed after activation'
    # shellcheck disable=SC2086 # Fixed Compose file pair.
    docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_ENV" --env-file "$FEATURE_ENV" $COMPOSE_FILES "$@"
  elif [ -f "$FEATURE_ENV" ]; then
    # shellcheck disable=SC2086 # Fixed Compose file pair.
    docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_ENV" --env-file "$FEATURE_ENV" $COMPOSE_FILES "$@"
  else
    # shellcheck disable=SC2086 # Fixed Compose file pair.
    docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_ENV" $COMPOSE_FILES "$@"
  fi
}

container_mount() {
  destination=$1
  container=$2
  docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$destination\"}}{{.Name}}{{end}}{{end}}" "$container"
}

container_image() {
  docker inspect --format '{{.Config.Image}}' "$1"
}

container_image_id() {
  docker inspect --format '{{.Image}}' "$1"
}

need cmp
need docker
need grep
need mkdir
need chmod
need mv
need rm
need rmdir
need sed
need sha256sum
need stat

[ -d "$APP_DIR" ] || fail 'application directory is required'
[ -f "$APP_DIR/compose.yaml" ] && [ ! -L "$APP_DIR/compose.yaml" ] || fail 'compose.yaml must be a regular non-symbolic file'
[ -f "$APP_DIR/compose.prod.yaml" ] && [ ! -L "$APP_DIR/compose.prod.yaml" ] || fail 'compose.prod.yaml must be a regular non-symbolic file'
owner_only_file "$ENV_FILE" 'production environment file'
owner_only_file "$RELEASE_ENV" 'release image environment'
current_manifest=$RELEASE_DIR/current.json
owner_only_file "$current_manifest" 'current release manifest'
if [ -L "$FEATURE_ENV" ]; then
  fail 'feature override must not be a symbolic link'
fi
if [ -e "$FEATURE_ENV" ]; then
  owner_only_file "$FEATURE_ENV" 'feature override'
fi

sha=$(json_value "$current_manifest" sha)
backend_image=$(json_value "$current_manifest" backend_image)
front_image=$(json_value "$current_manifest" front_image)
backend_image_id=$(json_value "$current_manifest" backend_image_id)
front_image_id=$(json_value "$current_manifest" front_image_id)
valid_sha "$sha" || fail 'current release manifest SHA is invalid'
[ "$backend_image" = "eldercare-backend:$sha" ] && [ "$front_image" = "eldercare-front:$sha" ] || {
  fail 'current release manifest image policy is invalid'
}
[ -n "$backend_image_id" ] && [ -n "$front_image_id" ] || fail 'current release manifest image IDs are required'
printf 'BACKEND_IMAGE=%s\nFRONT_IMAGE=%s\n' "$backend_image" "$front_image" | cmp -s - "$RELEASE_ENV" || {
  fail 'release image environment does not match current manifest'
}

mkdir "$LOCK_DIR" 2>/dev/null || fail 'another deployment or feature-disable operation is running'
LOCK_HELD=1
trap cleanup 0 HUP INT TERM

env_before=$(sha256sum "$ENV_FILE")
release_before=$(sha256sum "$RELEASE_ENV")
manifest_before=$(sha256sum "$current_manifest")
compose_before=$(sha256sum "$APP_DIR/compose.yaml" "$APP_DIR/compose.prod.yaml")

cd "$APP_DIR"
db_container=$(compose ps -q db)
backend_container=$(compose ps -q backend)
front_container=$(compose ps -q front)
[ -n "$db_container" ] && [ -n "$backend_container" ] && [ -n "$front_container" ] || {
  fail 'database, backend, and frontend must be present for feature disable'
}
db_volume=$(container_mount /var/lib/postgresql/data "$db_container")
clip_volume=$(container_mount /app/backend/clips "$backend_container")
[ -n "$db_volume" ] || fail 'database volume identity is unavailable'
[ -n "$clip_volume" ] || fail 'clip volume identity is unavailable'
[ "$(container_image "$backend_container")" = "$backend_image" ] && \
  [ "$(container_image "$front_container")" = "$front_image" ] && \
  [ "$(container_image_id "$backend_container")" = "$backend_image_id" ] && [ "$(container_image_id "$front_container")" = "$front_image_id" ] || {
  fail 'running services do not use current compatible images'
}

umask 077
TEMP_FILE=$FEATURE_ENV.$$.tmp
printf '%s\n' 'EVENT_CLIPS_ENABLED=false' > "$TEMP_FILE"
mv "$TEMP_FILE" "$FEATURE_ENV"
TEMP_FILE=''
chmod 600 "$FEATURE_ENV"
FEATURE_OVERRIDE_REQUIRED=1

feature_config=$(compose --profile full config) || fail 'unable to render disabled feature configuration'
printf '%s\n' "$feature_config" | grep -E 'EVENT_CLIPS_ENABLED:[[:space:]]*"?false"?' >/dev/null || {
  fail 'disabled feature configuration was not applied'
}

compose stop backend
running_backend=$(compose ps -q --status running backend)
[ -z "$running_backend" ] || fail 'old backend is still running; zero-overlap replacement refused'
compose up -d --no-deps --wait --wait-timeout 120 backend

new_db_container=$(compose ps -q db)
new_backend_container=$(compose ps -q backend)
new_front_container=$(compose ps -q front)
[ -n "$new_db_container" ] && [ -n "$new_backend_container" ] && [ -n "$new_front_container" ] || {
  fail 'service identity unavailable after feature disable'
}
[ "$(container_mount /var/lib/postgresql/data "$new_db_container")" = "$db_volume" ] || {
  fail 'database volume identity changed during feature disable'
}
[ "$(container_mount /app/backend/clips "$new_backend_container")" = "$clip_volume" ] || {
  fail 'clip volume identity changed during feature disable'
}
[ "$(container_image "$new_backend_container")" = "$backend_image" ] && \
  [ "$(container_image "$new_front_container")" = "$front_image" ] && \
  [ "$(container_image_id "$new_backend_container")" = "$backend_image_id" ] && [ "$(container_image_id "$new_front_container")" = "$front_image_id" ] || {
  fail 'feature disable changed the compatible release images'
}
[ "$env_before" = "$(sha256sum "$ENV_FILE")" ] || fail 'production environment changed during feature disable'
[ "$release_before" = "$(sha256sum "$RELEASE_ENV")" ] || fail 'release image environment changed during feature disable'
[ "$manifest_before" = "$(sha256sum "$current_manifest")" ] || fail 'current release manifest changed during feature disable'
[ "$compose_before" = "$(sha256sum "$APP_DIR/compose.yaml" "$APP_DIR/compose.prod.yaml")" ] || fail 'compose configuration changed during feature disable'
printf '%s\n' 'EVENT_CLIPS_ENABLED=false' | cmp -s - "$FEATURE_ENV" || fail 'feature override changed during verification'

rmdir "$LOCK_DIR" || fail 'failed to release feature-disable lock'
LOCK_HELD=0
trap - 0 HUP INT TERM
printf '%s\n' 'event clip feature disabled on current compatible images'
