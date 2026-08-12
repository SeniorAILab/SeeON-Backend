#!/usr/bin/env sh
# shellcheck disable=SC2016 # Literal shell-injection text is an input fixture.
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
FETCH=$REPO_ROOT/scripts/release/verify-github-ci-gate.sh
PARSER=$REPO_ROOT/scripts/release/verify-github-ci-gate.groovy
FIXTURES=$REPO_ROOT/scripts/release/fixtures/github-ci-gate-cases.json
JENKINSFILE=$REPO_ROOT/Jenkinsfile
SEED=$REPO_ROOT/scripts/deploy/jenkins-job-seed.groovy
READINESS=$REPO_ROOT/scripts/deploy/iwinv-overlap-readiness.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/bin" "$TMP/no-jq-bin"

cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' "$*" >> "${CURL_LOG:?}"
config=$(cat)
case "$config" in
  *"Authorization: Bearer ${EXPECTED_TOKEN:?}"*) printf '%s\n' 'authorization-config=present' >> "$CURL_LOG" ;;
  *) printf '%s\n' 'authorization config missing' >&2; exit 2 ;;
esac
[ "${CURL_EXIT:-0}" -eq 0 ] || exit "$CURL_EXIT"
if [ -n "${RESPONSE_BYTES:-}" ]; then
  head -c "$RESPONSE_BYTES" /dev/zero | tr '\000' x
else
  printf '%s' "${CHECK_RESPONSE?}"
fi
EOF
chmod +x "$TMP/bin/curl"
for tool in sh cat grep head mktemp rm tr wc; do
  tool_path=$(command -v "$tool") || { printf 'test prerequisite missing: %s\n' "$tool" >&2; exit 1; }
  ln -s "$tool_path" "$TMP/no-jq-bin/$tool"
done
ln -s "$TMP/bin/curl" "$TMP/no-jq-bin/curl"

SHA=0123456789abcdef0123456789abcdef01234567
SUCCESS='{"total_count":1,"check_runs":[{"id":101,"name":"CI gate"}]}'
run_fetch() {
  PATH="$TMP/no-jq-bin" CURL_LOG="$TMP/curl.log" GITHUB_TOKEN="${TEST_TOKEN-}" EXPECTED_TOKEN="${TEST_TOKEN-synthetic-token}" \
    CHECK_RESPONSE="${TEST_RESPONSE-$SUCCESS}" RESPONSE_BYTES="${TEST_RESPONSE_BYTES-}" CURL_EXIT="${TEST_CURL_EXIT:-0}" \
    "$TMP/no-jq-bin/sh" "$FETCH" "$1" 2>&1
}
assert_failure() { [ "$1" -ne 0 ] || { printf '%s\n' 'ci gate command unexpectedly passed' >&2; exit 1; }; }
assert_contains() { case "$1" in *"$2"*) ;; *) printf 'missing expected output: %s\n%s\n' "$2" "$1" >&2; exit 1;; esac; }

# The fetch path must work in the locked Jenkins PATH with jq, Node, Python,
# and a Groovy CLI all absent. Parsing belongs to Jenkins-native Groovy.
: > "$TMP/curl.log"
output=$(TEST_TOKEN=synthetic-token run_fetch "$SHA")
[ "$output" = "$SUCCESS" ] || { printf 'unexpected fetch output: %s\n' "$output" >&2; exit 1; }
grep -F 'repos/SeniorAILab/SeeON-Backend/commits/' "$TMP/curl.log" >/dev/null
grep -F 'authorization-config=present' "$TMP/curl.log" >/dev/null
if grep -F 'synthetic-token' "$TMP/curl.log" >/dev/null; then
  printf '%s\n' 'GitHub token leaked into curl argv/log contract' >&2
  exit 1
fi

test -f "$PARSER"
test -s "$FIXTURES"
grep -F "def ciGateVerifier = load('scripts/release/verify-github-ci-gate.groovy')" "$JENKINSFILE" >/dev/null
grep -F 'for tool in awk cat chmod cmp curl cut date df dirname docker free git grep head mktemp mkdir mv pwd rm rmdir sed sh sha256sum sort ssh ssh-add ssh-agent stat tail tr wc; do' "$JENKINSFILE" >/dev/null
grep -F 'docker buildx version' "$JENKINSFILE" >/dev/null
grep -F 'docker compose version' "$JENKINSFILE" >/dev/null
grep -F "sshagent(credentials: ['seeon-backend-github-deploy-key'])" "$JENKINSFILE" >/dev/null
grep -F "credentials('seeon-backend-github-deploy-key')" "$SEED" >/dev/null
if grep -F 'eldercare-github-deploy-key' "$JENKINSFILE" "$SEED" >/dev/null; then
  printf '%s\n' 'old repository credential remains in the Jenkins contract' >&2
  exit 1
fi
if grep -Eq '(^|[^[:alnum:]_])jq([^[:alnum:]_]|$)' "$FETCH" "$READINESS"; then
  printf '%s\n' 'jq remains a locked Jenkins runtime dependency' >&2
  exit 1
fi

# Invalid SHA and missing token fail before curl; HTTP/rate-limit failures and
# oversized bodies fail without exposing response or token content.
: > "$TMP/curl.log"
set +e
output=$(TEST_TOKEN=synthetic-token run_fetch '$(touch /tmp/must-not-run)'); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'release SHA must be exactly 40'
[ ! -s "$TMP/curl.log" ]
set +e
output=$(run_fetch "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'GITHUB_TOKEN is required'
set +e
output=$(TEST_TOKEN=synthetic-token TEST_CURL_EXIT=22 run_fetch "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Unable to read GitHub ci-gate check runs'
set +e
output=$(TEST_TOKEN=synthetic-token TEST_RESPONSE='' run_fetch "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'check-run response is empty'
set +e
output=$(TEST_TOKEN=synthetic-token TEST_RESPONSE_BYTES=1048577 run_fetch "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'response exceeds 1048576 bytes'

printf '%s\n' 'GitHub ci-gate fetch and Jenkins contracts passed'
