#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
CLASSIFIER=$REPO_ROOT/scripts/deploy/verify-additive-migrations.sh
AUTHORIZER=$REPO_ROOT/scripts/deploy/history-transition-authorization.sh
LEGACY_SHA=450ed6a20959ce3f48cc06fb03afc3da1c25799a
MAPPED_SHA=d71f1b2acc55e21175d1fe8efac467d88c006d20
ANCHOR_SHA=4e23f9ef20b4899a17802905d729a2c12295f8d1
BUILD_38_CANDIDATE=$ANCHOR_SHA
MAP_BLOB=17224325e94a6694763ad7cb66ec8de9f404003a
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
REPO=$TMP/repo
RELEASES=$TMP/releases
BIN=$TMP/bin
mkdir -p "$RELEASES" "$BIN"

assert_contains() { case "$1" in *"$2"*) ;; *) printf 'missing expected output: %s\n%s\n' "$2" "$1" >&2; exit 1 ;; esac; }
assert_failure() { [ "$1" -ne 0 ] || { printf '%s\n' 'command unexpectedly passed' >&2; exit 1; }; }

# Build #38 used a valid pre-extraction current pointer with a candidate from
# the extracted history. The unchanged normal classifier deterministically
# fails because the legacy object is intentionally absent from the new repo.
set +e
build_38_output=$(APP_DIR="$REPO_ROOT" sh "$CLASSIFIER" "$LEGACY_SHA" "$BUILD_38_CANDIDATE" 2>&1)
build_38_status=$?
set -e
assert_failure "$build_38_status"
assert_contains "$build_38_output" 'current release commit is unavailable for migration classification'
printf 'build #38 regression: current=%s candidate=%s exit=%s error=%s\n' \
  "$LEGACY_SHA" "$BUILD_38_CANDIDATE" "$build_38_status" "$build_38_output"

# Work from the reviewed extracted history and create exact candidate commits
# without altering the task worktree.
git clone -q --no-hardlinks "$REPO_ROOT" "$REPO"
git -C "$REPO" remote set-url origin https://github.com/SeniorAILab/SeeON-Backend.git
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config user.name test
git -C "$REPO" checkout -q --detach "$ANCHOR_SHA"
git -C "$REPO" commit -q --allow-empty -m 'v0.1.2 candidate fixture'
CANDIDATE=$(git -C "$REPO" rev-parse HEAD)

# Production is owned by the Jenkins deploy account (1001:1001). The test shim
# preserves real type/mode/device/inode/size while modeling that observed owner.
cat > "$BIN/stat" <<'EOF'
#!/usr/bin/env sh
path=
for argument do path=$argument; done
case "$path" in
  */history-transition-authorization-v1.json)
    if [ -n "${MOCK_AUTH_MODE:-}" ]; then
      mode=$MOCK_AUTH_MODE
    elif [ -w "$path" ]; then
      mode=600
    else
      mode=400
    fi
    owner=${MOCK_AUTH_OWNER:-1001:1001}
    size=$(wc -c < "$path" | awk '{print $1}')
    inode=$(ls -di "$path" | awk '{print $1}')
    printf '%s:%s:1:%s:%s\n' "$owner" "$mode" "$inode" "$size" ;;
  *) exec /usr/bin/stat "$@" ;;
esac
EOF
cat > "$BIN/mv" <<'EOF'
#!/usr/bin/env sh
case "${MOCK_AUTH_RENAME_FAIL:-0}:$1:$2" in
  1:*/history-transition-authorization-v1.json:*/history-transition-authorization-v1.consumed.json) exit 1 ;;
esac
exec /bin/mv "$@"
EOF
chmod +x "$BIN/stat" "$BIN/mv"

AUTH=$RELEASES/history-transition-authorization-v1.json
CONSUMED=$RELEASES/history-transition-authorization-v1.consumed.json
render_auth() { sh "$AUTHORIZER" --render "$1"; }
install_auth() { rm -f "$AUTH" "$CONSUMED"; render_auth "$1" > "$AUTH"; chmod 400 "$AUTH"; }
run_verify() { PATH="$BIN:$PATH" APP_DIR="$REPO" RELEASE_DIR="$RELEASES" sh "$AUTHORIZER" --verify "$@" 2>&1; }
run_consume() { PATH="$BIN:$PATH" APP_DIR="$REPO" RELEASE_DIR="$RELEASES" sh "$AUTHORIZER" --consume "$@" 2>&1; }
assert_verify_rejected() {
  label=$1
  expected=${2:-authorization}
  set +e
  output=$(run_verify "$LEGACY_SHA" "$CANDIDATE"); status=$?
  set -e
  assert_failure "$status"
  assert_contains "$output" "$expected"
  [ ! -e "$CONSUMED" ] || { printf '%s created a consumed receipt\n' "$label" >&2; exit 1; }
}

