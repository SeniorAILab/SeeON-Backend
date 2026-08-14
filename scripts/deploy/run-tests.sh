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
  case "$test_script" in
    scripts/deploy/event-media-backup-inputs.test.sh|scripts/deploy/event-media-restore-harness.test.sh|scripts/deploy/event-media-product-restore-harness.test.sh)
      # Manual backup tooling has its own deploy:event-media:manual-test gate.
      continue
      ;;
  esac
  run sh "$test_script"
done
run node scripts/deploy/verify-edge-provisioning-evidence.mjs --fixture
run node --test scripts/deploy/iwinv-overlap-smoke.test.mjs
run node --test scripts/deploy/iwinv-workflow-contract.test.mjs
run sh scripts/release/verify-github-ci-gate.test.sh

printf '%s\n' 'all deploy and release-gate tests passed'
