#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
BACKUP_SCRIPT=$REPO_ROOT/scripts/deploy/event-media-backup.sh
VALIDATE_SCRIPT=$REPO_ROOT/scripts/deploy/validate-event-media-backup.sh
MIGRATIONS_DIR=$REPO_ROOT/backend/prisma/migrations
INIT_DIR=$REPO_ROOT/backend/prisma/init
TMP=$(mktemp -d)
STACK_DIR=$TMP/event-media-product-stack-$$
OFF_HOST_ROOT=/dev/shm/event-media-product-restore-$$
SOURCE_VOLUME=event_media_product_source_$$
TARGET_VOLUME=event_media_product_target_$$
TARGET_CONTAINER=event-media-product-target-$$
PROJECT_NAME=event-media-product-stack-$$
HELPER_IMAGE=postgres:17-alpine
FIXTURE_DB_USER=fixture_admin
FIXTURE_DB_PASSWORD=fixture_password
FIXTURE_DB_NAME=fixture_db
FIXTURE_APP_PASSWORD=fixture_app_password
FACILITY_ID=restore_facility_a
EVENT_ID=restore_event_a
CLIP_ID=restore_clip_a

compose() {
  docker compose --project-name "$PROJECT_NAME" --env-file "$STACK_DIR/env" \
    -f "$STACK_DIR/compose.yaml" -f "$STACK_DIR/compose.prod.yaml" "$@"
}

cleanup() {
  status=$?
  cleanup_status=0
  if [ -f "$STACK_DIR/compose.yaml" ] && \
    ! compose down --volumes --remove-orphans >/dev/null 2>&1
  then
    cleanup_status=1
  fi
  if docker container inspect "$TARGET_CONTAINER" >/dev/null 2>&1 && \
    ! docker rm -f -v "$TARGET_CONTAINER" >/dev/null
  then
    cleanup_status=1
  fi
  for volume in "$SOURCE_VOLUME" "$TARGET_VOLUME"; do
    if docker volume inspect "$volume" >/dev/null 2>&1 && \
      ! docker volume rm "$volume" >/dev/null
    then
      cleanup_status=1
    fi
  done
  if ! rm -rf "$TMP" "$OFF_HOST_ROOT"; then
    cleanup_status=1
  fi
  if docker network inspect "${PROJECT_NAME}_default" >/dev/null 2>&1 || \
    docker container inspect "$TARGET_CONTAINER" >/dev/null 2>&1 || \
    docker volume inspect "$SOURCE_VOLUME" >/dev/null 2>&1 || \
    docker volume inspect "$TARGET_VOLUME" >/dev/null 2>&1 || \
    [ -e "$TMP" ] || [ -e "$OFF_HOST_ROOT" ]
  then
    cleanup_status=1
  fi
  if [ "$cleanup_status" -eq 0 ]; then
    printf '%s\n' 'event media product restore cleanup complete'
  else
    printf '%s\n' 'event media product restore cleanup incomplete' >&2
  fi
  trap - 0 HUP INT TERM
  [ "$status" -ne 0 ] && exit "$status"
  exit "$cleanup_status"
}
trap cleanup 0 HUP INT TERM

wait_for_database() {
  container=$1
  ready=0
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if [ "$(docker exec "$container" psql --username "$FIXTURE_DB_USER" \
      --dbname "$FIXTURE_DB_NAME" -Atc 'SELECT 1' 2>/dev/null || true)" = 1 ]
    then
      ready=1
      break
    fi
    sleep 1
  done
  [ "$ready" -eq 1 ] || {
    printf 'disposable database was not ready after %s attempts\n' "$attempt" >&2
    return 1
  }
}

database_url() {
  container=$1
  address=$(docker inspect --format \
    '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' \
    "$container" | sed -n '1p')
  [ -n "$address" ] || {
    printf '%s\n' 'disposable database address is unavailable' >&2
    return 1
  }
  printf 'postgresql://%s:%s@%s:5432/%s?schema=public\n' \
    "$FIXTURE_DB_USER" "$FIXTURE_DB_PASSWORD" "$address" "$FIXTURE_DB_NAME"
}

run_migrate_deploy() {
  container=$1
  url=$(database_url "$container")
  DATABASE_URL=$url DIRECT_URL=$url \
    pnpm --dir "$REPO_ROOT/backend" exec prisma migrate deploy \
      --schema prisma/schema.prisma
}

run_migrate_status() {
  container=$1
  url=$(database_url "$container")
  DATABASE_URL=$url DIRECT_URL=$url \
    pnpm --dir "$REPO_ROOT/backend" exec prisma migrate status \
      --schema prisma/schema.prisma
}

