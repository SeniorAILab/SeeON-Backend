#!/usr/bin/env sh
set -eu
set +x

APP_DIR=${APP_DIR:-/opt/eldercare-fall-ai/repo}
RELEASE_DIR=${RELEASE_DIR:-/opt/eldercare-fall-ai/releases}
AUTHORIZATION_PATH=$RELEASE_DIR/history-transition-authorization-v1.json
CONSUMED_PATH=$RELEASE_DIR/history-transition-authorization-v1.consumed.json

TRANSITION_SCHEMA=1
TRANSITION_ID=seeon-backend-filter-repo-history-v1
AUTHORIZATION_ID=seeon-backend-v0.1.2-legacy-history-once
LEGACY_REPOSITORY=SeniorAILab/SeeON
LEGACY_SHA=450ed6a20959ce3f48cc06fb03afc3da1c25799a
MAPPED_SHA=d71f1b2acc55e21175d1fe8efac467d88c006d20
SHARED_MIGRATION_TREE=1c388d6bffeb862b8f778d2c2fe4ec44ba63193a
MAP_SHA256=e0d31f55fddd59ac35338e70c13f794cddf6feccb5f9d71b4364b2c42a49b73e
MAP_BLOB=17224325e94a6694763ad7cb66ec8de9f404003a
NEW_REPOSITORY=SeniorAILab/SeeON-Backend
REVIEWED_ANCHOR_SHA=4e23f9ef20b4899a17802905d729a2c12295f8d1
REVIEWED_ANCHOR_MIGRATION_TREE=ba59e654fd9ddff7833eb079d79dda72ffec7335
AUTHORIZATION_UID=1001
AUTHORIZATION_GID=1001
AUTHORIZATION_MODE=400
MAP_PATH=docs/provenance/seeon-commit-map.txt
MIGRATION_PATH=backend/prisma/migrations
SNAPSHOT=''
EXPECTED_FILE=''
TEMP_FILE=''
CLEANED_UP=0

fail() { printf '%s\n' "$*" >&2; exit 1; }
valid_sha() { [ "${#1}" -eq 40 ] && printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }
valid_candidate_sha() { valid_sha "$1" && [ "$1" != "$REVIEWED_ANCHOR_SHA" ]; }
cleanup_files() {
  [ "$CLEANED_UP" -eq 0 ] || return 0
  CLEANED_UP=1
  for file in "$SNAPSHOT" "$EXPECTED_FILE" "$TEMP_FILE"; do
    [ -z "$file" ] || [ ! -e "$file" ] || rm -f "$file" || :
  done
}
exit_cleanup() {
  status=$?
  cleanup_files
  trap - EXIT HUP INT TERM
  exit "$status"
}
signal_cleanup() {
  status=$1
  cleanup_files
  trap - EXIT HUP INT TERM
  exit "$status"
}
trap exit_cleanup EXIT
trap 'signal_cleanup 129' HUP
trap 'signal_cleanup 130' INT
trap 'signal_cleanup 143' TERM

render_authorization() {
  candidate_sha=$1
  printf '{"schema":"%s","transition_id":"%s","authorization_id":"%s","legacy_repository":"%s","legacy_sha":"%s","mapped_sha":"%s","shared_migration_tree":"%s","map_sha256":"%s","map_blob":"%s","new_repository":"%s","reviewed_anchor_sha":"%s","reviewed_anchor_migration_tree":"%s","candidate_sha":"%s"}\n' \
    "$TRANSITION_SCHEMA" "$TRANSITION_ID" "$AUTHORIZATION_ID" "$LEGACY_REPOSITORY" "$LEGACY_SHA" \
    "$MAPPED_SHA" "$SHARED_MIGRATION_TREE" "$MAP_SHA256" "$MAP_BLOB" "$NEW_REPOSITORY" \
    "$REVIEWED_ANCHOR_SHA" "$REVIEWED_ANCHOR_MIGRATION_TREE" "$candidate_sha"
}

render_consumed_receipt() {
  candidate_sha=$1
  authorization_sha=$2
  activation_sha=$3
  printf '{"schema":"1","transition_id":"%s","authorization_id":"%s","legacy_sha":"%s","current_sha":"%s","candidate_sha":"%s","authorization_sha256":"%s","activation_manifest_sha256":"%s"}\n' \
    "$TRANSITION_ID" "$AUTHORIZATION_ID" "$LEGACY_SHA" "$LEGACY_SHA" "$candidate_sha" "$authorization_sha" "$activation_sha"
}

