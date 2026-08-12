#!/usr/bin/env sh
set -eu
set +x

APP_DIR=${APP_DIR:-/opt/eldercare-fall-ai/repo}
ENV_FILE=${ENV_FILE:-/opt/eldercare-fall-ai/shared/.env}
VOLUME_NAME=repo_clips
CLIP_PATH=/app/backend/clips
COMPOSE_FILES='-f compose.yaml -f compose.prod.yaml'

fail() { printf '%s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail 'docker is required for live event-media volume verification'
[ -d "$APP_DIR" ] || fail "application directory is required: $APP_DIR"
[ -f "$ENV_FILE" ] || fail "production environment file is required: $ENV_FILE"

actual_volume=$(docker volume inspect --format '{{.Name}}' "$VOLUME_NAME" 2>/dev/null) || fail 'exact named volume repo_clips is required'
[ "$actual_volume" = "$VOLUME_NAME" ] || fail 'exact named volume repo_clips is required'

# shellcheck disable=SC2086 # Fixed pair of Compose file arguments.
backend_ids=$(cd "$APP_DIR" && docker compose --env-file "$ENV_FILE" $COMPOSE_FILES ps -q --status running backend) || fail 'unable to identify the running backend'
backend_count=$(printf '%s\n' "$backend_ids" | grep -c . || :)
[ "$backend_count" -eq 1 ] || fail 'exactly one running backend is required for live media verification'
backend_id=$(printf '%s\n' "$backend_ids" | sed -n '1p')

mounts=$(docker inspect --format '{{range .Mounts}}{{printf "%s|%s|%s\n" .Type .Name .Destination}}{{end}}' "$backend_id") || fail 'unable to inspect the running backend mounts'
[ "$(printf '%s\n' "$mounts" | grep -Fxc "volume|$VOLUME_NAME|$CLIP_PATH" || :)" -eq 1 ] || fail 'backend clips mount must be volume repo_clips at /app/backend/clips'

docker exec "$backend_id" sh -c 'test -d /app/backend/clips && test -r /app/backend/clips' >/dev/null 2>&1 || fail 'backend cannot read the repo_clips mount'

printf '%s\n' 'live event-media volume verified: repo_clips'