sanitized_error() {
  printf '%s\n' "$1" | sed -E \
    -e 's#postgresql://[^[:space:]"?]+#postgresql://[redacted]#g' \
    -e 's# at "[^"]+"# at "[redacted]"#g' \
    -e 's#fixture_(admin|password|app_password)#[redacted]#g' >&2
}

applied_migration_count() {
  container=$1
  docker exec "$container" psql -v ON_ERROR_STOP=1 \
    --username "$FIXTURE_DB_USER" --dbname "$FIXTURE_DB_NAME" -Atc \
    'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'
}

media_row() {
  container=$1
  docker exec "$container" psql -v ON_ERROR_STOP=1 \
    --username "$FIXTURE_DB_USER" --dbname "$FIXTURE_DB_NAME" -Atc \
    "SELECT concat_ws('|', f.id, f.name, e.id, mc.id, emb.event_id, mc.storage_key, btrim(mc.sha256), mc.byte_size::text)
       FROM facilities f
       JOIN events e ON e.facility_id = f.id
       JOIN event_media_bindings emb ON emb.facility_id = e.facility_id AND emb.event_id = e.id
       JOIN media_clips mc ON mc.facility_id = emb.facility_id AND mc.id = emb.clip_id
      WHERE f.id = '$FACILITY_ID' AND e.id = '$EVENT_ID' AND mc.id = '$CLIP_ID'"
}

verify_restored_media() {
  container=$1
  volume=$2
  actual_row=$(media_row "$container") || return 1
  [ "$actual_row" = "$expected_media_row" ] || {
    printf '%s\n' 'restored product rows or binding do not match source' >&2
    return 1
  }
  if ! file_meta=$(docker run --rm --network none \
    --mount "type=volume,src=$volume,dst=/clips,readonly" \
    "$HELPER_IMAGE" sh -ceu '
      path=/clips/'"$STORAGE_KEY"'
      [ -f "$path" ] || exit 3
      printf "%s|%s\n" "$(sha256sum "$path" | cut -d " " -f 1)" "$(wc -c < "$path")"
    ')
  then
    printf '%s\n' 'restored clip file is missing' >&2
    return 1
  fi
  [ "$file_meta" = "$expected_clip_sha|$expected_clip_bytes" ] || {
    printf '%s\n' 'restored clip checksum or byte size does not match source' >&2
    return 1
  }
}

mkdir -p "$STACK_DIR" "$OFF_HOST_ROOT"
chmod 700 "$OFF_HOST_ROOT"
printf '%s\n' 'eldercare-event-media-backup-v1' > "$OFF_HOST_ROOT/.eldercare-event-media-backup"
chmod 600 "$OFF_HOST_ROOT/.eldercare-event-media-backup"
printf '%s' 'synthetic-h264-mp4-event-clip-bytes-v1' > "$TMP/clip-source.mp4"
expected_clip_sha=$(sha256sum "$TMP/clip-source.mp4" | awk '{print $1}')
STORAGE_KEY=$FACILITY_ID/$CLIP_ID/$expected_clip_sha.mp4
mkdir -p "$TMP/fixture/$FACILITY_ID/$CLIP_ID"
mv "$TMP/clip-source.mp4" "$TMP/fixture/$STORAGE_KEY"
chmod 600 "$TMP/fixture/$STORAGE_KEY"
expected_clip_bytes=$(wc -c < "$TMP/fixture/$STORAGE_KEY")
expected_media_row="$FACILITY_ID|Synthetic Restore Facility|$EVENT_ID|$CLIP_ID|$EVENT_ID|$STORAGE_KEY|$expected_clip_sha|$expected_clip_bytes"
expected_migration_count=$(find "$MIGRATIONS_DIR" -mindepth 2 -maxdepth 2 \
  -name migration.sql | wc -l)
[ "$expected_migration_count" -gt 0 ] || {
  printf '%s\n' 'product migration history is empty' >&2
  exit 1
}
printf '%s\n' "$STORAGE_KEY" | \
  grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/[a-f0-9]{64}\.mp4$' || {
  printf '%s\n' 'fixture storage key is incompatible with immutable clip storage' >&2
  exit 1
}
[ "${STORAGE_KEY##*/}" = "$expected_clip_sha.mp4" ] || {
  printf '%s\n' 'fixture storage key filename does not match clip digest' >&2
  exit 1
}

