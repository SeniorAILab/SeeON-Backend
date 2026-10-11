#!/usr/bin/env sh
# shellcheck disable=SC2016 # Quoted commands expand environment inside containers.
# Production deploy of an already-built release SHA. CI gates quality; this
# script only runs: pre-migration dump -> migrate deploy -> compose up ->
# /health sha == release sha. Rollback = re-run Jenkins with RELEASE_TAG=<older tag>.
set -eu

APP_ROOT=${APP_ROOT:-/opt/eldercare-fall-ai}
APP_DIR=${APP_DIR:-$APP_ROOT/repo}
ENV_FILE=${ENV_FILE:-$APP_ROOT/shared/.env}
BACKUP_DIR=${BACKUP_DIR:-$APP_ROOT/backups/db}
RELEASE_ENV=$APP_ROOT/shared/release-images.env
FEATURE_ENV=${FEATURE_ENV:-$APP_ROOT/shared/event-clips-runtime.env}
LOCK_DIR=$APP_ROOT/shared/deploy.lock
# Tooling comes from this script's directory (Jenkins runs main's copy), while
# compose files and DB init come from the release checkout in APP_DIR.
TOOLS_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
HEALTH_TIMEOUT_SECONDS=${HEALTH_TIMEOUT_SECONDS:-120}
DUMPS_TO_KEEP=5
IMAGES_TO_KEEP=3

log() { printf '+ %s\n' "$*" >&2; }
fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() { fail 'Usage: iwinv-deploy.sh --sha <40-hex sha> | --restore-db <dump> --ack-data-loss'; }
valid_sha() { [ "${#1}" -eq 40 ] && printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }

SHA='' RESTORE_DUMP='' ACK=0 DUMP='' LOCK_HELD=0
case "${1:-}" in
  --sha) [ "$#" -eq 2 ] || usage; SHA=$2; valid_sha "$SHA" || fail 'SHA must be exactly 40 lowercase hexadecimal characters.' ;;
  --restore-db) [ "$#" -eq 3 ] && [ "$3" = --ack-data-loss ] || fail '--restore-db requires <dump> --ack-data-loss.'; RESTORE_DUMP=$2; ACK=1 ;;
  *) usage ;;
esac

[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || fail "Production environment must be a regular non-symbolic file: $ENV_FILE"
case "$(stat -c '%a' "$ENV_FILE")" in 400|600) ;; *) fail 'Production environment permissions must be 400 or 600.' ;; esac
cd "$APP_DIR"
# shellcheck source=scripts/deploy/controlled-compose.sh
. "$TOOLS_DIR/controlled-compose.sh"
# shellcheck source=scripts/deploy/event-clip-runtime-env.sh
. "$TOOLS_DIR/event-clip-runtime-env.sh"
validate_event_clip_runtime_env "$FEATURE_ENV" || fail "Invalid event clip feature override: $FEATURE_ENV"

# Later --env-file wins: the emergency feature override must come last.
compose() {
  if [ -f "$FEATURE_ENV" ]; then
    controlled_compose docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_ENV" --env-file "$FEATURE_ENV" -f compose.yaml -f compose.prod.yaml "$@"
  else
    controlled_compose docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_ENV" -f compose.yaml -f compose.prod.yaml "$@"
  fi
}
sync_app_role() { compose exec -T db sh < backend/prisma/init/02-sync-app-role.sh; }

on_exit() {
  status=$?
  [ "$LOCK_HELD" -eq 0 ] || rmdir "$LOCK_DIR" || printf 'Failed to release deployment lock: %s\n' "$LOCK_DIR" >&2
  if [ "$status" -ne 0 ] && [ -n "$DUMP" ]; then
    printf 'Deploy failed after the pre-migration dump. The database is NOT restored automatically.\n' >&2
    printf 'Rollback code: re-run Jenkins eldercare-fall-ai-cd with RELEASE_TAG=<previous tag>.\n' >&2
    printf 'Restore data only if needed: sh scripts/deploy/iwinv-deploy.sh --restore-db %s --ack-data-loss\n' "$DUMP" >&2
  fi
}
trap on_exit 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$BACKUP_DIR"
mkdir "$LOCK_DIR" 2>/dev/null || fail "Another deployment is already running: $LOCK_DIR"
LOCK_HELD=1