file_metadata() {
  path=$1
  stat -c '%u:%g:%a:%d:%i:%s' "$path" 2>/dev/null || stat -f '%u:%g:%Lp:%d:%i:%z' "$path"
}
owner_mode_is_exact() {
  path=$1
  label=$2
  metadata=$(file_metadata "$path") || fail "Unable to inspect $label: $path"
  owner_mode=$(printf '%s\n' "$metadata" | awk -F: '{print $1 ":" $2 ":" $3}')
  [ "$owner_mode" = "$AUTHORIZATION_UID:$AUTHORIZATION_GID:$AUTHORIZATION_MODE" ] || fail "$label must be owned by $AUTHORIZATION_UID:$AUTHORIZATION_GID with mode $AUTHORIZATION_MODE: $path"
}
hash_file() {
  path=$1
  digest=$(sha256sum "$path" | awk 'NR == 1 {print $1}') || fail "Unable to hash file: $path"
  printf '%s\n' "$digest" | grep -Eq '^[0-9a-f]{64}$' || fail "Invalid SHA-256 result for file: $path"
  printf '%s\n' "$digest"
}

capture_authorization() {
  candidate_sha=$1
  [ ! -L "$AUTHORIZATION_PATH" ] && [ -f "$AUTHORIZATION_PATH" ] || fail "History transition authorization is a missing, symlinked, or non-regular file: $AUTHORIZATION_PATH"
  owner_mode_is_exact "$AUTHORIZATION_PATH" 'History transition authorization'

  before=$(file_metadata "$AUTHORIZATION_PATH") || fail "Unable to inspect history transition authorization: $AUTHORIZATION_PATH"
  SNAPSHOT=$(mktemp "${TMPDIR:-/tmp}/seeon-history-transition.XXXXXX") || fail 'Unable to create history transition authorization snapshot.'
  cat "$AUTHORIZATION_PATH" > "$SNAPSHOT" || fail 'Unable to snapshot history transition authorization.'
  after=$(file_metadata "$AUTHORIZATION_PATH") || fail "Unable to re-inspect history transition authorization: $AUTHORIZATION_PATH"
  if [ "$before" != "$after" ] || ! cmp -s "$AUTHORIZATION_PATH" "$SNAPSHOT"; then
    fail 'History transition authorization changed while it was being validated.'
  fi

  size=$(wc -c < "$SNAPSHOT" | awk '{print $1}')
  case "$size" in ''|*[!0-9]*) fail 'Unable to determine history transition authorization size.' ;; esac
  [ "$size" -le 2048 ] && [ "$size" -gt 0 ] || fail 'History transition authorization size is invalid.'
  allowed_size=$(LC_ALL=C tr -cd '\40-\176\n' < "$SNAPSHOT" | wc -c | awk '{print $1}')
  [ "$allowed_size" = "$size" ] || fail 'History transition authorization byte alphabet is invalid.'
  newline_count=$(LC_ALL=C tr -cd '\n' < "$SNAPSHOT" | wc -c | awk '{print $1}')
  [ "$newline_count" = 1 ] || fail 'History transition authorization newline contract is invalid.'
  final_newline_count=$(tail -c 1 "$SNAPSHOT" | LC_ALL=C tr -cd '\n' | wc -c | awk '{print $1}')
  [ "$final_newline_count" = 1 ] || fail 'History transition authorization newline contract is invalid.'

  EXPECTED_FILE=$(mktemp "${TMPDIR:-/tmp}/seeon-history-transition-expected.XXXXXX") || fail 'Unable to create expected authorization snapshot.'
  render_authorization "$candidate_sha" > "$EXPECTED_FILE"
  cmp -s "$EXPECTED_FILE" "$SNAPSHOT" || fail 'History transition authorization is not the exact canonical candidate-bound contract.'
  rm -f "$EXPECTED_FILE"
  EXPECTED_FILE=''
}

require_runtime_tools() {
  for tool in awk cat chmod cmp git grep mktemp mv rm sed sha256sum stat sync tail tr wc; do
    command -v "$tool" >/dev/null 2>&1 || fail "Required history transition tool is missing: $tool"
  done
}

canonical_remote_repository() {
  remote_url=$1
  case "$remote_url" in
    https://github.com/*) repository=${remote_url#https://github.com/} ;;
    git@github.com:*) repository=${remote_url#git@github.com:} ;;
    ssh://git@github.com/*) repository=${remote_url#ssh://git@github.com/} ;;
    *) return 1 ;;
  esac
  repository=${repository%.git}
  [ -n "$repository" ] && printf '%s\n' "$repository"
}