cat > "$STACK_DIR/compose.yaml" <<'YAML'
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      APP_DB_USER: fall_app
      APP_DB_PASSWORD: ${APP_DB_PASSWORD}
    volumes:
      - ${PRISMA_INIT_DIR}:/docker-entrypoint-initdb.d:ro
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
cat > "$STACK_DIR/env" <<ENV
POSTGRES_USER=$FIXTURE_DB_USER
POSTGRES_PASSWORD=$FIXTURE_DB_PASSWORD
POSTGRES_DB=$FIXTURE_DB_NAME
APP_DB_PASSWORD=$FIXTURE_APP_PASSWORD
PRISMA_INIT_DIR=$INIT_DIR
CLIP_VOLUME_NAME=$SOURCE_VOLUME
SYNTHETIC_SECRET=must-not-leak
ENV
chmod 600 "$STACK_DIR/env"

docker volume create "$SOURCE_VOLUME" >/dev/null
docker volume create "$TARGET_VOLUME" >/dev/null
compose up -d --wait db backend >/dev/null
source_container=$(compose ps -q db)
[ -n "$source_container" ] || {
  printf '%s\n' 'source database container missing' >&2
  exit 1
}

set +e
migration_output=$(run_migrate_deploy "$source_container" 2>&1)
migration_status=$?
set -e
[ "$migration_status" -eq 0 ] || {
  sanitized_error "$migration_output"
  printf '%s\n' 'source product migrations failed' >&2
  exit 1
}
case "$migration_output" in
  *fixture_password*|*fixture_app_password*|*must-not-leak*)
    printf '%s\n' 'source migration output exposed fixture credentials' >&2
    exit 1 ;;
esac
[ "$(applied_migration_count "$source_container")" -eq "$expected_migration_count" ] || {
  printf '%s\n' 'complete product migration history was not applied to source' >&2
  exit 1
}

docker exec -i "$source_container" psql -v ON_ERROR_STOP=1 \
  --username "$FIXTURE_DB_USER" --dbname "$FIXTURE_DB_NAME" \
  -v clip_sha="$expected_clip_sha" -v clip_bytes="$expected_clip_bytes" \
  -v storage_key="$STORAGE_KEY" <<'SQL' >/dev/null
INSERT INTO facilities (id, name) VALUES ('restore_facility_a', 'Synthetic Restore Facility');
INSERT INTO floors (id, facility_id, name, order_index)
VALUES ('restore_floor_a', 'restore_facility_a', 'Restore Floor', 1);
INSERT INTO spaces (id, facility_id, floor_id, name, type, capacity)
VALUES ('restore_space_a', 'restore_facility_a', 'restore_floor_a', 'Restore Room', 'ROOM', 1);
INSERT INTO cameras (id, facility_id, space_id, label, online)
VALUES ('restore_camera_a', 'restore_facility_a', 'restore_space_a', 'Restore Camera', true);
INSERT INTO events (
  id, facility_id, camera_id, space_id, type, confidence, detected_at,
  created_at, modified_at, dedup_key, edge_event_id
) VALUES (
  'restore_event_a', 'restore_facility_a', 'restore_camera_a', 'restore_space_a',
  'FALL', 0.98, '2026-07-16T01:02:03Z', '2026-07-16T01:02:04Z',
  '2026-07-16T01:02:04Z', 'restore-dedup-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
);
INSERT INTO media_clips (
  id, facility_id, camera_id, external_clip_id, status, state_version,
  storage_state, storage_key, content_type, byte_size, sha256, codec,
  duration_ms, finalized_at, clip_start_at, clip_end_at, ready_at,
  expires_at, created_at, updated_at
) VALUES (
  'restore_clip_a', 'restore_facility_a', 'restore_camera_a', 'restore-external-a',
  'READY', 1, 'READY', :'storage_key', 'video/mp4',
  :'clip_bytes'::bigint, :'clip_sha', 'h264', 3000, '2026-07-16T01:02:07Z',
  '2026-07-16T01:02:02Z', '2026-07-16T01:02:05Z', '2026-07-16T01:02:07Z',
  '2026-09-14T01:02:07Z', '2026-07-16T01:02:04Z', '2026-07-16T01:02:07Z'
);
INSERT INTO event_media_bindings (event_id, facility_id, clip_id, ordinal, created_at)
VALUES ('restore_event_a', 'restore_facility_a', 'restore_clip_a', 0, '2026-07-16T01:02:07Z');
SQL

tenant_count=$(docker exec -e PGPASSWORD="$FIXTURE_APP_PASSWORD" "$source_container" \
  psql -qAt -h 127.0.0.1 --username fall_app --dbname "$FIXTURE_DB_NAME" \
  -c "SET app.facility_id = '$FACILITY_ID'; SELECT count(*) FROM media_clips;")
