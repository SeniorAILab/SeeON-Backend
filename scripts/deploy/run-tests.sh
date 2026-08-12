#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
cd "$REPO_ROOT"

run() {
  printf '+ %s\n' "$*"
  "$@"
}

run sh infra/api-ingress/nginx-config.test.sh
for test_script in $(find scripts/deploy -maxdepth 1 -type f -name '*.test.sh' | LC_ALL=C sort); do
  run sh "$test_script"
done
run node --test scripts/deploy/iwinv-workflow-contract.test.mjs
run sh scripts/release/verify-github-ci-gate.test.sh

printf '%s\n' 'all deploy and release-gate tests passed'
