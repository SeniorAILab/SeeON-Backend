#!/usr/bin/env sh
# shellcheck disable=SC2016 # Quoted commands expand environment inside containers.
set -eu

APP_ROOT=${APP_ROOT:-/opt/eldercare-fall-ai}
APP_DIR=${APP_DIR:-$APP_ROOT/repo}
ENV_FILE=${ENV_FILE:-$APP_ROOT/shared/.env}
BACKUP_DIR=${BACKUP_DIR:-$APP_ROOT/backups/db}
RELEASE_DIR=${RELEASE_DIR:-$APP_ROOT/releases}
LOCK_DIR=$APP_ROOT/shared/deploy.lock
RELEASE_ENV=$APP_ROOT/shared/release-images.env
COMPOSE_FILES='-f compose.yaml -f compose.prod.yaml'
MEMORY_MIN_MB=${MEMORY_MIN_MB:-1024}
DISK_MIN_MB=${DISK_MIN_MB:-2048}

SHA='' REQUESTED_ROLLBACK_SHA='' DRY_RUN=0 ROLLBACK=0 RESTORE_DUMP='' ACK_DATA_LOSS=0 PREFLIGHT_ONLY=0
SHA_COUNT=0 ROLLBACK_COUNT=0 RESTORE_COUNT=0 ACK_COUNT=0 DRY_RUN_COUNT=0 PREFLIGHT_COUNT=0
LOCK_HELD=0 TEMP_FILE='' TEMP_FILE_SECOND='' BACKEND_IMAGE='' FRONT_IMAGE='' BACKEND_ID='' FRONT_ID='' PRE_DUMP='' HAS_CURRENT=0 PENDING_SHA='' PENDING_DUMP=''

usage() {
  printf '%s\n' 'Usage: iwinv-deploy.sh --sha <sha> [--dry-run] | --rollback [sha] [--restore-db dump --ack-data-loss] [--dry-run] | --restore-db dump --ack-data-loss [--dry-run] | --preflight-only' >&2
  exit 2
}
log() { printf '+ %s\n' "$*" >&2; }
fail() { printf '%s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"; }
valid_sha() { [ "${#1}" -eq 40 ] && printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }
run() { log "$*"; [ "$DRY_RUN" -eq 1 ] || "$@"; }
preflight() {
  memory_mb=$(free -m | awk '/^Mem:/ { mem=$7 } /^Swap:/ { swap=$4 } END { print mem + swap }')
  disk_mb=$(df -Pm "$APP_ROOT" | awk 'NR == 2 { print $4 }')
  case "$memory_mb:$disk_mb" in *[!0-9:]*|:*|*:) fail 'Unable to determine available memory plus swap or disk.';; esac
  log "preflight available_memory_plus_swap_mb=$memory_mb available_disk_mb=$disk_mb"
  [ "$memory_mb" -ge "$MEMORY_MIN_MB" ] || fail "Insufficient available memory plus swap: ${memory_mb}MiB (need ${MEMORY_MIN_MB}MiB)."
  [ "$disk_mb" -ge "$DISK_MIN_MB" ] || fail "Insufficient available disk: ${disk_mb}MiB (need ${DISK_MIN_MB}MiB)."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sha)
      [ "$#" -ge 2 ] && [ "$SHA_COUNT" -eq 0 ] || usage
      SHA=$2; SHA_COUNT=1; shift 2 ;;
    --rollback)
      [ "$ROLLBACK_COUNT" -eq 0 ] || usage
      ROLLBACK=1; ROLLBACK_COUNT=1
      if [ "$#" -ge 2 ] && valid_sha "$2"; then REQUESTED_ROLLBACK_SHA=$2; shift 2; else shift; fi ;;
    --restore-db)
      [ "$#" -ge 2 ] && [ "$RESTORE_COUNT" -eq 0 ] || usage
      RESTORE_DUMP=$2; RESTORE_COUNT=1; shift 2 ;;
    --ack-data-loss)
      [ "$ACK_COUNT" -eq 0 ] || usage
      ACK_DATA_LOSS=1; ACK_COUNT=1; shift ;;
    --dry-run) [ "$DRY_RUN_COUNT" -eq 0 ] || usage; DRY_RUN=1; DRY_RUN_COUNT=1; shift ;;
    --preflight-only) [ "$PREFLIGHT_COUNT" -eq 0 ] || usage; PREFLIGHT_ONLY=1; PREFLIGHT_COUNT=1; shift ;;
    *) usage ;;
  esac