[ "$tenant_count" -eq 1 ] || {
  printf '%s\n' 'tenant-scoped app role could not read its media row' >&2
  exit 1
}
cross_tenant_count=$(docker exec -e PGPASSWORD="$FIXTURE_APP_PASSWORD" "$source_container" \
  psql -qAt -h 127.0.0.1 --username fall_app --dbname "$FIXTURE_DB_NAME" \
  -c "SET app.facility_id = 'restore_facility_b'; SELECT count(*) FROM media_clips;")
[ "$cross_tenant_count" -eq 0 ] || {
  printf '%s\n' 'tenant-scoped app role crossed the facility boundary' >&2
  exit 1
}
[ "$(media_row "$source_container")" = "$expected_media_row" ] || {
  printf '%s\n' 'source product rows or binding do not match fixture contract' >&2
  exit 1
}

docker run --rm --network none \
  --mount "type=bind,src=$TMP/fixture,dst=/fixture,readonly" \
  --mount "type=volume,src=$SOURCE_VOLUME,dst=/clips" \
  "$HELPER_IMAGE" sh -ceu 'cp -R /fixture/. /clips/'

backup_output=$(APP_ROOT=$TMP APP_DIR=$STACK_DIR ENV_FILE=$STACK_DIR/env \
  BACKUP_DESTINATION=$OFF_HOST_ROOT CLIP_VOLUME_NAME=$SOURCE_VOLUME \
  COMPOSE_PROJECT_NAME=$PROJECT_NAME sh "$BACKUP_SCRIPT" 2>&1)
case "$backup_output" in
  *fixture_password*|*fixture_app_password*|*must-not-leak*)
    printf '%s\n' 'product backup output exposed fixture credentials' >&2
    exit 1 ;;
  *'event media backup completed'*) ;;
  *) printf '%s\n' 'product backup did not report completion' >&2; exit 1 ;;
esac
bundle=$(find "$OFF_HOST_ROOT" -mindepth 1 -maxdepth 1 -type d \
  -name 'event-media-*' -print)
[ -n "$bundle" ] && [ "$(printf '%s\n' "$bundle" | wc -l)" -eq 1 ] || {
  printf '%s\n' 'expected exactly one product backup bundle' >&2
  exit 1
}
sh "$VALIDATE_SCRIPT" "$bundle" >/dev/null

