#!/usr/bin/env sh
set -eu

SCRIPT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/edge-provisioning-smoke.sh
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/edge-provisioning-smoke-test.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT HUP INT TERM

FIXTURE_OUTPUT=$(sh "$SCRIPT" --fixture --dry-run)
printf '%s\n' "$FIXTURE_OUTPUT" | grep -Fx 'AI_EXECUTION_CONTENT_ADDRESS_REJECTION_OK' >/dev/null
printf '%s\n' "$FIXTURE_OUTPUT" | grep -Fx 'AI_IMAGE_PROVENANCE_REJECTION_OK' >/dev/null
printf '%s\n' "$FIXTURE_OUTPUT" | grep -Fx 'AI_INVALID_TIMESTAMP_REJECTION_OK' >/dev/null

printf 'approved fixture plan\n' >"$TMP_ROOT/plan.md"
PLAN_DIGEST=$(shasum -a 256 "$TMP_ROOT/plan.md" | awk '{print $1}')
printf 'approved_plan_sha256: %s\nround_status: approved\n' "$PLAN_DIGEST" >"$TMP_ROOT/draft.md"
cat >"$TMP_ROOT/seal.json" <<EOF
{"schemaVersion":2,"approvedPlanSha256":"$PLAN_DIGEST","ai":{"repository":"SeniorAILab/eldercare-fall-ai","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tree":"1111111111111111111111111111111111111111","backendImage":{"ref":"local/backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","imageId":"sha256:1111111111111111111111111111111111111111111111111111111111111111","platform":"linux/arm64","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repository":"SeniorAILab/eldercare-fall-ai"},"frontImage":{"ref":"local/front@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","imageId":"sha256:2222222222222222222222222222222222222222222222222222222222222222","platform":"linux/arm64","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repository":"SeniorAILab/eldercare-fall-ai"}},"ml":{"repository":"SeniorAILab/eldercare-fall-ml-v2","sha":"dddddddddddddddddddddddddddddddddddddddd","tree":"2222222222222222222222222222222222222222","apiImage":{"ref":"local/api@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","imageId":"sha256:3333333333333333333333333333333333333333333333333333333333333333","platform":"linux/arm64","revision":"dddddddddddddddddddddddddddddddddddddddd","repository":"SeniorAILab/eldercare-fall-ml-v2"},"workerImage":{"ref":"local/worker@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","imageId":"sha256:4444444444444444444444444444444444444444444444444444444444444444","platform":"linux/amd64","revision":"dddddddddddddddddddddddddddddddddddddddd","repository":"SeniorAILab/eldercare-fall-ml-v2"}}}
EOF
cat >"$TMP_ROOT/spoofed-readback.json" <<'EOF'
{"schemaVersion":1,"deploySha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","database":"ok","deployLockAvailable":true,"jenkinsIdle":true,"memorySwapFreeMiB":999999,"diskFreeMiB":999999,"volumesHealthy":true,"queuesDrained":true,"backupVerified":true,"legacyCompatibility":true,"fullLifecycleVerified":true,"rollbackDryRunVerified":true,"scopeVerified":true}
EOF

if EDGE_PROVISIONING_PLAN="$TMP_ROOT/plan.md" \
  EDGE_PROVISIONING_DRAFT="$TMP_ROOT/draft.md" \
  EDGE_PROVISIONING_SEAL="$TMP_ROOT/seal.json" \
  EDGE_PROVISIONING_AI_READBACK="$TMP_ROOT/spoofed-readback.json" \
  sh "$SCRIPT" --production --full-lifecycle >/dev/null 2>&1; then
  printf '%s\n' 'spoofed unanchored AI receipt was accepted' >&2
  exit 1
fi

printf '%s\n' 'EDGE_PROVISIONING_SPOOF_REJECTION_OK'