done

if [ "$PREFLIGHT_ONLY" -eq 1 ]; then
  [ "$SHA_COUNT" -eq 0 ] && [ "$ROLLBACK_COUNT" -eq 0 ] && [ "$RESTORE_COUNT" -eq 0 ] && [ "$ACK_COUNT" -eq 0 ] && [ "$DRY_RUN_COUNT" -eq 0 ] || usage
elif [ "$ROLLBACK" -eq 1 ]; then
  [ "$SHA_COUNT" -eq 0 ] || usage
elif [ "$RESTORE_COUNT" -eq 1 ]; then
  [ "$SHA_COUNT" -eq 0 ] || usage
else
  [ "$SHA_COUNT" -eq 1 ] || usage
fi
[ "$PREFLIGHT_ONLY" -eq 1 ] || {
  [ "$RESTORE_COUNT" -eq 0 ] || [ "$ACK_DATA_LOSS" -eq 1 ] || fail '--restore-db requires --ack-data-loss.'
  [ "$RESTORE_COUNT" -eq 1 ] || [ "$ACK_DATA_LOSS" -eq 0 ] || usage
  [ "$SHA_COUNT" -eq 0 ] || valid_sha "$SHA" || fail 'SHA must be exactly 40 lowercase hexadecimal characters.'
  [ -z "$REQUESTED_ROLLBACK_SHA" ] || valid_sha "$REQUESTED_ROLLBACK_SHA" || fail 'Rollback SHA must be exactly 40 lowercase hexadecimal characters.'
}

need free; need df; need awk
if [ "$PREFLIGHT_ONLY" -eq 1 ]; then
  preflight
  exit 0
fi
need docker; need curl; need grep; need sed; need cmp; need sha256sum
need cp; need mv; need rm; need mkdir; need rmdir; need date; need sort; need head; need mktemp
[ -d "$APP_DIR" ] || fail "Missing deployment directory: $APP_DIR"
[ -f "$APP_DIR/compose.yaml" ] || fail "Missing compose.yaml in $APP_DIR"
[ -f "$APP_DIR/compose.prod.yaml" ] || fail "Missing compose.prod.yaml in $APP_DIR"
[ -f "$ENV_FILE" ] || fail "Missing production environment file: $ENV_FILE"
cd "$APP_DIR"

compose() {
  # shellcheck disable=SC2086 # Fixed pair of Compose file arguments.
  if [ -f "$RELEASE_ENV" ]; then
    docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_ENV" $COMPOSE_FILES "$@"
  else
    BACKEND_IMAGE=restore-only FRONT_IMAGE=restore-only docker compose --env-file "$ENV_FILE" $COMPOSE_FILES "$@"
  fi
}
cleanup() {
  status=$?
  cleanup_status=0
  if [ "$LOCK_HELD" -eq 1 ] && ! rmdir "$LOCK_DIR"; then
    log "Failed to release deployment lock: $LOCK_DIR"
    cleanup_status=1
  fi
  for cleanup_file in "$TEMP_FILE" "$TEMP_FILE_SECOND"; do
    if [ -n "$cleanup_file" ] && [ -e "$cleanup_file" ] && ! rm -f "$cleanup_file"; then
      log "Failed to remove temporary file: $cleanup_file"
      cleanup_status=1
    fi
  done
  trap - 0 HUP INT TERM
  if [ "$status" -ne 0 ]; then exit "$status"; fi
  exit "$cleanup_status"
}
acquire_lock() {
  if [ "$DRY_RUN" -eq 1 ]; then log "would acquire deployment lock $LOCK_DIR"; return; fi
  mkdir -p "$APP_ROOT/shared" "$BACKUP_DIR" "$RELEASE_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || fail "Another deployment is already running: $LOCK_DIR"
  LOCK_HELD=1
  trap cleanup 0 HUP INT TERM
}

