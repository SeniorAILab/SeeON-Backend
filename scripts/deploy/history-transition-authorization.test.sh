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

# v0.1.1 is an audit baseline, never a deployable transition candidate.
set +e
output=$(sh "$AUTHORIZER" --render "$ANCHOR_SHA" 2>&1); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'strictly after the reviewed v0.1.1 anchor'

# Production is owned by the Jenkins deploy account (1001:1001). The test shim
# preserves real type/mode/device/inode/size while modeling that observed owner.
cat > "$BIN/stat" <<'EOF'
#!/usr/bin/env sh
path=
for argument do path=$argument; done
case "$path" in
  */history-transition-authorization-v1.json|*/history-transition-authorization-v1.consumed.json)
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
case "${MOCK_FINALIZE_FAILURE:-}:$2" in
  rename:*/history-transition-authorization-v1.consumed.json) exit 1 ;;
esac
exec /bin/mv "$@"
EOF
cat > "$BIN/mktemp" <<'EOF'
#!/usr/bin/env sh
case "${SIGNAL_POINT:-}:$*" in
  verify-int:*seeon-history-transition.*) kill -INT "$PPID"; exit 99 ;;
  finalize-term:*history-transition-consumed*) kill -TERM "$PPID"; exit 99 ;;
esac
case "${MOCK_FINALIZE_FAILURE:-}:$*" in
  temp:*history-transition-consumed*) exit 1 ;;
esac
exec /usr/bin/mktemp "$@"
EOF
cat > "$BIN/cat" <<'EOF'
#!/usr/bin/env sh
case "${MOCK_FINALIZE_FAILURE:-}:${1:-}" in
  write:*seeon-history-transition-receipt*) exit 1 ;;
esac
exec /bin/cat "$@"
EOF
cat > "$BIN/sync" <<'EOF'
#!/usr/bin/env sh
path=${2:-}
case "${SIGNAL_POINT:-}:$path" in finalize-dir-term:*/releases) kill -TERM "$PPID"; exit 99 ;; esac
case "${MOCK_FINALIZE_FAILURE:-}:$path" in
  file-fsync:*/.history-transition-consumed.*) exit 1 ;;
  dir-open:*/releases|dir-fsync:*/releases) exit 1 ;;
esac
exit 0
EOF
cat > "$BIN/grep" <<'EOF'
#!/usr/bin/env sh
case "${SIGNAL_POINT:-}" in render-hup) kill -HUP "$PPID"; exit 99 ;; esac
exec /usr/bin/grep "$@"
EOF
chmod +x "$BIN/stat" "$BIN/mv" "$BIN/mktemp" "$BIN/cat" "$BIN/sync" "$BIN/grep"

AUTH=$RELEASES/history-transition-authorization-v1.json
CONSUMED=$RELEASES/history-transition-authorization-v1.consumed.json
ACTIVATION=$RELEASES/$CANDIDATE.json
CURRENT=$RELEASES/current.json
render_auth() { sh "$AUTHORIZER" --render "$1"; }
install_auth() { rm -f "$AUTH" "$CONSUMED"; render_auth "$1" > "$AUTH"; chmod 400 "$AUTH"; }
install_activation() { printf '{"sha":"%s"}\n' "$1" > "$RELEASES/$1.json"; cp "$RELEASES/$1.json" "$CURRENT"; }
run_verify() { PATH="$BIN:$PATH" APP_DIR="$REPO" RELEASE_DIR="$RELEASES" sh "$AUTHORIZER" --verify "$@" 2>&1; }
run_finalize() { PATH="$BIN:$PATH" APP_DIR="$REPO" RELEASE_DIR="$RELEASES" sh "$AUTHORIZER" --finalize "$LEGACY_SHA" "$CANDIDATE" "$ACTIVATION" "$CURRENT" 2>&1; }
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

