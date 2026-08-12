#!/usr/bin/env sh
set -eu
set +x

REPOSITORY=${GITHUB_REPOSITORY:-SeniorAILab/SeeON-Backend}
GITHUB_API_URL=${GITHUB_API_URL:-https://api.github.com}
GITHUB_TOKEN=${GITHUB_TOKEN:-}
MAX_RESPONSE_BYTES=1048576

fail() { printf '%s\n' "$1" >&2; exit 1; }
valid_sha() { [ "${#1}" -eq 40 ] && printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }

[ "$#" -eq 1 ] || fail 'Usage: verify-github-ci-gate.sh <release-sha>'
SHA=$1
valid_sha "$SHA" || fail 'release SHA must be exactly 40 lowercase hexadecimal characters'
[ "$REPOSITORY" = SeniorAILab/SeeON-Backend ] || fail 'GitHub ci-gate repository must be SeniorAILab/SeeON-Backend'
[ "$GITHUB_API_URL" = https://api.github.com ] || fail 'GitHub ci-gate API must be https://api.github.com'
[ -n "$GITHUB_TOKEN" ] || fail 'GITHUB_TOKEN is required to verify GitHub ci-gate'
command -v curl >/dev/null 2>&1 || fail 'curl is required to read GitHub check runs'
for tool in cat mktemp rm tr wc; do
  command -v "$tool" >/dev/null 2>&1 || fail "required GitHub check-run capture tool is missing: $tool"
done

response=$(mktemp "${TMPDIR:-/tmp}/seeon-ci-gate.XXXXXX") || fail 'unable to create GitHub ci-gate response capture'
trap 'rm -f "$response"' EXIT HUP INT TERM
url="$GITHUB_API_URL/repos/$REPOSITORY/commits/$SHA/check-runs?check_name=CI%20gate&filter=latest&per_page=100"
# Read the bearer header from curl config on stdin so the token is absent from
# the process argv as well as Jenkins shell tracing and logs.
if ! curl --fail --show-error --silent --proto '=https' --tlsv1.2 \
  --connect-timeout 10 --max-time 30 --retry 0 --config - "$url" > "$response" <<EOF
header = "Accept: application/vnd.github+json"
header = "Authorization: Bearer $GITHUB_TOKEN"
header = "X-GitHub-Api-Version: 2022-11-28"
EOF
then
  fail 'Unable to read GitHub ci-gate check runs'
fi

response_bytes=$(wc -c < "$response" | tr -d '[:space:]')
case "$response_bytes" in ''|*[!0-9]*) fail 'Unable to size GitHub ci-gate check-run response' ;; esac
[ "$response_bytes" -gt 0 ] || fail 'GitHub ci-gate check-run response is empty'
[ "$response_bytes" -le "$MAX_RESPONSE_BYTES" ] || fail 'GitHub ci-gate check-run response exceeds 1048576 bytes'
cat "$response"