verify_repository_contract() {
  candidate_sha=$1
  git -C "$APP_DIR" rev-parse --git-dir >/dev/null 2>&1 || fail 'Application Git repository is required for history transition authorization.'
  remote_url=$(git -C "$APP_DIR" remote get-url origin 2>/dev/null) || fail 'Application origin remote is required for history transition authorization.'
  repository=$(canonical_remote_repository "$remote_url") || fail 'Application origin remote is not a canonical supported GitHub URL.'
  [ "$repository" = "$NEW_REPOSITORY" ] || fail "Application origin repository must be $NEW_REPOSITORY."

  for commit in "$MAPPED_SHA" "$REVIEWED_ANCHOR_SHA" "$candidate_sha"; do
    git -C "$APP_DIR" cat-file -e "$commit^{commit}" 2>/dev/null || fail "Required history transition commit is unavailable: $commit"
  done
  mapped_tree=$(git -C "$APP_DIR" rev-parse "$MAPPED_SHA:$MIGRATION_PATH" 2>/dev/null) || fail 'Unable to resolve mapped migration tree.'
  [ "$mapped_tree" = "$SHARED_MIGRATION_TREE" ] || fail 'Mapped migration tree does not match the separately audited shared tree.'
  anchor_tree=$(git -C "$APP_DIR" rev-parse "$REVIEWED_ANCHOR_SHA:$MIGRATION_PATH" 2>/dev/null) || fail 'Unable to resolve reviewed anchor migration tree.'
  [ "$anchor_tree" = "$REVIEWED_ANCHOR_MIGRATION_TREE" ] || fail 'Reviewed anchor migration tree does not match the pinned tree.'
  git -C "$APP_DIR" merge-base --is-ancestor "$MAPPED_SHA" "$REVIEWED_ANCHOR_SHA" || fail 'Mapped commit must be an ancestor of the reviewed anchor.'
  git -C "$APP_DIR" merge-base --is-ancestor "$REVIEWED_ANCHOR_SHA" "$candidate_sha" || fail 'Release candidate must descend from the reviewed anchor.'

  candidate_map_blob=$(git -C "$APP_DIR" rev-parse "$candidate_sha:$MAP_PATH" 2>/dev/null) || fail 'Release candidate does not contain the authoritative commit map.'
  [ "$candidate_map_blob" = "$MAP_BLOB" ] || fail 'Release candidate commit map blob does not match the pinned authoritative map.'
  [ "$(git -C "$APP_DIR" cat-file -t "$MAP_BLOB" 2>/dev/null)" = blob ] || fail 'Pinned authoritative commit map blob is unavailable.'
  actual_map_sha=$(git -C "$APP_DIR" cat-file blob "$MAP_BLOB" | sha256sum | awk '{print $1}') || fail 'Unable to hash the authoritative commit map blob.'
  [ "$actual_map_sha" = "$MAP_SHA256" ] || fail 'Authoritative commit map SHA-256 does not match the pinned digest.'
  mapping_count=$(git -C "$APP_DIR" cat-file blob "$MAP_BLOB" | grep -Fxc "$LEGACY_SHA $MAPPED_SHA" || :)
  [ "$mapping_count" = 1 ] || fail 'Authoritative commit map does not contain the exact legacy-to-mapped transition once.'
}

verify_authorization() {
  current_sha=$1
  candidate_sha=$2
  if ! valid_sha "$current_sha" || ! valid_sha "$candidate_sha"; then
    fail 'History transition SHAs must be exactly 40 lowercase hexadecimal characters.'
  fi
  [ "$candidate_sha" != "$REVIEWED_ANCHOR_SHA" ] || fail 'History transition candidate must be a strict descendant of the reviewed v0.1.1 anchor.'
  [ "$current_sha" = "$LEGACY_SHA" ] || fail 'History transition authorization applies only to the exact legacy current SHA.'
  [ ! -e "$CONSUMED_PATH" ] && [ ! -L "$CONSUMED_PATH" ] || fail "History transition authorization was already consumed: $CONSUMED_PATH"
  require_runtime_tools
  capture_authorization "$candidate_sha"
  verify_repository_contract "$candidate_sha"
  printf 'TRANSITION_BASELINE_SHA=%s\n' "$REVIEWED_ANCHOR_SHA"
}

validate_activation() {
  candidate_sha=$1
  activation_manifest=$2
  current_manifest=$3
  for manifest in "$activation_manifest" "$current_manifest"; do
    [ ! -L "$manifest" ] && [ -f "$manifest" ] || fail "History transition activation manifest is a missing, symlinked, or non-regular file: $manifest"
  done
  cmp -s "$activation_manifest" "$current_manifest" || fail 'Current pointer does not match the activated immutable history transition manifest.'
  activated_sha=$(sed -n 's/^.*"sha":"\([0-9a-f]*\)".*$/\1/p' "$activation_manifest")
  [ "$activated_sha" = "$candidate_sha" ] || fail 'Activated history transition manifest does not match the exact candidate SHA.'
}

