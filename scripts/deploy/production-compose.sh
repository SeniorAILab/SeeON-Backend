#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
APP_DIR=${APP_DIR:-$(pwd)}
APP_ROOT=${APP_ROOT:-/opt/eldercare-fall-ai}
ENV_FILE=$APP_DIR/.env.host.prod
FEATURE_ENV=$APP_ROOT/shared/event-clips-runtime.env

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[ "$#" -gt 0 ] || {
  printf '%s\n' 'Usage: production-compose.sh <compose-command> [arguments...]' >&2
  exit 2
}
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || fail 'normal production environment must be a regular non-symbolic file'
for compose_file in "$APP_DIR/compose.yaml" "$APP_DIR/compose.prod.yaml"; do
  [ -f "$compose_file" ] && [ ! -L "$compose_file" ] || fail 'production Compose files must be regular non-symbolic files'
done

sh "$SCRIPT_DIR/validate-event-clip-env.sh" "$ENV_FILE"
# shellcheck source=scripts/deploy/event-clip-runtime-env.sh
. "$SCRIPT_DIR/event-clip-runtime-env.sh"
validate_event_clip_runtime_env "$FEATURE_ENV" || fail 'invalid event clip emergency override'
# shellcheck source=scripts/deploy/controlled-compose.sh
. "$SCRIPT_DIR/controlled-compose.sh"

if [ -f "$FEATURE_ENV" ]; then
  controlled_compose docker compose --env-file "$ENV_FILE" --env-file "$FEATURE_ENV" \
    --profile full -f "$APP_DIR/compose.yaml" -f "$APP_DIR/compose.prod.yaml" "$@"
else
  controlled_compose docker compose --env-file "$ENV_FILE" \
    --profile full -f "$APP_DIR/compose.yaml" -f "$APP_DIR/compose.prod.yaml" "$@"
fi
