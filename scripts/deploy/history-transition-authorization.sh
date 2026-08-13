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
TEMP_FILE=''

fail() { printf '%s\n' "$*" >&2; exit 1; }
valid_sha() { [ "${#1}" -eq 40 ] && printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }
cleanup() {
  for file in "$SNAPSHOT" "$TEMP_FILE"; do
    [ -z "$file" ] || [ ! -e "$file" ] || rm -f "$file" || :
  done
}
trap cleanup EXIT HUP INT TERM

render_authorization() {
  candidate_sha=$1
  printf '{"schema":"%s","transition_id":"%s","authorization_id":"%s","legacy_repository":"%s","legacy_sha":"%s","mapped_sha":"%s","shared_migration_tree":"%s","map_sha256":"%s","map_blob":"%s","new_repository":"%s","reviewed_anchor_sha":"%s","reviewed_anchor_migration_tree":"%s","candidate_sha":"%s"}\n' \
    "$TRANSITION_SCHEMA" "$TRANSITION_ID" "$AUTHORIZATION_ID" "$LEGACY_REPOSITORY" "$LEGACY_SHA" \
    "$MAPPED_SHA" "$SHARED_MIGRATION_TREE" "$MAP_SHA256" "$MAP_BLOB" "$NEW_REPOSITORY" \
    "$REVIEWED_ANCHOR_SHA" "$REVIEWED_ANCHOR_MIGRATION_TREE" "$candidate_sha"
}

file_metadata() {
  path=$1
  stat -c '%u:%g:%a:%d:%i:%s' "$path" 2>/dev/null || stat -f '%u:%g:%Lp:%d:%i:%z' "$path"
}

capture_authorization() {
  candidate_sha=$1
  [ ! -e "$CONSUMED_PATH" ] && [ ! -L "$CONSUMED_PATH" ] || fail "History transition authorization was already consumed: $CONSUMED_PATH"
  [ ! -L "$AUTHORIZATION_PATH" ] && [ -f "$AUTHORIZATION_PATH" ] || fail "History transition authorization is a missing, symlinked, or non-regular file: $AUTHORIZATION_PATH"

  before=$(file_metadata "$AUTHORIZATION_PATH") || fail "Unable to inspect history transition authorization: $AUTHORIZATION_PATH"
  owner_mode=$(printf '%s\n' "$before" | awk -F: '{print $1 ":" $2 ":" $3}')
  [ "$owner_mode" = "$AUTHORIZATION_UID:$AUTHORIZATION_GID:$AUTHORIZATION_MODE" ] || fail "History transition authorization must be owned by $AUTHORIZATION_UID:$AUTHORIZATION_GID with mode $AUTHORIZATION_MODE: $AUTHORIZATION_PATH"

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

  TEMP_FILE=$(mktemp "${TMPDIR:-/tmp}/seeon-history-transition-expected.XXXXXX") || fail 'Unable to create expected authorization snapshot.'
  render_authorization "$candidate_sha" > "$TEMP_FILE"
  cmp -s "$TEMP_FILE" "$SNAPSHOT" || fail 'History transition authorization is not the exact canonical candidate-bound contract.'
  rm -f "$TEMP_FILE"
  TEMP_FILE=''
}

require_runtime_tools() {
  for tool in awk cat chmod cmp git grep mktemp mv rm sha256sum stat tail tr wc; do
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
  [ "$current_sha" = "$LEGACY_SHA" ] || fail 'History transition authorization applies only to the exact legacy current SHA.'
  require_runtime_tools
  capture_authorization "$candidate_sha"
  verify_repository_contract "$candidate_sha"
  printf 'TRANSITION_BASELINE_SHA=%s\n' "$REVIEWED_ANCHOR_SHA"
}

consume_authorization() {
  candidate_sha=$1
  valid_sha "$candidate_sha" || fail 'History transition candidate SHA must be exactly 40 lowercase hexadecimal characters.'
  require_runtime_tools
  capture_authorization "$candidate_sha"
  if mv "$AUTHORIZATION_PATH" "$CONSUMED_PATH" 2>/dev/null; then
    if [ -L "$CONSUMED_PATH" ] || [ ! -f "$CONSUMED_PATH" ] || ! cmp -s "$SNAPSHOT" "$CONSUMED_PATH"; then
      fail 'Consumed history transition receipt does not match the authorization.'
    fi
    printf '%s\n' 'History transition authorization atomically renamed to its consumed receipt.'
    return
  fi

  TEMP_FILE=$(mktemp "$RELEASE_DIR/.history-transition-consumed.XXXXXX") || fail 'Unable to create durable consumed receipt.'
  cat "$SNAPSHOT" > "$TEMP_FILE" || fail 'Unable to write durable consumed receipt.'
  chmod "$AUTHORIZATION_MODE" "$TEMP_FILE" || fail 'Unable to restrict durable consumed receipt permissions.'
  mv "$TEMP_FILE" "$CONSUMED_PATH" || fail 'Unable to atomically publish durable consumed receipt.'
  TEMP_FILE=''
  if [ -L "$CONSUMED_PATH" ] || [ ! -f "$CONSUMED_PATH" ] || ! cmp -s "$SNAPSHOT" "$CONSUMED_PATH"; then
    fail 'Durable consumed receipt does not match the authorization.'
  fi
  printf '%s\n' 'History transition authorization retained immutably; durable consumed receipt published.'
}

case "${1:-}" in
  --render)
    [ "$#" -eq 2 ] || fail 'Usage: history-transition-authorization.sh --render <candidate-sha> | --verify <current-sha> <candidate-sha> | --consume <candidate-sha>'
    valid_sha "$2" || fail 'History transition candidate SHA must be exactly 40 lowercase hexadecimal characters.'
    render_authorization "$2" ;;
  --verify)
    [ "$#" -eq 3 ] || fail 'Usage: history-transition-authorization.sh --render <candidate-sha> | --verify <current-sha> <candidate-sha> | --consume <candidate-sha>'
    verify_authorization "$2" "$3" ;;
  --consume)
    [ "$#" -eq 2 ] || fail 'Usage: history-transition-authorization.sh --render <candidate-sha> | --verify <current-sha> <candidate-sha> | --consume <candidate-sha>'
    consume_authorization "$2" ;;
  *) fail 'Usage: history-transition-authorization.sh --render <candidate-sha> | --verify <current-sha> <candidate-sha> | --consume <candidate-sha>' ;;
esac
