#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
APP_ROOT=${APP_ROOT:-/opt/eldercare-fall-ai}
APP_DIR=${APP_DIR:-$APP_ROOT/repo}
ENV_FILE=${ENV_FILE:-$APP_ROOT/shared/.env}
RELEASE_ENV=${RELEASE_ENV:-$APP_ROOT/shared/release-images.env}
BACKUP_DESTINATION=${BACKUP_DESTINATION:-}
CLIP_VOLUME_NAME=${CLIP_VOLUME_NAME:-}
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-}
HELPER_IMAGE=postgres:17-alpine
MARKER=.eldercare-event-media-backup
LOCK_HELD=0
STAGE=''
LOCK_DIR=''

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

usage() {
  printf '%s\n' 'Usage: event-media-backup.sh [--check-inputs-only]' >&2
  exit 2
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

owner_only_file() {
  file=$1
  label=$2
  [ ! -L "$file" ] || fail "$label must not be a symbolic link"
  [ -f "$file" ] || fail "$label must be a regular file"
  mode=$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file") || fail "unable to inspect $label permissions"
  case "$mode" in
    400|600) ;;
    *) fail "$label permissions must be 400 or 600" ;;
  esac
}

validate_inputs() {
  need findmnt
  need readlink
  need stat

  case "$BACKUP_DESTINATION" in
    /*) ;;
    *) fail 'backup destination must be an absolute path' ;;
  esac
  case "$BACKUP_DESTINATION" in
    *[!A-Za-z0-9_./-]*) fail 'backup destination contains unsupported characters' ;;
  esac
  [ ! -L "$BACKUP_DESTINATION" ] || fail 'backup destination must not be a symbolic link'
  [ -d "$BACKUP_DESTINATION" ] || fail 'backup destination must be an existing directory'
  canonical_destination=$(readlink -f "$BACKUP_DESTINATION") || fail 'unable to resolve backup destination'
  [ "$canonical_destination" = "$BACKUP_DESTINATION" ] || fail 'backup destination must use its canonical path'
  destination_mode=$(stat -c '%a' "$BACKUP_DESTINATION" 2>/dev/null || stat -f '%Lp' "$BACKUP_DESTINATION") || fail 'unable to inspect backup destination permissions'
  [ "$destination_mode" = 700 ] || fail 'backup destination permissions must be 700'

  marker=$BACKUP_DESTINATION/$MARKER
  [ -e "$marker" ] || fail 'backup destination marker is required'
  owner_only_file "$marker" 'backup destination marker'
  marker_lines=$(wc -l < "$marker")
  [ "$marker_lines" -eq 1 ] && [ "$(sed -n '1p' "$marker")" = 'eldercare-event-media-backup-v1' ] || {
    fail 'backup destination marker is invalid'
  }

  [ -d "$APP_ROOT" ] || fail 'application root must be an existing directory'
  destination_mount=$(findmnt -n -o TARGET -T "$BACKUP_DESTINATION") || fail 'unable to inspect backup destination mount'
  application_mount=$(findmnt -n -o TARGET -T "$APP_ROOT") || fail 'unable to inspect application mount'
  destination_device=$(stat -c '%d' "$BACKUP_DESTINATION" 2>/dev/null || stat -f '%d' "$BACKUP_DESTINATION") || fail 'unable to inspect backup destination filesystem'
  application_device=$(stat -c '%d' "$APP_ROOT" 2>/dev/null || stat -f '%d' "$APP_ROOT") || fail 'unable to inspect application filesystem'
  [ -n "$destination_mount" ] && [ "$destination_mount" != "$application_mount" ] &&
    [ "$destination_device" != "$application_device" ] || {
    fail 'backup destination must be on a separate mounted filesystem'
  }

  owner_only_file "$ENV_FILE" 'environment file'
  if [ -e "$RELEASE_ENV" ] || [ -L "$RELEASE_ENV" ]; then
    owner_only_file "$RELEASE_ENV" 'release environment file'
  fi
  for compose_file in "$APP_DIR/compose.yaml" "$APP_DIR/compose.prod.yaml"; do
    [ ! -L "$compose_file" ] || fail 'compose files must not be symbolic links'
    [ -f "$compose_file" ] || fail 'both compose files must be regular files'
  done

  case "$CLIP_VOLUME_NAME" in
    ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) fail 'clip volume name contains unsupported characters' ;;
  esac
  case "$COMPOSE_PROJECT_NAME" in
    '' ) ;;
    [!a-z0-9]*|*[!a-z0-9_-]*) fail 'compose project name contains unsupported characters' ;;
  esac
}

compose() {
  if [ -n "$COMPOSE_PROJECT_NAME" ]; then
    if [ -f "$RELEASE_ENV" ]; then
      docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" \
        --env-file "$RELEASE_ENV" -f compose.yaml -f compose.prod.yaml "$@"
    else
      BACKEND_IMAGE=backup-only FRONT_IMAGE=backup-only docker compose \
        --project-name "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" \
        -f compose.yaml -f compose.prod.yaml "$@"
    fi
  elif [ -f "$RELEASE_ENV" ]; then
    docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_ENV" \
      -f compose.yaml -f compose.prod.yaml "$@"
  else
    BACKEND_IMAGE=backup-only FRONT_IMAGE=backup-only docker compose \
      --env-file "$ENV_FILE" -f compose.yaml -f compose.prod.yaml "$@"
  fi
}

cleanup() {
  status=$?
  cleanup_status=0
  if [ -n "$STAGE" ] && [ -d "$STAGE" ] && ! rm -rf "$STAGE"; then
    printf '%s\n' 'unable to remove incomplete backup stage' >&2
    cleanup_status=1
  fi
  if [ "$LOCK_HELD" -eq 1 ] && ! rmdir "$LOCK_DIR"; then
    printf '%s\n' 'unable to release backup lock' >&2
    cleanup_status=1
  fi
  trap - 0 HUP INT TERM
  [ "$status" -ne 0 ] && exit "$status"
  exit "$cleanup_status"
}

[ "$#" -le 1 ] || usage
MODE=${1:-}
[ -z "$MODE" ] || [ "$MODE" = --check-inputs-only ] || usage
validate_inputs
if [ "$MODE" = --check-inputs-only ]; then
  printf '%s\n' 'event media backup inputs verified'
  exit 0
fi

need awk
need date
need docker
need id
need mktemp
need mv
need rm
need rmdir
need sed
need sha256sum
need sync
need tar
need wc

cd "$APP_DIR"
compose config --services | grep -Fx db >/dev/null || fail 'compose configuration must contain the database service'
docker volume inspect "$CLIP_VOLUME_NAME" >/dev/null 2>&1 || fail 'clip volume does not exist'
backend_container=$(compose ps -q backend)
[ -n "$backend_container" ] || fail 'backend must be running for an event media backup'
mounted_clip_volume=$(docker inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/app/backend/clips"}}{{println .Name}}{{end}}{{end}}' \
  "$backend_container")
[ "$mounted_clip_volume" = "$CLIP_VOLUME_NAME" ] || {
  fail 'clip volume must be the backend media mount'
}

LOCK_DIR=$BACKUP_DESTINATION/.event-media-backup.lock
mkdir "$LOCK_DIR" 2>/dev/null || fail 'another event media backup is already running'
LOCK_HELD=1
trap cleanup 0 HUP INT TERM
umask 077
STAGE=$(mktemp -d "$BACKUP_DESTINATION/.event-media.XXXXXX")
stage_suffix=${STAGE##*.}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
FINAL=$BACKUP_DESTINATION/event-media-$timestamp-$stage_suffix
[ ! -e "$FINAL" ] || fail 'backup publication path already exists'

compose exec -T db sh -ceu \
  'exec pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom' \
  > "$STAGE/database.dump"
[ -s "$STAGE/database.dump" ] || fail 'database archive is empty'
compose exec -T db sh -ceu 'exec pg_restore --list' \
  < "$STAGE/database.dump" >/dev/null

backup_uid=$(id -u)
backup_gid=$(id -g)
case "$backup_uid:$backup_gid" in *[!0-9:]*) fail 'unable to determine backup artifact ownership' ;; esac
docker run --rm --network none --read-only \
  -e BACKUP_UID="$backup_uid" -e BACKUP_GID="$backup_gid" \
  --mount "type=volume,src=$CLIP_VOLUME_NAME,dst=/source,readonly" \
  --mount "type=bind,src=$STAGE,dst=/backup" \
  "$HELPER_IMAGE" sh -ceu '
    tar -C /source -cf /backup/clips.tar .
    chmod 600 /backup/clips.tar
    chown "$BACKUP_UID:$BACKUP_GID" /backup/clips.tar
  '
[ -s "$STAGE/clips.tar" ] || fail 'clip archive is empty'
tar -tf "$STAGE/clips.tar" >/dev/null || fail 'clip archive is unreadable'

database_sha=$(sha256sum "$STAGE/database.dump" | awk '{print $1}')
clip_sha=$(sha256sum "$STAGE/clips.tar" | awk '{print $1}')
cat > "$STAGE/MANIFEST" <<EOF
FORMAT=event-media-backup-v1
CREATED_AT=$timestamp
DATABASE_ARCHIVE=database.dump
DATABASE_SHA256=$database_sha
CLIP_ARCHIVE=clips.tar
CLIP_SHA256=$clip_sha
EOF
chmod 600 "$STAGE/MANIFEST" "$STAGE/database.dump" "$STAGE/clips.tar"
sh "$SCRIPT_DIR/validate-event-media-backup.sh" "$STAGE"
sync -f "$STAGE/MANIFEST" "$STAGE/database.dump" "$STAGE/clips.tar" "$STAGE"
mv "$STAGE" "$FINAL"
STAGE=''
sync -f "$BACKUP_DESTINATION"
rmdir "$LOCK_DIR" || fail 'unable to release backup lock'
LOCK_HELD=0

printf '%s\n' 'event media backup completed'