mkdir -p "$TMP/corrupt"
chmod 700 "$TMP/corrupt"
cp "$bundle"/* "$TMP/corrupt/"
printf 'x' >> "$TMP/corrupt/clips.tar"
set +e
corrupt_output=$(sh "$VALIDATE_SCRIPT" "$TMP/corrupt" 2>&1)
corrupt_status=$?
set -e
[ "$corrupt_status" -ne 0 ] || {
  printf '%s\n' 'corrupt clip archive unexpectedly validated' >&2
  exit 1
}
case "$corrupt_output" in
  *'clip archive checksum mismatch'*) ;;
  *) printf '%s\n' 'corrupt clip archive failed for the wrong reason' >&2; exit 1 ;;
esac

docker run -d --name "$TARGET_CONTAINER" \
  -e POSTGRES_USER="$FIXTURE_DB_USER" \
  -e POSTGRES_PASSWORD="$FIXTURE_DB_PASSWORD" \
  -e POSTGRES_DB="$FIXTURE_DB_NAME" \
  -e APP_DB_USER=fall_app \
  -e APP_DB_PASSWORD="$FIXTURE_APP_PASSWORD" \
  --mount "type=bind,src=$INIT_DIR,dst=/docker-entrypoint-initdb.d,readonly" \
  "$HELPER_IMAGE" >/dev/null
wait_for_database "$TARGET_CONTAINER"
[ "$(docker exec "$TARGET_CONTAINER" psql --username "$FIXTURE_DB_USER" \
  --dbname "$FIXTURE_DB_NAME" -Atc "SELECT to_regclass('public.media_clips') IS NULL")" = t ] || {
  printf '%s\n' 'restore target database was not clean' >&2
  exit 1
}
docker run --rm --network none \
  --mount "type=volume,src=$TARGET_VOLUME,dst=/clips,readonly" \
  "$HELPER_IMAGE" sh -ceu '[ -z "$(find /clips -mindepth 1 -print -quit)" ]' || {
  printf '%s\n' 'restore target clip volume was not clean' >&2
  exit 1
}

docker exec -i "$TARGET_CONTAINER" pg_restore --username "$FIXTURE_DB_USER" \
  --dbname "$FIXTURE_DB_NAME" --no-owner --exit-on-error --single-transaction \
  < "$bundle/database.dump"
[ "$(applied_migration_count "$TARGET_CONTAINER")" -eq "$expected_migration_count" ] || {
  printf '%s\n' 'restored target migration history did not match source before rerun' >&2
  exit 1
}
set +e
target_migration_output=$(run_migrate_deploy "$TARGET_CONTAINER" 2>&1)
target_migration_status=$?
target_status_output=$(run_migrate_status "$TARGET_CONTAINER" 2>&1)
target_status_status=$?
set -e
[ "$target_migration_status" -eq 0 ] || {
  sanitized_error "$target_migration_output"
  printf '%s\n' 'restored target migrate deploy failed' >&2
  exit 1
}
[ "$target_status_status" -eq 0 ] || {
  sanitized_error "$target_status_output"
  printf '%s\n' 'restored target migration readiness failed' >&2
  exit 1
}
case "$target_migration_output$target_status_output" in
  *fixture_password*|*fixture_app_password*|*must-not-leak*)
    printf '%s\n' 'target migration output exposed fixture credentials' >&2
    exit 1 ;;
esac
[ "$(applied_migration_count "$TARGET_CONTAINER")" -eq "$expected_migration_count" ] || {
  printf '%s\n' 'restored target migration history is incomplete' >&2
  exit 1
}
[ "$(docker exec "$TARGET_CONTAINER" psql --username "$FIXTURE_DB_USER" \
  --dbname "$FIXTURE_DB_NAME" -Atc 'SELECT 1')" = 1 ] || {
  printf '%s\n' 'restored target database readiness failed' >&2
  exit 1
}

set +e
partial_output=$(verify_restored_media "$TARGET_CONTAINER" "$TARGET_VOLUME" 2>&1)
partial_status=$?
set -e
[ "$partial_status" -ne 0 ] || {
  printf '%s\n' 'database-only partial restore unexpectedly passed' >&2
  exit 1
}
case "$partial_output" in
  *'restored clip file is missing'*) ;;
  *) printf '%s\n' 'partial restore failed for the wrong reason' >&2; exit 1 ;;
esac

docker run --rm --network none \
  --mount "type=bind,src=$bundle,dst=/backup,readonly" \
  --mount "type=volume,src=$TARGET_VOLUME,dst=/clips" \
  "$HELPER_IMAGE" sh -ceu 'tar -C /clips -xf /backup/clips.tar'
verify_restored_media "$TARGET_CONTAINER" "$TARGET_VOLUME"
docker run --rm --network none \
  --mount "type=bind,src=$TMP/fixture,dst=/fixture,readonly" \
  --mount "type=volume,src=$TARGET_VOLUME,dst=/clips,readonly" \
  "$HELPER_IMAGE" cmp -s "/fixture/$STORAGE_KEY" "/clips/$STORAGE_KEY" || {
  printf '%s\n' 'restored clip bytes do not exactly match source' >&2
  exit 1
}
target_tenant_count=$(docker exec -e PGPASSWORD="$FIXTURE_APP_PASSWORD" "$TARGET_CONTAINER" \
  psql -qAt -h 127.0.0.1 --username fall_app --dbname "$FIXTURE_DB_NAME" \
  -c "SET app.facility_id = '$FACILITY_ID'; SELECT count(*) FROM media_clips;")
[ "$target_tenant_count" -eq 1 ] || {
  printf '%s\n' 'restored tenant-scoped app role could not read its media row' >&2
  exit 1
}
target_cross_tenant_count=$(docker exec -e PGPASSWORD="$FIXTURE_APP_PASSWORD" "$TARGET_CONTAINER" \
  psql -qAt -h 127.0.0.1 --username fall_app --dbname "$FIXTURE_DB_NAME" \
  -c "SET app.facility_id = 'restore_facility_b'; SELECT count(*) FROM media_clips;")
[ "$target_cross_tenant_count" -eq 0 ] || {
  printf '%s\n' 'restored tenant-scoped app role crossed the facility boundary' >&2
  exit 1
}

printf 'event media product restore rehearsal passed: migrations=%s rows=4 binding=1 bytes=%s sha256=%s storage_layout=t09 corruption=blocked partial=blocked tenant_rls=isolated migration_rerun=ready\n' \
  "$expected_migration_count" "$expected_clip_bytes" "$expected_clip_sha"