json_value() { sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" "$1"; }
read_manifest() {
  manifest=$1
  [ -f "$manifest" ] || fail "Release manifest not found: $manifest"
  SHA=$(json_value "$manifest" sha); BACKEND_IMAGE=$(json_value "$manifest" backend_image); FRONT_IMAGE=$(json_value "$manifest" front_image)
  BACKEND_ID=$(json_value "$manifest" backend_image_id); FRONT_ID=$(json_value "$manifest" front_image_id)
  valid_sha "$SHA" || fail "Invalid SHA in manifest: $manifest"
  [ "$BACKEND_IMAGE" = "eldercare-backend:$SHA" ] && [ "$FRONT_IMAGE" = "eldercare-front:$SHA" ] || fail "Invalid image tags in manifest: $manifest"
  [ -n "$BACKEND_ID" ] && [ -n "$FRONT_ID" ] || fail "Missing image IDs in manifest: $manifest"
}
select_manifest() {
  if [ "$ROLLBACK" -eq 1 ]; then
    current_manifest=$RELEASE_DIR/current.json
    [ -f "$current_manifest" ] || fail "Current release manifest not found: $current_manifest"
    read_manifest "$current_manifest"
    current_sha=$SHA
    if [ -n "$REQUESTED_ROLLBACK_SHA" ]; then
      manifest=$RELEASE_DIR/$REQUESTED_ROLLBACK_SHA.json
      read_manifest "$manifest"
      [ "$SHA" = "$REQUESTED_ROLLBACK_SHA" ] || fail "Rollback manifest SHA does not match requested SHA: $manifest"
    else
      read_manifest "$RELEASE_DIR/previous.json"
      selected_sha=$SHA
      read_manifest "$RELEASE_DIR/$selected_sha.json"
      [ "$SHA" = "$selected_sha" ] || fail "Previous pointer does not match immutable manifest: $selected_sha"
    fi
    [ "$SHA" != "$current_sha" ] || fail "Refusing rollback to already-current SHA: $SHA"
  else
    read_manifest "$RELEASE_DIR/current.json"
  fi
}
write_release_env() {
  if [ "$DRY_RUN" -eq 1 ]; then log "would atomically write $RELEASE_ENV with exact image tags"; return; fi
  TEMP_FILE=$RELEASE_ENV.$$.tmp
  umask 077
  printf 'BACKEND_IMAGE=%s\nFRONT_IMAGE=%s\n' "$BACKEND_IMAGE" "$FRONT_IMAGE" > "$TEMP_FILE"
  mv "$TEMP_FILE" "$RELEASE_ENV"
  TEMP_FILE=
}

sync_app_role() { compose exec -T db sh < backend/prisma/init/02-sync-app-role.sh; }
prisma_migration_rows() {
  # A fresh database has no _prisma_migrations relation, and PostgreSQL rejects a
  # single statement that references it even behind a CASE branch at parse time.
  tracked=$(compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -Atc "SELECT to_regclass('\''public._prisma_migrations'\'') IS NOT NULL;"')
  if [ "$tracked" = t ]; then
    compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -Atc "SELECT count(*) FROM public._prisma_migrations;"'
  else
    printf '%s\n' -1
  fi
}
domain_table_rows() { compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema = '\''public'\'' AND table_type = '\''BASE TABLE'\'' AND table_name <> '\''_prisma_migrations'\'';"'; }
assert_prisma_managed() { rows=$(prisma_migration_rows); tables=$(domain_table_rows); [ "$rows" -gt 0 ] || [ "$tables" -eq 0 ] || fail 'Refusing migration: existing domain tables lack Prisma migration tracking.'; }
run_migrations() { log 'docker compose run backend pnpm exec prisma migrate deploy'; compose run --rm --no-deps backend pnpm exec prisma migrate deploy --schema prisma/schema.prisma; }
bootstrap_super_admin() { compose run --rm --no-deps backend node dist-tools/prisma/seed-super-admin.js; }

pending_recovery_path() { printf '%s\n' "$RELEASE_DIR/pending.json"; }
load_pending_recovery() {
  PENDING_SHA=''
  PENDING_DUMP=''
  pending=$(pending_recovery_path)
  [ ! -e "$pending" ] && return
  [ -f "$pending" ] || fail "Pending recovery record is not a regular file: $pending"
  pending_sha=$(json_value "$pending" sha)
  pending_dump=$(json_value "$pending" pre_migration_dump)
  valid_sha "$pending_sha" || fail "Invalid SHA in pending recovery record: $pending"
  case "$pending_dump" in normal-*.dump) case "$pending_dump" in */*) fail "Invalid dump in pending recovery record: $pending";; esac;; *) fail "Invalid dump in pending recovery record: $pending";; esac
  printf '{"sha":"%s","pre_migration_dump":"%s"}\n' "$pending_sha" "$pending_dump" | cmp -s - "$pending" || fail "Malformed pending recovery record: $pending"
  [ -f "$BACKUP_DIR/$pending_dump" ] || fail "Pending recovery record references missing dump: $BACKUP_DIR/$pending_dump"
  PENDING_SHA=$pending_sha
  PENDING_DUMP=$pending_dump
}
publish_pending_recovery() {
  [ -z "$PENDING_SHA" ] || fail "Pending recovery record already exists: $(pending_recovery_path)"
  [ -n "$PRE_DUMP" ] || fail 'Cannot publish pending recovery record without a validated dump.'
  pending=$(pending_recovery_path)
  TEMP_FILE=$RELEASE_DIR/.pending.$$.tmp
  umask 077
  printf '{"sha":"%s","pre_migration_dump":"%s"}\n' "$SHA" "$PRE_DUMP" > "$TEMP_FILE"
  mv "$TEMP_FILE" "$pending"
  TEMP_FILE=
  PENDING_SHA=$SHA
  PENDING_DUMP=$PRE_DUMP
}
clear_pending_recovery() {
  [ -z "$PENDING_SHA" ] && return
  pending=$(pending_recovery_path)
  load_pending_recovery
  [ -n "$PENDING_SHA" ] || fail "Pending recovery record disappeared: $pending"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "would clear pending recovery record $pending"
    return
  fi
  rm -f "$pending" || fail "Unable to clear pending recovery record: $pending"
  PENDING_SHA=''
  PENDING_DUMP=''
}
restore_pending_recovery() {
  pending=$(pending_recovery_path)
  TEMP_FILE=$RELEASE_DIR/.pending-restore.$$.tmp
  umask 077
  printf '{"sha":"%s","pre_migration_dump":"%s"}\n' "$1" "$2" > "$TEMP_FILE"
  mv "$TEMP_FILE" "$pending" || fail "Unable to restore pending recovery record: $pending"
  TEMP_FILE=
  PENDING_SHA=$1
  PENDING_DUMP=$2
}
finalize_success() {
  should_clear_pending=$1
  if [ "$DRY_RUN" -eq 1 ]; then
    [ "$should_clear_pending" -eq 0 ] || clear_pending_recovery
    return
  fi
  final_pending_sha=$PENDING_SHA
  final_pending_dump=$PENDING_DUMP
  if [ "$should_clear_pending" -eq 1 ]; then
    clear_pending_recovery
  fi
  if [ "$LOCK_HELD" -eq 1 ] && ! rmdir "$LOCK_DIR"; then
    if [ -n "$final_pending_sha" ]; then
      restore_pending_recovery "$final_pending_sha" "$final_pending_dump"
    fi
    fail "Failed to release deployment lock: $LOCK_DIR"
  fi
  LOCK_HELD=0
}
protected_dump_names() {
  validate_existing_pointers
  load_pending_recovery
  [ -z "$PENDING_DUMP" ] || printf '%s\n' "$PENDING_DUMP"
  for pointer_manifest in "$RELEASE_DIR/current.json" "$RELEASE_DIR/previous.json"; do
    [ -f "$pointer_manifest" ] || continue
    dump=$(json_value "$pointer_manifest" pre_migration_dump)
    case "$dump" in normal-*.dump) case "$dump" in */*) fail "Invalid pre-migration dump in release manifest: $pointer_manifest";; esac;; *) fail "Invalid pre-migration dump in release manifest: $pointer_manifest";; esac
    [ -f "$BACKUP_DIR/$dump" ] || fail "Release manifest references missing pre-migration dump: $BACKUP_DIR/$dump"
    printf '%s\n' "$dump"
  done
}
rotate_dumps() {
  if [ -e "$BACKUP_DIR/baseline.marker" ]; then
    [ -f "$BACKUP_DIR/baseline.marker" ] || fail "Baseline marker is not a regular file: $BACKUP_DIR/baseline.marker"
    baseline=$(sed -n '1p' "$BACKUP_DIR/baseline.marker") || fail "Unable to read baseline marker: $BACKUP_DIR/baseline.marker"
    case "$baseline" in baseline-*.dump) case "$baseline" in */*) fail "Invalid baseline marker: $BACKUP_DIR/baseline.marker";; esac;; *) fail "Invalid baseline marker: $BACKUP_DIR/baseline.marker";; esac
    [ -f "$BACKUP_DIR/$baseline" ] || fail "Baseline marker references missing dump: $BACKUP_DIR/$baseline"
  fi
  protected=$(protected_dump_names)
  log "dump retention: retain every manifest-referenced dump and newest five unreferenced normal dumps"
  dumps=$(for dump in "$BACKUP_DIR"/normal-*.dump; do [ -f "$dump" ] && printf '%s\n' "$dump"; done | sort)
  removable=''
  for dump in $dumps; do
    name=${dump##*/}
    printf '%s\n' "$protected" | grep -Fx "$name" >/dev/null || removable="${removable}${removable:+
}$dump"
  done
  count=$(printf '%s\n' "$removable" | grep -c . || :)
  if [ "$count" -gt 5 ]; then
    remove=$((count - 5))
    if [ "$DRY_RUN" -eq 1 ]; then printf '%s\n' "$removable" | head -n "$remove" | while IFS= read -r dump; do log "would remove $dump"; done
    else printf '%s\n' "$removable" | head -n "$remove" | while IFS= read -r dump; do rm -f "$dump"; done; fi
  fi
}
backup_and_validate() {
  PRE_DUMP=normal-$(date -u +%Y%m%d-%H%M%S)-$SHA.dump
  dump=$BACKUP_DIR/$PRE_DUMP
  TEMP_FILE=$BACKUP_DIR/.$PRE_DUMP.$$.tmp
  log "docker compose exec db pg_dump -Fc > $TEMP_FILE"
  compose exec -T db sh -c 'pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -Fc' > "$TEMP_FILE"
  compose exec -T db pg_restore --list < "$TEMP_FILE" >/dev/null
  mv "$TEMP_FILE" "$dump"
  TEMP_FILE=
  publish_pending_recovery
  rotate_dumps
}
restore_database() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "would ensure app role, restore database ACLs from $RESTORE_DUMP with pg_restore --dbname \$POSTGRES_DB --clean --if-exists --no-owner --exit-on-error --single-transaction, reconcile the event-SSOT ACL contract, and verify authorization invariants"
    return
  fi
  sync_app_role
  compose exec -T db sh -c 'pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --clean --if-exists --no-owner --exit-on-error --single-transaction' < "$RESTORE_DUMP"
  # pg_restore recreates events under the init migration's ALTER DEFAULT PRIVILEGES
  # (SELECT,INSERT,UPDATE,DELETE), and the archive carries only additive GRANTs, so
  # the one-time event-SSOT REVOKE (20260626120000_event_ssot) must be re-applied.
  compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "REVOKE ALL ON public.events FROM PUBLIC; REVOKE UPDATE, DELETE ON public.events FROM fall_app; GRANT SELECT, INSERT ON public.events TO fall_app;"' >/dev/null
  authorization=$(compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -Atc "SELECT CASE WHEN (SELECT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication FROM pg_roles WHERE rolname = '\''fall_app'\'') AND has_database_privilege('\''fall_app'\'', current_database(), '\''CONNECT'\'') AND has_schema_privilege('\''fall_app'\'', '\''public'\'', '\''USAGE'\'') AND has_table_privilege('\''fall_app'\'', '\''public.events'\'', '\''SELECT'\'') AND has_table_privilege('\''fall_app'\'', '\''public.events'\'', '\''INSERT'\'') AND NOT has_table_privilege('\''fall_app'\'', '\''public.events'\'', '\''UPDATE'\'') AND NOT has_table_privilege('\''fall_app'\'', '\''public.events'\'', '\''DELETE'\'') AND NOT has_function_privilege('\''public'\'', '\''public.get_event_for_snapshot(text)'\'', '\''EXECUTE'\'') AND has_function_privilege('\''fall_app'\'', '\''public.get_event_for_snapshot(text)'\'', '\''EXECUTE'\'') AND NOT has_function_privilege('\''public'\'', '\''public.set_event_snapshot_key(text,text,text)'\'', '\''EXECUTE'\'') AND has_function_privilege('\''fall_app'\'', '\''public.set_event_snapshot_key(text,text,text)'\'', '\''EXECUTE'\'') THEN '\''ok'\'' ELSE '\''invalid'\'' END;"') || fail 'Post-restore authorization invariant query failed.'
  [ "$authorization" = ok ] || fail "Post-restore authorization invariant failed: $authorization"
}
validate_restore_dump() {
  [ -f "$RESTORE_DUMP" ] || fail "Database dump not found: $RESTORE_DUMP"
  log "docker compose exec db pg_restore --list < $RESTORE_DUMP"
  [ "$DRY_RUN" -eq 1 ] || compose exec -T db pg_restore --list < "$RESTORE_DUMP" >/dev/null
}