install_auth "$CANDIDATE"
output=$(run_verify "$LEGACY_SHA" "$CANDIDATE")
[ "$output" = "TRANSITION_BASELINE_SHA=$ANCHOR_SHA" ] || { printf 'invalid transition baseline:\n%s\n' "$output" >&2; exit 1; }
# The unchanged classifier is run only from the reviewed anchor to candidate.
output=$(APP_DIR="$REPO" sh "$CLASSIFIER" "$ANCHOR_SHA" "$CANDIDATE")
assert_contains "$output" 'candidate migrations are additive/non-destructive'

# Every canonical field is exact; mismatches cannot be hidden by valid JSON.
canonical=$(render_auth "$CANDIDATE")
while IFS='|' read -r label original replacement; do
  [ -n "$label" ] || continue
  rm -f "$AUTH"
  printf '%s\n' "$canonical" | sed "s|$original|$replacement|" > "$AUTH"
  chmod 400 "$AUTH"
  assert_verify_rejected "field-$label" 'exact canonical candidate-bound contract'
done <<EOF
schema|"schema":"1"|"schema":"2"
transition-id|seeon-backend-filter-repo-history-v1|seeon-backend-filter-repo-history-v2
authorization-id|seeon-backend-v0.1.2-legacy-history-once|seeon-backend-v0.1.2-other
legacy-repository|SeniorAILab/SeeON|SeniorAILab/Other
legacy-sha|$LEGACY_SHA|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
mapped-sha|$MAPPED_SHA|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
shared-tree|1c388d6bffeb862b8f778d2c2fe4ec44ba63193a|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
map-sha256|e0d31f55fddd59ac35338e70c13f794cddf6feccb5f9d71b4364b2c42a49b73e|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
map-blob|$MAP_BLOB|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
new-repository|SeniorAILab/SeeON-Backend|SeniorAILab/Other-Backend
anchor-sha|$ANCHOR_SHA|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
anchor-tree|ba59e654fd9ddff7833eb079d79dda72ffec7335|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
candidate-sha|$CANDIDATE|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
EOF

# Malformed, extra-field, missing, symlink, permission, and owner cases fail.
rm -f "$AUTH"; printf '{"schema":\n' > "$AUTH"; chmod 400 "$AUTH"
assert_verify_rejected malformed 'exact canonical candidate-bound contract'
rm -f "$AUTH"; printf '%s\n' "$canonical" | sed 's/}$/,"extra":"no"}/' > "$AUTH"; chmod 400 "$AUTH"
assert_verify_rejected extra-field 'exact canonical candidate-bound contract'
rm -f "$AUTH"
assert_verify_rejected missing 'missing, symlinked, or non-regular'
printf '%s\n' "$canonical" > "$TMP/real-auth"; chmod 400 "$TMP/real-auth"; ln -s "$TMP/real-auth" "$AUTH"
assert_verify_rejected symlink 'missing, symlinked, or non-regular'
rm -f "$AUTH"; printf '%s\n' "$canonical" > "$AUTH"; chmod 600 "$AUTH"
assert_verify_rejected unsafe-mode 'owned by 1001:1001 with mode 400'
chmod 400 "$AUTH"
set +e
output=$(MOCK_AUTH_OWNER=0:0 run_verify "$LEGACY_SHA" "$CANDIDATE"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'owned by 1001:1001 with mode 400'

# Current, candidate, remote, tree, map, and ancestry checks all fail closed.
install_auth "$CANDIDATE"
set +e
output=$(run_verify aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$CANDIDATE"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'exact legacy current SHA'
set +e
output=$(run_verify "$LEGACY_SHA" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'exact canonical candidate-bound contract'
git -C "$REPO" remote set-url origin https://github.com/SeniorAILab/Unrelated.git
assert_verify_rejected wrong-repository 'origin repository must be SeniorAILab/SeeON-Backend'
git -C "$REPO" remote set-url origin git@github.com:SeniorAILab/SeeON-Backend.git

REAL_GIT=$(command -v git)
cat > "$BIN/git" <<EOF
#!/usr/bin/env sh
case "\${MOCK_GIT_CASE:-}:\${1:-}:\${3:-}:\${4:-}" in
  mapped-tree:-C:rev-parse:$MAPPED_SHA:backend/prisma/migrations) printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; exit 0 ;;
  anchor-tree:-C:rev-parse:$ANCHOR_SHA:backend/prisma/migrations) printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; exit 0 ;;
  candidate-map:-C:rev-parse:*) case "\${4:-}" in *:docs/provenance/seeon-commit-map.txt) printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; exit 0;; esac ;;
  map-bytes:-C:cat-file:blob) printf '%s\n' 'not the authoritative map'; exit 0 ;;
  mapped-ancestry:-C:merge-base:--is-ancestor) exit 1 ;;