# Even manually authored canonical-looking authorization cannot turn the
# reviewed anchor itself into a candidate.
rm -f "$AUTH"
render_auth "$CANDIDATE" | sed "s/$CANDIDATE/$ANCHOR_SHA/" > "$AUTH"; chmod 400 "$AUTH"
set +e
output=$(run_verify "$LEGACY_SHA" "$ANCHOR_SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'strict descendant of the reviewed v0.1.1 anchor'
install_auth "$CANDIDATE"

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

# A commit before the reviewed anchor is also not a strict candidate.
install_auth "$MAPPED_SHA"
set +e
output=$(run_verify "$LEGACY_SHA" "$MAPPED_SHA"); status=$?
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

# Consumption keeps operator authorization immutable and publishes an exact,
# content-addressed receipt. Every pre-rename failure leaves no receipt; a
# post-rename directory-fsync failure is conservatively consumed and converges.
install_auth "$CANDIDATE"
install_activation "$CANDIDATE"
for failure in temp write file-fsync rename; do
  rm -f "$CONSUMED"
  set +e
  output=$(MOCK_FINALIZE_FAILURE="$failure" run_finalize); status=$?
  set -e
  assert_failure "$status"
  [ -f "$AUTH" ] && [ ! -e "$CONSUMED" ] || { printf '%s produced an ambiguous pre-rename receipt state\n' "$failure" >&2; exit 1; }
done
for failure in dir-open dir-fsync; do
  rm -f "$CONSUMED"
  set +e
  output=$(MOCK_FINALIZE_FAILURE="$failure" run_finalize); status=$?
  set -e
  assert_failure "$status"
  [ -f "$AUTH" ] && [ -f "$CONSUMED" ] || { printf '%s did not preserve conservative consumed state\n' "$failure" >&2; exit 1; }
  output=$(run_finalize)
  assert_contains "$output" 'consumption receipt is durable and exact'
done

rm -f "$CONSUMED"
output=$(run_finalize)
assert_contains "$output" 'atomically published and fsynced'
[ -f "$AUTH" ] && [ -f "$CONSUMED" ] || { printf '%s\n' 'durable consumption state is invalid' >&2; exit 1; }
grep -Eq "^\\{\"schema\":\"1\",\"transition_id\":\"seeon-backend-filter-repo-history-v1\",\"authorization_id\":\"seeon-backend-v0.1.2-legacy-history-once\",\"legacy_sha\":\"$LEGACY_SHA\",\"current_sha\":\"$LEGACY_SHA\",\"candidate_sha\":\"$CANDIDATE\",\"authorization_sha256\":\"[0-9a-f]{64}\",\"activation_manifest_sha256\":\"[0-9a-f]{64}\"\\}$" "$CONSUMED" || {
  printf 'consumed receipt is not canonical:\n' >&2; cat "$CONSUMED" >&2; exit 1
}
output=$(run_finalize)
assert_contains "$output" 'consumption receipt is durable and exact'
set +e
output=$(run_verify "$LEGACY_SHA" "$CANDIDATE"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'already consumed'

# Once activation is consumed, restoring exact auth or changing it to another
# candidate cannot authorize a second bridge, including after rollback.
rm -f "$AUTH"; render_auth "$CANDIDATE" > "$AUTH"; chmod 400 "$AUTH"
set +e
output=$(run_verify "$LEGACY_SHA" "$CANDIDATE"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'already consumed'
rm -f "$AUTH"; render_auth "$CANDIDATE" | sed "s/$CANDIDATE/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/" > "$AUTH"; chmod 400 "$AUTH"
set +e
output=$(run_verify "$LEGACY_SHA" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'already consumed'

# Signal handlers preserve conventional termination status and never emit a
# success receipt/message before durable completion. A post-rename signal is
# conservatively consumed and converges on retry.
rm -f "$CONSUMED"; install_auth "$CANDIDATE"; install_activation "$CANDIDATE"
set +e
output=$(SIGNAL_POINT=render-hup PATH="$BIN:$PATH" sh "$AUTHORIZER" --render "$CANDIDATE" 2>&1); status=$?
set -e
[ "$status" -eq 129 ] || { printf 'render HUP returned %s\n' "$status" >&2; exit 1; }
case "$output" in *published*|*durable*) printf 'render HUP emitted success: %s\n' "$output" >&2; exit 1;; esac
set +e
output=$(SIGNAL_POINT=verify-int run_verify "$LEGACY_SHA" "$CANDIDATE"); status=$?
set -e
[ "$status" -eq 130 ] || { printf 'verify INT returned %s\n' "$status" >&2; exit 1; }
[ ! -e "$CONSUMED" ]
set +e
output=$(SIGNAL_POINT=finalize-term run_finalize); status=$?
set -e
[ "$status" -eq 143 ] || { printf 'finalize TERM returned %s\n' "$status" >&2; exit 1; }
[ ! -e "$CONSUMED" ]
set +e
output=$(SIGNAL_POINT=finalize-dir-term run_finalize); status=$?
set -e
[ "$status" -eq 143 ] || { printf 'post-rename TERM returned %s\n' "$status" >&2; exit 1; }
[ -f "$CONSUMED" ] || { printf '%s\n' 'post-rename TERM resurrected authorization' >&2; exit 1; }
output=$(run_finalize); assert_contains "$output" 'consumption receipt is durable and exact'

printf '%s\n' 'history transition authorization tests passed (strict v0.1.2 crash-durable signal contract)'
