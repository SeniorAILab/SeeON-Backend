#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
BACKUP_SCRIPT=$REPO_ROOT/scripts/deploy/event-media-backup.sh
VALIDATE_SCRIPT=$REPO_ROOT/scripts/deploy/validate-event-media-backup.sh
TMP=$(mktemp -d)
STACK_DIR=$TMP/event-media-stack-$$
OFF_HOST_ROOT=/dev/shm/event-media-restore-$$
SOURCE_VOLUME=event_media_source_$$
TARGET_VOLUME=event_media_target_$$
TARGET_CONTAINER=event-media-target-$$
PROJECT_NAME=event-media-stack-$$
HELPER_IMAGE=postgres:17-alpine

compose() {
  docker compose --project-name "$PROJECT_NAME" --env-file "$STACK_DIR/env" \
    -f "$STACK_DIR/compose.yaml" -f "$STACK_DIR/compose.prod.yaml" "$@"
}

cleanup() {
  status=$?
  if ! compose down --volumes --remove-orphans >/dev/null 2>&1; then
    [ "$status" -ne 0 ] || status=1
  fi
  if docker container inspect "$TARGET_CONTAINER" >/dev/null 2>&1 && \
    ! docker rm -f "$TARGET_CONTAINER" >/dev/null
  then
    [ "$status" -ne 0 ] || status=1
  fi
  for volume in "$SOURCE_VOLUME" "$TARGET_VOLUME"; do
    if docker volume inspect "$volume" >/dev/null 2>&1 && \
      ! docker volume rm "$volume" >/dev/null
    then
      [ "$status" -ne 0 ] || status=1
    fi
  done
  if ! rm -rf "$TMP" "$OFF_HOST_ROOT"; then
    [ "$status" -ne 0 ] || status=1
  fi
  trap - 0 HUP INT TERM
  exit "$status"
}
trap cleanup 0 HUP INT TERM

wait_for_database() {
  container=$1
  ready=0
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if [ "$(docker exec "$container" psql --username fixture_admin \
      --dbname fixture_db -Atc 'SELECT 1' 2>/dev/null || true)" = 1 ]
    then
      ready=1
      break
    fi
    sleep 1
  done
  [ "$ready" -eq 1 ] || {
    printf 'disposable database was not ready after %s attempts\n' "$attempt" >&2
    exit 1
  }
}

mkdir -p "$STACK_DIR" "$OFF_HOST_ROOT" "$TMP/fixture/nested"
chmod 700 "$OFF_HOST_ROOT"
printf '%s\n' 'eldercare-event-media-backup-v1' > "$OFF_HOST_ROOT/.eldercare-event-media-backup"
chmod 600 "$OFF_HOST_ROOT/.eldercare-event-media-backup"
printf '%s\n' 'synthetic event clip bytes' > "$TMP/fixture/nested/clip.mp4"
expected_clip_sha=$(sha256sum "$TMP/fixture/nested/clip.mp4" | awk '{print $1}')

cat > "$STACK_DIR/compose.yaml" <<'YAML'
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready --username $$POSTGRES_USER --dbname $$POSTGRES_DB"]
      interval: 1s
      timeout: 2s
      retries: 20
  backend:
    image: postgres:17-alpine
    command: ["sh", "-ceu", "while :; do sleep 3600; done"]
    volumes:
      - clip_fixture:/app/backend/clips
volumes:
  clip_fixture:
    external: true
    name: ${CLIP_VOLUME_NAME}
YAML
printf '%s\n' 'services: {}' > "$STACK_DIR/compose.prod.yaml"
cat > "$STACK_DIR/env" <<'ENV'
POSTGRES_USER=fixture_admin
POSTGRES_PASSWORD=fixture_password
POSTGRES_DB=fixture_db
SYNTHETIC_SECRET=must-not-leak
ENV
printf 'CLIP_VOLUME_NAME=%s\n' "$SOURCE_VOLUME" >> "$STACK_DIR/env"
chmod 600 "$STACK_DIR/env"

docker volume create "$SOURCE_VOLUME" >/dev/null
docker volume create "$TARGET_VOLUME" >/dev/null
compose up -d --wait db backend >/dev/null
source_container=$(compose ps -q db)
[ -n "$source_container" ] || { printf '%s\n' 'source database container missing' >&2; exit 1; }
compose exec -T db psql -v ON_ERROR_STOP=1 --username fixture_admin --dbname fixture_db <<'SQL' >/dev/null
CREATE TABLE backup_sentinel (id integer PRIMARY KEY, value text NOT NULL);
INSERT INTO backup_sentinel VALUES (1, 'synthetic restored row');
SQL

docker run --rm --network none \
  --mount "type=bind,src=$TMP/fixture,dst=/fixture,readonly" \
  --mount "type=volume,src=$SOURCE_VOLUME,dst=/clips" \
  "$HELPER_IMAGE" sh -ceu 'cp -R /fixture/. /clips/; chmod 600 /clips/nested/clip.mp4'