image_id() { docker image inspect --format '{{.Id}}' "$1"; }
verify_image_ids() {
  actual_backend_id=$(image_id "$BACKEND_IMAGE") || fail "Backend image is unavailable: $BACKEND_IMAGE"
  actual_front_id=$(image_id "$FRONT_IMAGE") || fail "Frontend image is unavailable: $FRONT_IMAGE"
  [ -z "$BACKEND_ID" ] || [ "$actual_backend_id" = "$BACKEND_ID" ] || fail 'Backend image ID differs from manifest.'
  [ -z "$FRONT_ID" ] || [ "$actual_front_id" = "$FRONT_ID" ] || fail 'Frontend image ID differs from manifest.'
  BACKEND_ID=$actual_backend_id; FRONT_ID=$actual_front_id
}
verify_services() {
  backend_output=$(compose exec -T -e EXPECTED_SHA="$SHA" backend node -e 'fetch("http://127.0.0.1:8080/health").then(async r=>{const body=await r.text(); console.log("status="+r.status+"\\nbody="+body); let value; try { value=JSON.parse(body); } catch (_) { process.exit(1); } process.exit(r.ok && value.sha===process.env.EXPECTED_SHA && value.database==="ok" ? 0 : 1);}).catch(error=>{console.log("request_error="+error.message);process.exit(1);})' 2>&1) || { printf 'Backend exact-SHA health verification failed:\n%s\n' "$backend_output" >&2; return 1; }
  headers=$(mktemp "$APP_ROOT/shared/front-headers.XXXXXX") || fail 'Unable to create frontend health header capture.'
  TEMP_FILE=$headers
  body=$(mktemp "$APP_ROOT/shared/front-body.XXXXXX") || fail 'Unable to create frontend health body capture.'
  TEMP_FILE_SECOND=$body
  if ! curl --silent --show-error --dump-header "$headers" --output "$body" http://127.0.0.1:3000/version.txt; then
    printf 'Frontend version request failed; headers:\n' >&2; sed -n '1,120p' "$headers" >&2 || :
    printf 'Frontend version request body:\n' >&2; sed -n '1,120p' "$body" >&2 || :
    return 1
  fi
  http_status=$(sed -n '1s/HTTP\/[^ ]* \([0-9][0-9][0-9]\).*/\1/p' "$headers") || return 1
  version=$(sed -n '1p' "$body") || return 1
  if [ "$http_status" != 200 ] || ! printf '%s\n' "$SHA" | cmp -s - "$body"; then
    printf 'Frontend exact-SHA verification failed (expected HTTP 200 and %s, got HTTP %s and %s); headers:\n' "$SHA" "${http_status:-unreadable}" "$version" >&2
    sed -n '1,120p' "$headers" >&2 || :
    printf 'Frontend version body:\n' >&2; sed -n '1,120p' "$body" >&2 || :
    return 1
  fi
  rm -f "$headers" "$body" || fail 'Failed to remove frontend health diagnostics.'
  TEMP_FILE=
  TEMP_FILE_SECOND=
}

