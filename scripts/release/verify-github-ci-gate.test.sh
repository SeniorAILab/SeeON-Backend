#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/release/verify-github-ci-gate.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/bin"

cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' "$*" >> "${CURL_LOG:?}"
printf '%s\n' "${CHECK_RESPONSE:?}"
EOF
chmod +x "$TMP/bin/curl"

SHA=0123456789abcdef0123456789abcdef01234567
run_gate() {
  PATH="$TMP/bin:$PATH" CURL_LOG="$TMP/curl.log" GITHUB_TOKEN="${TEST_TOKEN-}" CHECK_RESPONSE="$1" sh "$SCRIPT" "$SHA" 2>&1
}
assert_failure() { [ "$1" -ne 0 ] || { printf '%s\n' 'ci gate unexpectedly passed' >&2; exit 1; }; }
assert_contains() { case "$1" in *"$2"*) ;; *) printf 'missing expected output: %s\n%s\n' "$2" "$1" >&2; exit 1;; esac; }

success='{"check_runs":[{"name":"CI gate","head_sha":"'$SHA'","status":"completed","conclusion":"success","completed_at":"2026-08-12T00:00:00Z"}]}'
: > "$TMP/curl.log"
output=$(TEST_TOKEN=synthetic-token run_gate "$success")
assert_contains "$output" 'GitHub ci-gate verified'
grep -F 'repos/SeniorAILab/SeeON/commits/' "$TMP/curl.log" >/dev/null
grep -F 'Authorization: Bearer synthetic-token' "$TMP/curl.log" >/dev/null

for response in \
  '{"check_runs":[]}' \
  '{"check_runs":[{"name":"CI gate","head_sha":"'$SHA'","status":"in_progress","conclusion":null,"completed_at":null}]}' \
  '{"check_runs":[{"name":"CI gate","head_sha":"'$SHA'","status":"completed","conclusion":"failure","completed_at":"2026-08-12T00:00:00Z"}]}' \
  '{"check_runs":[{"name":"CI gate","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"completed","conclusion":"success","completed_at":"2026-08-12T00:00:00Z"}]}' \
  'not-json'; do
  set +e
  output=$(TEST_TOKEN=synthetic-token run_gate "$response"); status=$?
  set -e
  assert_failure "$status"
  assert_contains "$output" 'GitHub ci-gate is not successful'
done

: > "$TMP/curl.log"
set +e
output=$(run_gate "$success"); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'GITHUB_TOKEN is required'
[ ! -s "$TMP/curl.log" ] || { printf '%s\n' 'missing token reached GitHub' >&2; exit 1; }

printf '%s\n' 'GitHub ci-gate verifier tests passed'
