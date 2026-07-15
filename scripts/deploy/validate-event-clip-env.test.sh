#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/validate-event-clip-env.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

write_valid_env() {
  cat > "$1" <<'EOF'
EVENT_CLIPS_ENABLED=false
VITE_EVENT_CLIPS_ENABLED=false
MEDIA_RETENTION_DAYS=60
MEDIA_MIN_FREE_BYTES=1073741824
MEDIA_CLIP_MAX_BYTES=268435456
UNRELATED_SECRET=must-not-leak
EOF
  chmod 600 "$1"
}

assert_failure() {
  [ "$1" -ne 0 ] || {
    printf '%s\n' 'command unexpectedly passed' >&2
    exit 1
  }
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) printf 'missing expected output: %s\n%s\n' "$2" "$1" >&2; exit 1 ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) printf 'unexpected sensitive output: %s\n' "$2" >&2; exit 1 ;;
    *) ;;
  esac
}

# Given a canonical owner-only env, when validated, then both modes succeed.
valid_env=$TMP/valid.env
write_valid_env "$valid_env"
sh "$SCRIPT" "$valid_env"
[ "$(sh "$SCRIPT" "$valid_env" --print-front-flag)" = false ]

# Given 59-day retention, when validated, then release preparation fails closed.
retention_env=$TMP/retention.env
write_valid_env "$retention_env"
sed 's/MEDIA_RETENTION_DAYS=60/MEDIA_RETENTION_DAYS=59/' "$retention_env" > "$retention_env.next"
mv "$retention_env.next" "$retention_env"
chmod 600 "$retention_env"
set +e
output=$(sh "$SCRIPT" "$retention_env" 2>&1); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'MEDIA_RETENTION_DAYS must be an integer of at least 60'
assert_not_contains "$output" 'must-not-leak'

# Given a malformed capacity floor, when validated, then it is rejected.
capacity_env=$TMP/capacity.env
write_valid_env "$capacity_env"
sed 's/MEDIA_MIN_FREE_BYTES=1073741824/MEDIA_MIN_FREE_BYTES=not-a-number/' "$capacity_env" > "$capacity_env.next"
mv "$capacity_env.next" "$capacity_env"
chmod 600 "$capacity_env"
set +e
output=$(sh "$SCRIPT" "$capacity_env" 2>&1); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'MEDIA_MIN_FREE_BYTES must be a positive integer'

# Given a missing required declaration, when validated, then it is rejected.
missing_env=$TMP/missing.env
write_valid_env "$missing_env"
sed '/^MEDIA_CLIP_MAX_BYTES=/d' "$missing_env" > "$missing_env.next"
mv "$missing_env.next" "$missing_env"
chmod 600 "$missing_env"
set +e
output=$(sh "$SCRIPT" "$missing_env" 2>&1); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'MEDIA_CLIP_MAX_BYTES must appear exactly once'

# Given group-readable permissions, when validated, then the env is rejected.
permission_env=$TMP/permission.env
write_valid_env "$permission_env"
chmod 644 "$permission_env"
set +e
output=$(sh "$SCRIPT" "$permission_env" 2>&1); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'production environment file permissions must be 400 or 600'