esac
exec '$REAL_GIT' "\$@"
EOF
chmod +x "$BIN/git"
for git_case in mapped-tree anchor-tree candidate-map map-bytes mapped-ancestry; do
  set +e
  output=$(MOCK_GIT_CASE="$git_case" run_verify "$LEGACY_SHA" "$CANDIDATE"); status=$?
  set -e
  assert_failure "$status"
done

# An unrelated candidate is never authorized, even with an exact manifest.
git -C "$REPO" checkout -q --orphan unrelated-history
git -C "$REPO" rm -q -rf .
printf '%s\n' unrelated > "$REPO/unrelated.txt"
git -C "$REPO" add unrelated.txt
git -C "$REPO" commit -qm unrelated
UNRELATED=$(git -C "$REPO" rev-parse HEAD)
install_auth "$UNRELATED"
set +e
output=$(run_verify "$LEGACY_SHA" "$UNRELATED"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'must descend from the reviewed anchor'

# A destructive migration after the anchor reaches the unchanged classifier and
# is blocked; failed deployment preparation leaves authorization retryable.
git -C "$REPO" checkout -q --detach "$ANCHOR_SHA"
mkdir -p "$REPO/backend/prisma/migrations/20990101000000_destructive"
printf '%s\n' 'DROP TABLE events;' > "$REPO/backend/prisma/migrations/20990101000000_destructive/migration.sql"
git -C "$REPO" add .
git -C "$REPO" commit -qm 'v0.1.2 destructive candidate fixture'
DESTRUCTIVE=$(git -C "$REPO" rev-parse HEAD)
install_auth "$DESTRUCTIVE"
output=$(run_verify "$LEGACY_SHA" "$DESTRUCTIVE")
[ "$output" = "TRANSITION_BASELINE_SHA=$ANCHOR_SHA" ]
set +e
output=$(APP_DIR="$REPO" sh "$CLASSIFIER" "$ANCHOR_SHA" "$DESTRUCTIVE" 2>&1); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'candidate migration is not additive/non-destructive'
[ -f "$AUTH" ] && [ ! -e "$CONSUMED" ] || { printf '%s\n' 'classifier failure consumed authorization' >&2; exit 1; }

# Successful activation calls consume: rename is atomic when permitted; when a
# physical rename is unavailable, immutable auth remains and a durable atomic
# consumed receipt makes replay impossible.
install_auth "$CANDIDATE"
output=$(run_consume "$CANDIDATE")
assert_contains "$output" 'atomically renamed'
[ ! -e "$AUTH" ] && [ -f "$CONSUMED" ] || { printf '%s\n' 'physical consumption state is invalid' >&2; exit 1; }
set +e
output=$(run_verify "$LEGACY_SHA" "$CANDIDATE"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'already consumed'

install_auth "$CANDIDATE"
output=$(MOCK_AUTH_RENAME_FAIL=1 run_consume "$CANDIDATE")
assert_contains "$output" 'retained immutably; durable consumed receipt published'
[ -f "$AUTH" ] && [ -f "$CONSUMED" ] || { printf '%s\n' 'fallback consumption state is invalid' >&2; exit 1; }
set +e
output=$(run_verify "$LEGACY_SHA" "$CANDIDATE"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'already consumed'

# Once current changes, even a restored exact authorization is inert.
rm -f "$AUTH" "$CONSUMED"; render_auth "$CANDIDATE" > "$AUTH"; chmod 400 "$AUTH"
set +e
output=$(run_verify "$CANDIDATE" "$CANDIDATE"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'exact legacy current SHA'

printf '%s\n' 'history transition authorization tests passed (v0.1.2 contract)'