validate_existing_receipt() {
  [ ! -L "$CONSUMED_PATH" ] && [ -f "$CONSUMED_PATH" ] || fail "Consumed history transition receipt is not a regular file: $CONSUMED_PATH"
  owner_mode_is_exact "$CONSUMED_PATH" 'Consumed history transition receipt'
  cmp -s "$EXPECTED_FILE" "$CONSUMED_PATH" || fail 'Consumed history transition receipt does not match the exact activated transition.'
  sync -f "$CONSUMED_PATH" || fail 'Unable to fsync consumed history transition receipt.'
  sync -f "$RELEASE_DIR" || fail 'Unable to fsync history transition release-state directory.'
}

finalize_consumption() {
  current_sha=$1
  candidate_sha=$2
  activation_manifest=$3
  current_manifest=$4
  if ! valid_sha "$current_sha" || ! valid_sha "$candidate_sha"; then
    fail 'History transition finalization SHAs must be exactly 40 lowercase hexadecimal characters.'
  fi
  [ "$candidate_sha" != "$REVIEWED_ANCHOR_SHA" ] || fail 'History transition candidate must be a strict descendant of the reviewed v0.1.1 anchor.'
  [ "$current_sha" = "$LEGACY_SHA" ] || fail 'History transition finalization requires the exact legacy current SHA.'
  require_runtime_tools
  capture_authorization "$candidate_sha"
  validate_activation "$candidate_sha" "$activation_manifest" "$current_manifest"
  authorization_sha=$(hash_file "$SNAPSHOT")
  activation_sha=$(hash_file "$activation_manifest")
  EXPECTED_FILE=$(mktemp "${TMPDIR:-/tmp}/seeon-history-transition-receipt.XXXXXX") || fail 'Unable to create expected consumed receipt.'
  render_consumed_receipt "$candidate_sha" "$authorization_sha" "$activation_sha" > "$EXPECTED_FILE"

  if [ -e "$CONSUMED_PATH" ] || [ -L "$CONSUMED_PATH" ]; then
    validate_existing_receipt
    printf '%s\n' 'History transition consumption receipt is durable and exact.'
    return
  fi

  TEMP_FILE=$(mktemp "$RELEASE_DIR/.history-transition-consumed.XXXXXX") || fail 'Unable to create consumed history transition receipt temp file.'
  cat "$EXPECTED_FILE" > "$TEMP_FILE" || fail 'Unable to write consumed history transition receipt.'
  chmod "$AUTHORIZATION_MODE" "$TEMP_FILE" || fail 'Unable to restrict consumed history transition receipt permissions.'
  sync -f "$activation_manifest" || fail 'Unable to fsync activated immutable history transition manifest.'
  sync -f "$current_manifest" || fail 'Unable to fsync activated history transition current pointer.'
  sync -f "$TEMP_FILE" || fail 'Unable to fsync consumed history transition receipt temp file.'
  mv "$TEMP_FILE" "$CONSUMED_PATH" || fail 'Unable to atomically publish consumed history transition receipt.'
  TEMP_FILE=''
  owner_mode_is_exact "$CONSUMED_PATH" 'Consumed history transition receipt'
  cmp -s "$EXPECTED_FILE" "$CONSUMED_PATH" || fail 'Published consumed history transition receipt does not match the exact activated transition.'
  sync -f "$RELEASE_DIR" || fail 'Unable to fsync history transition release-state directory.'
  printf '%s\n' 'History transition consumption receipt atomically published and fsynced.'
}

usage='Usage: history-transition-authorization.sh --render <candidate-sha> | --verify <current-sha> <candidate-sha> | --finalize <legacy-current-sha> <candidate-sha> <activation-manifest> <current-manifest>'
case "${1:-}" in
  --render)
    [ "$#" -eq 2 ] || fail "$usage"
    valid_candidate_sha "$2" || fail 'History transition candidate must be a 40-character SHA strictly after the reviewed v0.1.1 anchor.'
    render_authorization "$2" ;;
  --verify)
    [ "$#" -eq 3 ] || fail "$usage"
    verify_authorization "$2" "$3" ;;
  --finalize)
    [ "$#" -eq 5 ] || fail "$usage"
    finalize_consumption "$2" "$3" "$4" "$5" ;;
  *) fail "$usage" ;;
esac
