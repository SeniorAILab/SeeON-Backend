#!/usr/bin/env sh
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

usage() {
  printf '%s\n' 'Usage: validate-event-clip-env.sh <production-env-file> [--print-front-flag]' >&2
  exit 2
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
ENV_FILE=$1
MODE=${2:-}
[ -z "$MODE" ] || [ "$MODE" = --print-front-flag ] || usage
[ -f "$ENV_FILE" ] || fail 'production environment file must be a regular file'

permissions=$(stat -c '%a' "$ENV_FILE") || fail 'unable to inspect production environment file permissions'
case "$permissions" in
  400|600) ;;
  *) fail 'production environment file permissions must be 400 or 600' ;;
esac

env_value() {
  key=$1
  value=$(awk -v key="$key" '
    index($0, key "=") == 1 {
      count += 1
      value = substr($0, length(key) + 2)
    }
    END {
      if (count != 1) exit 2
      print value
    }
  ' "$ENV_FILE") || fail "$key must appear exactly once"
  printf '%s\n' "$value"
}

positive_integer() {
  name=$1
  value=$2
  case "$value" in
    ''|*[!0-9]*) fail "$name must be a positive integer" ;;
  esac
  [ "$value" -gt 0 ] 2>/dev/null || fail "$name must be a positive integer"
}

boolean_value() {
  name=$1
  value=$2
  case "$value" in
    true|false) ;;
    *) fail "$name must be true or false" ;;
  esac
}

event_clips_enabled=$(env_value EVENT_CLIPS_ENABLED)
front_event_clips_enabled=$(env_value VITE_EVENT_CLIPS_ENABLED)
retention_days=$(env_value MEDIA_RETENTION_DAYS)
minimum_free_bytes=$(env_value MEDIA_MIN_FREE_BYTES)
maximum_clip_bytes=$(env_value MEDIA_CLIP_MAX_BYTES)

boolean_value EVENT_CLIPS_ENABLED "$event_clips_enabled"
boolean_value VITE_EVENT_CLIPS_ENABLED "$front_event_clips_enabled"
[ "$event_clips_enabled" = "$front_event_clips_enabled" ] || {
  fail 'EVENT_CLIPS_ENABLED and VITE_EVENT_CLIPS_ENABLED must match'
}
positive_integer MEDIA_RETENTION_DAYS "$retention_days"
[ "$retention_days" -ge 60 ] || fail 'MEDIA_RETENTION_DAYS must be an integer of at least 60'
positive_integer MEDIA_MIN_FREE_BYTES "$minimum_free_bytes"
positive_integer MEDIA_CLIP_MAX_BYTES "$maximum_clip_bytes"
[ "$maximum_clip_bytes" -le 268435456 ] || {
  fail 'MEDIA_CLIP_MAX_BYTES must not exceed 268435456'
}
[ "$minimum_free_bytes" -ge "$maximum_clip_bytes" ] || {
  fail 'MEDIA_MIN_FREE_BYTES must cover at least one maximum-sized clip'
}

if [ "$MODE" = --print-front-flag ]; then
  printf '%s\n' "$front_event_clips_enabled"
fi