write_immutable_manifest() {
  [ "$DRY_RUN" -eq 1 ] && { log "would atomically write immutable $RELEASE_DIR/$SHA.json"; return; }
  manifest=$RELEASE_DIR/$SHA.json
  [ ! -e "$manifest" ] || fail "Immutable release manifest already exists: $manifest"
  compose_hash=$(sha256sum compose.yaml compose.prod.yaml | sha256sum | awk '{print $1}')
  env_hash=$(sha256sum "$ENV_FILE" | awk '{print $1}')
  TEMP_FILE=$RELEASE_DIR/.$SHA.$$.tmp
  umask 077
  printf '{"sha":"%s","backend_image":"%s","backend_image_id":"%s","front_image":"%s","front_image_id":"%s","compose_sha256":"%s","env_sha256":"%s","pre_migration_dump":"%s","timestamp":"%s"}\n' "$SHA" "$BACKEND_IMAGE" "$BACKEND_ID" "$FRONT_IMAGE" "$FRONT_ID" "$compose_hash" "$env_hash" "$PRE_DUMP" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TEMP_FILE"
  mv "$TEMP_FILE" "$manifest"
  TEMP_FILE=
}
validate_existing_pointers() {
  saved_sha=$SHA
  saved_backend_image=$BACKEND_IMAGE
  saved_front_image=$FRONT_IMAGE
  saved_backend_id=$BACKEND_ID
  saved_front_id=$FRONT_ID
  for pointer_manifest in "$RELEASE_DIR/current.json" "$RELEASE_DIR/previous.json"; do
    [ ! -e "$pointer_manifest" ] || {
      [ -f "$pointer_manifest" ] || fail "Release pointer is not a regular file: $pointer_manifest"
      read_manifest "$pointer_manifest"
      immutable_manifest=$RELEASE_DIR/$SHA.json
      [ -f "$immutable_manifest" ] || fail "Release pointer immutable manifest not found: $immutable_manifest"
      cmp -s "$pointer_manifest" "$immutable_manifest" || fail "Release pointer does not match immutable manifest: $pointer_manifest"
    }
  done
  SHA=$saved_sha
  BACKEND_IMAGE=$saved_backend_image
  FRONT_IMAGE=$saved_front_image
  BACKEND_ID=$saved_backend_id
  FRONT_ID=$saved_front_id
}
activate_manifest() {
  target_manifest=$1
  if [ "$DRY_RUN" -eq 1 ]; then log "would atomically activate $target_manifest as current and retain prior current as previous"; return; fi
  [ -f "$target_manifest" ] || fail "Immutable release manifest not found: $target_manifest"
  validate_existing_pointers
  if [ -f "$RELEASE_DIR/current.json" ]; then
    TEMP_FILE=$RELEASE_DIR/.previous.$$.tmp
    cp "$RELEASE_DIR/current.json" "$TEMP_FILE"
    mv "$TEMP_FILE" "$RELEASE_DIR/previous.json"
    TEMP_FILE=
  fi
  TEMP_FILE=$RELEASE_DIR/.current.$$.tmp
  cp "$target_manifest" "$TEMP_FILE"
  mv "$TEMP_FILE" "$RELEASE_DIR/current.json"
  TEMP_FILE=
}
protected_images() {
  validate_existing_pointers
  printf '%s\n' "$BACKEND_IMAGE" "$FRONT_IMAGE"
  for pointer_manifest in "$RELEASE_DIR/current.json" "$RELEASE_DIR/previous.json"; do
    [ -f "$pointer_manifest" ] || continue
    json_value "$pointer_manifest" backend_image
    json_value "$pointer_manifest" front_image
  done
}
pointer_shas() {
  validate_existing_pointers
  for pointer_manifest in "$RELEASE_DIR/current.json" "$RELEASE_DIR/previous.json"; do
    [ -f "$pointer_manifest" ] || continue
    json_value "$pointer_manifest" sha
  done
}
prune_release_manifests() {
  validate_existing_pointers
  protected_shas=$(pointer_shas)
  for manifest in "$RELEASE_DIR"/*.json; do
    [ -f "$manifest" ] || continue
    case "$manifest" in "$RELEASE_DIR/current.json"|"$RELEASE_DIR/previous.json"|"$RELEASE_DIR/pending.json") continue;; esac
    manifest_sha=${manifest##*/}; manifest_sha=${manifest_sha%.json}
    printf '%s\n' "$protected_shas" | grep -Fx "$manifest_sha" >/dev/null || { log "remove stale immutable manifest $manifest"; [ "$DRY_RUN" -eq 1 ] || rm -f "$manifest" || fail "Unable to remove stale immutable manifest: $manifest"; }
  done
}
prune_images() {
  protected=$(protected_images)
  log "protected image tags: $protected"
  images=$(docker images --format '{{.Repository}}:{{.Tag}}') || fail 'Unable to list Docker images for pruning.'
  while IFS= read -r image; do
    case "$image" in eldercare-backend:*|eldercare-front:*)
      printf '%s\n' "$protected" | grep -Fx "$image" >/dev/null || { log "docker image rm $image"; [ "$DRY_RUN" -eq 1 ] || docker image rm "$image" >/dev/null || fail "Unable to remove stale image: $image"; };;
    esac
  done <<EOF