# Given a sanitized but unrelated volume name, when backup starts, then it is
# rejected before archiving because only the backend-mounted clip volume is valid.
set +e
wrong_output=$(APP_ROOT=$TMP APP_DIR=$STACK_DIR ENV_FILE=$STACK_DIR/env \
  BACKUP_DESTINATION=$OFF_HOST_ROOT CLIP_VOLUME_NAME=$TARGET_VOLUME \
  COMPOSE_PROJECT_NAME=$PROJECT_NAME sh "$BACKUP_SCRIPT" 2>&1); wrong_status=$?
set -e
[ "$wrong_status" -ne 0 ] || { printf '%s\n' 'unmounted clip volume unexpectedly backed up' >&2; exit 1; }
case "$wrong_output" in
  *'clip volume must be the backend media mount'*) ;;
  *must-not-leak*|*fixture_password*) printf '%s\n' 'wrong-volume denial leaked credentials' >&2; exit 1 ;;
  *) printf '%s\n' 'wrong-volume denial failed for the wrong reason' >&2; exit 1 ;;
esac

# Given disposable database and clip fixtures, when a backup is created, then
# only a validated atomic bundle appears on the separate destination filesystem.
output=$(APP_ROOT=$TMP APP_DIR=$STACK_DIR ENV_FILE=$STACK_DIR/env \
  BACKUP_DESTINATION=$OFF_HOST_ROOT CLIP_VOLUME_NAME=$SOURCE_VOLUME \
  COMPOSE_PROJECT_NAME=$PROJECT_NAME sh "$BACKUP_SCRIPT" 2>&1)
case "$output" in
  *must-not-leak*|*fixture_password*)
    printf '%s\n' 'backup output exposed fixture credentials' >&2
    exit 1 ;;
  *'event media backup completed'*) ;;
  *) printf '%s\n' 'backup did not report completion' >&2; exit 1 ;;
esac

bundle=$(find "$OFF_HOST_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'event-media-*' -print)
[ -n "$bundle" ] && [ "$(printf '%s\n' "$bundle" | wc -l)" -eq 1 ] || {
  printf '%s\n' 'expected exactly one published backup bundle' >&2
  exit 1
}
sh "$VALIDATE_SCRIPT" "$bundle"
[ "$(stat -c '%a' "$bundle")" = 700 ] || { printf '%s\n' 'backup bundle permissions are not 700' >&2; exit 1; }
for file in MANIFEST database.dump clips.tar; do
  [ "$(stat -c '%a' "$bundle/$file")" = 600 ] || {
    printf 'backup artifact permissions are not 600: %s\n' "$file" >&2
    exit 1
  }
done

# Given a changed archive byte, when validated, then checksum verification fails.
mkdir -p "$TMP/corrupt"
chmod 700 "$TMP/corrupt"
cp "$bundle"/* "$TMP/corrupt/"
printf 'x' >> "$TMP/corrupt/database.dump"
set +e
corrupt_output=$(sh "$VALIDATE_SCRIPT" "$TMP/corrupt" 2>&1); corrupt_status=$?
set -e
[ "$corrupt_status" -ne 0 ] || { printf '%s\n' 'corrupt backup unexpectedly validated' >&2; exit 1; }
case "$corrupt_output" in
  *'database archive checksum mismatch'*) ;;
  *) printf '%s\n' 'corrupt backup failed for the wrong reason' >&2; exit 1 ;;
esac

# Given the validated generic bundle, when restored into disposable targets,
# then the synthetic database row and exact clip checksum are recovered. The
# product schema/binding/migration rehearsal remains Todo 18.
docker run -d --name "$TARGET_CONTAINER" \
  -e POSTGRES_USER=fixture_admin \
  -e POSTGRES_PASSWORD=fixture_password \
  -e POSTGRES_DB=fixture_db \
  "$HELPER_IMAGE" >/dev/null
wait_for_database "$TARGET_CONTAINER"
docker exec -i "$TARGET_CONTAINER" pg_restore --username fixture_admin \
  --dbname fixture_db --no-owner --exit-on-error --single-transaction < "$bundle/database.dump"
restored_row=$(docker exec "$TARGET_CONTAINER" psql -v ON_ERROR_STOP=1 \
  --username fixture_admin --dbname fixture_db -Atc \
  'SELECT value FROM backup_sentinel WHERE id = 1')
[ "$restored_row" = 'synthetic restored row' ] || {
  printf '%s\n' 'database fixture did not restore' >&2
  exit 1
}

docker run --rm --network none \
  --mount "type=bind,src=$bundle,dst=/backup,readonly" \
  --mount "type=volume,src=$TARGET_VOLUME,dst=/clips" \
  "$HELPER_IMAGE" sh -ceu 'tar -C /clips -xf /backup/clips.tar'
restored_clip_sha=$(docker run --rm --network none \
  --mount "type=volume,src=$TARGET_VOLUME,dst=/clips,readonly" \
  "$HELPER_IMAGE" sha256sum /clips/nested/clip.mp4 | awk '{print $1}')
[ "$restored_clip_sha" = "$expected_clip_sha" ] || {
  printf '%s\n' 'clip fixture checksum did not restore' >&2
  exit 1
}

printf '%s\n' 'event media disposable restore harness passed'