if [ "$ACK" -eq 1 ]; then
  [ -f "$RESTORE_DUMP" ] || fail "Database dump not found: $RESTORE_DUMP"
  # Run the images that were live when the dump was taken, not a failed candidate.
  if [ -f "$RESTORE_DUMP.images.env" ]; then cp "$RESTORE_DUMP.images.env" "$RELEASE_ENV"; chmod 600 "$RELEASE_ENV"; fi
  [ -f "$RELEASE_ENV" ] || fail "No deployed release images recorded: $RELEASE_ENV"
  log "restore runs $(tr '\n' ' ' < "$RELEASE_ENV")"
  log "restore database from $RESTORE_DUMP"
  compose stop api-ingress backend
  compose up -d --wait --wait-timeout 120 db
  compose exec -T db pg_restore --list < "$RESTORE_DUMP" >/dev/null
  sync_app_role
  compose exec -T db sh -c 'pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --clean --if-exists --no-owner --exit-on-error --single-transaction' < "$RESTORE_DUMP"
  # pg_restore recreates events under the init migration's ALTER DEFAULT PRIVILEGES
  # (SELECT,INSERT,UPDATE,DELETE), and the archive carries only additive GRANTs, so
  # the one-time event-SSOT REVOKE (20260626120000_event_ssot) must be re-applied.
  compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "REVOKE ALL ON public.events FROM PUBLIC; REVOKE UPDATE, DELETE ON public.events FROM fall_app; GRANT SELECT, INSERT ON public.events TO fall_app;"'
  authorization=$(compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -Atc "SELECT CASE WHEN (SELECT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication FROM pg_roles WHERE rolname = '\''fall_app'\'') AND has_database_privilege('\''fall_app'\'', current_database(), '\''CONNECT'\'') AND has_schema_privilege('\''fall_app'\'', '\''public'\'', '\''USAGE'\'') AND has_table_privilege('\''fall_app'\'', '\''public.events'\'', '\''SELECT'\'') AND has_table_privilege('\''fall_app'\'', '\''public.events'\'', '\''INSERT'\'') AND NOT has_table_privilege('\''fall_app'\'', '\''public.events'\'', '\''UPDATE'\'') AND NOT has_table_privilege('\''fall_app'\'', '\''public.events'\'', '\''DELETE'\'') AND NOT has_function_privilege('\''public'\'', '\''public.get_event_for_snapshot(text)'\'', '\''EXECUTE'\'') AND has_function_privilege('\''fall_app'\'', '\''public.get_event_for_snapshot(text)'\'', '\''EXECUTE'\'') AND NOT has_function_privilege('\''public'\'', '\''public.set_event_snapshot_key(text,text,text)'\'', '\''EXECUTE'\'') AND has_function_privilege('\''fall_app'\'', '\''public.set_event_snapshot_key(text,text,text)'\'', '\''EXECUTE'\'') THEN '\''ok'\'' ELSE '\''invalid'\'' END;"') || fail 'Post-restore authorization invariant query failed.'
  [ "$authorization" = ok ] || fail "Post-restore authorization invariant failed: $authorization"
  compose up -d --wait --wait-timeout 120 backend api-ingress
  printf 'Database restore complete from %s.\n' "$RESTORE_DUMP"
  exit 0
fi

log "deploy $SHA"
umask 077
dump_path=$BACKUP_DIR/deploy-$(date -u +%Y%m%dT%H%M%SZ)-$SHA.dump
# Remember the images live before this deploy; --restore-db of this dump restarts them.
if [ -f "$RELEASE_ENV" ]; then cp "$RELEASE_ENV" "$dump_path.images.env"; fi
printf 'BACKEND_IMAGE=eldercare-backend:%s\nAPI_INGRESS_IMAGE=eldercare-api-ingress:%s\n' "$SHA" "$SHA" > "$RELEASE_ENV.tmp"
mv "$RELEASE_ENV.tmp" "$RELEASE_ENV"
compose config >/dev/null
docker image inspect "eldercare-backend:$SHA" "eldercare-api-ingress:$SHA" >/dev/null || fail "Release images for $SHA are not built."

# 1. Pre-migration dump: a safety net only, never restored automatically.
compose stop api-ingress backend
compose up -d --wait --wait-timeout 120 db
log "pg_dump -> $dump_path"
compose exec -T db sh -c 'pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -Fc' > "$dump_path.tmp"
compose exec -T db pg_restore --list < "$dump_path.tmp" >/dev/null
mv "$dump_path.tmp" "$dump_path"
DUMP=$dump_path
# Keep the newest deploy-*.dump files; older dumps with other names are never touched.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'deploy-*.dump' | LC_ALL=C sort -r | tail -n +$((DUMPS_TO_KEEP + 1)) | while IFS= read -r old; do
  log "remove old dump $old"; rm -f "$old" "$old.images.env"
done

# 2. Migrations run once from deploy tooling, never on app start.
sync_app_role
compose run --rm --no-deps backend pnpm exec prisma migrate deploy --schema prisma/schema.prisma
compose run --rm --no-deps backend node dist-tools/prisma/seed-super-admin.js

# 3. Start the release and wait for /health to report its SHA.
compose up -d --wait --wait-timeout 120 backend api-ingress
started=$(date -u +%s)
while :; do
  # Each probe is bounded (-T 5); a failed probe never counts, even with matching-looking output.
  body=$(compose exec -T api-ingress wget -q -T 5 -O - http://127.0.0.1:3000/health 2>/dev/null) || body=''
  live=$(printf '%s\n' "$body" | sed -n 's/.*"sha":"\([0-9a-f]*\)".*/\1/p')
  elapsed=$(($(date -u +%s) - started))
  [ "$elapsed" -le "$HEALTH_TIMEOUT_SECONDS" ] || fail "Health did not report $SHA within ${HEALTH_TIMEOUT_SECONDS}s (last sha=${live:-none})."
  [ "$live" != "$SHA" ] || break
  wait_s=$((HEALTH_TIMEOUT_SECONDS - elapsed)); [ "$wait_s" -le 5 ] || wait_s=5
  [ "$wait_s" -gt 0 ] || fail "Health did not report $SHA within ${HEALTH_TIMEOUT_SECONDS}s (last sha=${live:-none})."
  sleep "$wait_s"
done

# 4. Remove release images beyond the newest few; never broad prune.
for repo in eldercare-backend eldercare-api-ingress; do
  docker images --format '{{.Repository}}:{{.Tag}}' "$repo" | grep -Fxv "$repo:$SHA" | tail -n +"$IMAGES_TO_KEEP" | while IFS= read -r image; do
    log "docker image rm $image"; docker image rm "$image" >/dev/null || printf 'WARN: unable to remove %s\n' "$image" >&2
  done
done
DUMP=''
printf 'Deploy complete. sha=%s dump=%s\n' "$SHA" "$dump_path"