$images
EOF
}

acquire_lock
validate_existing_pointers
load_pending_recovery
[ -f "$RELEASE_DIR/current.json" ] && HAS_CURRENT=1
if [ "$ROLLBACK" -eq 0 ] && [ "$RESTORE_COUNT" -eq 0 ] && [ -n "$PENDING_SHA" ] && [ "$PENDING_SHA" != "$SHA" ]; then
  fail "Pending recovery record belongs to a different SHA: $PENDING_SHA"
fi

if [ "$ROLLBACK" -eq 1 ]; then
  select_manifest
elif [ "$RESTORE_COUNT" -eq 1 ] && [ "$HAS_CURRENT" -eq 1 ]; then
  select_manifest
elif [ "$RESTORE_COUNT" -eq 0 ]; then
  deploy_sha=$SHA
  if [ "$HAS_CURRENT" -eq 1 ]; then
    read_manifest "$RELEASE_DIR/current.json"
    [ "$deploy_sha" != "$SHA" ] || fail "Refusing deploy of already-current SHA: $deploy_sha"
  fi
  [ ! -e "$RELEASE_DIR/$deploy_sha.json" ] || fail "Immutable release manifest already exists: $RELEASE_DIR/$deploy_sha.json"
  SHA=$deploy_sha
  BACKEND_IMAGE=eldercare-backend:$SHA
  FRONT_IMAGE=eldercare-front:$SHA
  BACKEND_ID=''
  FRONT_ID=''
