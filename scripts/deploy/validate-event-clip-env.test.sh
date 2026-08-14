#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/validate-event-clip-env.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

write_valid_env() {
  cat > "$1" <<'EOF'
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

# Given a canonical owner-only env, when validated, then it succeeds.
valid_env=$TMP/valid.env
write_valid_env "$valid_env"
sh "$SCRIPT" "$valid_env"

# Every Docker Compose dotenv declaration form for the retired normal-operation
# key is rejected, regardless of value or quoting. Comments remain comments.
assert_forbidden_feature_declaration() {
  name=$1
  declaration=$2
  feature_env=$TMP/feature-$name.env
  write_valid_env "$feature_env"
  printf '%s\n' "$declaration" >> "$feature_env"
  set +e
  output=$(sh "$SCRIPT" "$feature_env" 2>&1); status=$?
  set -e
  assert_failure "$status"
  assert_contains "$output" 'EVENT_CLIPS_ENABLED must not appear in the production environment'
}

tab=$(printf '\t')
assert_forbidden_feature_declaration exact 'EVENT_CLIPS_ENABLED=false'
assert_forbidden_feature_declaration export 'export EVENT_CLIPS_ENABLED=false'
assert_forbidden_feature_declaration leading-space '  EVENT_CLIPS_ENABLED=true'
assert_forbidden_feature_declaration spaced-equals 'EVENT_CLIPS_ENABLED = any-value'
assert_forbidden_feature_declaration tabs "${tab}export${tab}EVENT_CLIPS_ENABLED${tab}=${tab}\"false\""
assert_forbidden_feature_declaration quoted "EVENT_CLIPS_ENABLED='false'"

duplicate_env=$TMP/feature-duplicates.env
write_valid_env "$duplicate_env"
printf '%s\n' ' export EVENT_CLIPS_ENABLED = "false"' 'EVENT_CLIPS_ENABLED=true' >> "$duplicate_env"
set +e
output=$(sh "$SCRIPT" "$duplicate_env" 2>&1); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'EVENT_CLIPS_ENABLED must not appear in the production environment'

comment_env=$TMP/feature-comment.env
write_valid_env "$comment_env"
printf '%s\n' '  # export EVENT_CLIPS_ENABLED = false' '#EVENT_CLIPS_ENABLED=true' >> "$comment_env"
sh "$SCRIPT" "$comment_env"

# An unreadable declaration source and an inspection-producer failure both fail
# closed rather than being interpreted as an absent feature declaration.
unreadable_env=$TMP/unreadable.env
write_valid_env "$unreadable_env"
chmod 000 "$unreadable_env"
set +e
output=$(sh "$SCRIPT" "$unreadable_env" 2>&1); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'production environment file permissions must be 400 or 600'

mkdir "$TMP/failing-bin"
cat > "$TMP/failing-bin/awk" <<'EOF'
#!/usr/bin/env sh
exit 73
EOF
chmod +x "$TMP/failing-bin/awk"
set +e
output=$(PATH="$TMP/failing-bin:$PATH" sh "$SCRIPT" "$valid_env" 2>&1); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'unable to inspect production environment keys'

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

# Given a backend limit above the route-scoped nginx ceiling, when validated,
# then production configuration is rejected before an oversized upload ships.
oversized_env=$TMP/oversized.env
write_valid_env "$oversized_env"
sed 's/MEDIA_CLIP_MAX_BYTES=268435456/MEDIA_CLIP_MAX_BYTES=268435457/' "$oversized_env" > "$oversized_env.next"
mv "$oversized_env.next" "$oversized_env"
chmod 600 "$oversized_env"
set +e
output=$(sh "$SCRIPT" "$oversized_env" 2>&1); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'MEDIA_CLIP_MAX_BYTES must not exceed 268435456'

# Given group-readable permissions, when validated, then the env is rejected.
permission_env=$TMP/permission.env
write_valid_env "$permission_env"
chmod 644 "$permission_env"
set +e
output=$(sh "$SCRIPT" "$permission_env" 2>&1); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'production environment file permissions must be 400 or 600'
