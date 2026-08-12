#!/usr/bin/env sh
set -eu
set +x

REPOSITORY=${GITHUB_REPOSITORY:-SeniorAILab/SeeON}
GITHUB_API_URL=${GITHUB_API_URL:-https://api.github.com}
GITHUB_TOKEN=${GITHUB_TOKEN:-}

fail() { printf '%s\n' "$1" >&2; exit 1; }
valid_sha() { [ "${#1}" -eq 40 ] && printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }

[ "$#" -eq 1 ] || fail 'Usage: verify-github-ci-gate.sh <release-sha>'
SHA=$1
valid_sha "$SHA" || fail 'release SHA must be exactly 40 lowercase hexadecimal characters'
[ "$REPOSITORY" = SeniorAILab/SeeON ] || fail 'GitHub ci-gate repository must be SeniorAILab/SeeON'
[ -n "$GITHUB_TOKEN" ] || fail 'GITHUB_TOKEN is required to verify GitHub ci-gate'
command -v curl >/dev/null 2>&1 || fail 'curl is required to verify GitHub ci-gate'
command -v jq >/dev/null 2>&1 || fail 'jq is required to validate GitHub check-run JSON'

response=$(mktemp "${TMPDIR:-/tmp}/seeon-ci-gate.XXXXXX") || fail 'unable to create GitHub ci-gate response capture'
trap 'rm -f "$response"' EXIT HUP INT TERM
url="$GITHUB_API_URL/repos/$REPOSITORY/commits/$SHA/check-runs?check_name=CI%20gate&filter=latest&per_page=100"
curl --fail --show-error --silent --connect-timeout 10 --max-time 30 --retry 0 \
  --header 'Accept: application/vnd.github+json' \
  --header "Authorization: Bearer $GITHUB_TOKEN" \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  "$url" > "$response" || fail 'Unable to read GitHub ci-gate check runs'

jq -e --arg sha "$SHA" '
  (.check_runs | type == "array") and
  ([.check_runs[] |
    select(
      .name == "CI gate" and
      .head_sha == $sha and
      .status == "completed" and
      .conclusion == "success"
    )] | length == 1)
' "$response" >/dev/null 2>&1 || fail "GitHub ci-gate is not successful for release SHA $SHA"

printf 'GitHub ci-gate verified. sha=%s\n' "$SHA"