fi

preflight
if [ "$RESTORE_COUNT" -eq 1 ] && [ "$HAS_CURRENT" -eq 0 ]; then
  run compose config >/dev/null
  run compose pull db
  run compose up -d --wait --wait-timeout 120 db
  validate_restore_dump
  restore_database
  printf 'Database restore complete; no release manifest exists, so application images were not started.\n'
  finalize_success 1
  exit 0
fi

write_release_env
run compose config >/dev/null
if [ "$DRY_RUN" -eq 1 ]; then
  log "would verify exact local images $BACKEND_IMAGE and $FRONT_IMAGE"
else
  verify_image_ids
fi

if [ "$ROLLBACK" -eq 1 ] || [ "$RESTORE_COUNT" -eq 1 ]; then
  run compose stop front backend
  run compose up -d --wait --wait-timeout 120 db
  if [ "$RESTORE_COUNT" -eq 1 ]; then
    validate_restore_dump
    restore_database
  fi
  run compose up -d --wait --wait-timeout 120 backend front
  [ "$DRY_RUN" -eq 1 ] || verify_services
  if [ "$ROLLBACK" -eq 1 ]; then
    activate_manifest "$RELEASE_DIR/$SHA.json"
    prune_release_manifests
  fi
  prune_images
  finalize_success "$RESTORE_COUNT"
  exit 0
fi

if [ "$HAS_CURRENT" -eq 1 ]; then
  run compose stop front backend
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ -n "$PENDING_DUMP" ]; then
      log "would reuse pending validated pre-migration dump $PENDING_DUMP"
      rotate_dumps
    else
      log 'would create and validate pre-migration dump, persist it, and rotate normal dumps'
      rotate_dumps
    fi
  elif [ -n "$PENDING_DUMP" ]; then
    PRE_DUMP=$PENDING_DUMP
    log "reusing pending validated pre-migration dump $PRE_DUMP"
    rotate_dumps
  else
    backup_and_validate
  fi
fi
run compose pull db
run compose up -d --wait --wait-timeout 120 db
if [ "$HAS_CURRENT" -eq 0 ] && [ "$DRY_RUN" -eq 1 ]; then
  if [ -n "$PENDING_DUMP" ]; then
    log "would reuse pending validated pre-migration dump $PENDING_DUMP"
    rotate_dumps
  else
    log 'would create and validate pre-migration dump, persist it, and rotate normal dumps'
    rotate_dumps
  fi
elif [ "$HAS_CURRENT" -eq 0 ] && [ -n "$PENDING_DUMP" ]; then
  PRE_DUMP=$PENDING_DUMP
  log "reusing pending validated pre-migration dump $PRE_DUMP"
  rotate_dumps
elif [ "$HAS_CURRENT" -eq 0 ]; then
  backup_and_validate
fi
if [ "$DRY_RUN" -eq 1 ]; then
  log 'would sync app role, assert Prisma tracking, run migrate deploy, and bootstrap super-admin'
else
  sync_app_role
  assert_prisma_managed
  run_migrations
  bootstrap_super_admin
fi
run compose up -d --wait --wait-timeout 120 backend front
[ "$DRY_RUN" -eq 1 ] || verify_services
write_immutable_manifest
activate_manifest "$RELEASE_DIR/$SHA.json"
prune_release_manifests
prune_images
printf 'Deploy complete. sha=%s\n' "$SHA"
finalize_success 1