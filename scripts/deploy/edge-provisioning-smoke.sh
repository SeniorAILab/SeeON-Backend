#!/usr/bin/env sh
set -eu
set +x

MIN_AI_MEMORY_SWAP_MIB=1024
MIN_AI_DISK_MIB=10240
MODE=
DRY_RUN=false
AI_ONLY=false
SCOPE_READBACK=false
FULL_LIFECYCLE=false
PLAN=${EDGE_PROVISIONING_PLAN:-}
DRAFT=${EDGE_PROVISIONING_DRAFT:-}
SEAL=${EDGE_PROVISIONING_SEAL:-}
READBACK=${EDGE_PROVISIONING_AI_READBACK:-}

fail() { printf '%s\n' "$1" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: edge-provisioning-smoke.sh --fixture --dry-run | --production [--ai-only|--scope-readback|--full-lifecycle]' >&2
  exit 2
}
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
json_value() {
  node -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));let out=value;for(const key of process.argv.slice(2))out=out?.[key];if(typeof out!=="string"&&typeof out!=="number"&&typeof out!=="boolean")process.exit(2);process.stdout.write(String(out));' "$@"
}
approved_sha() {
  awk -F': *' '$1 == "approved_plan_sha256" { print $2; exit }' "$1"
}
gate_artifacts() {
  [ -f "$PLAN" ] || fail 'approved plan is missing'
  [ -f "$DRAFT" ] || fail 'approved draft receipt is missing'
  [ -f "$SEAL" ] || fail 'sealed RC receipt is missing'
  expected=$(approved_sha "$DRAFT")
  case "$expected" in *[!0-9a-f]*) fail 'approved plan SHA is invalid' ;; esac
  [ "${#expected}" -eq 64 ] || fail 'approved plan SHA is missing from draft'
  grep -Fx 'round_status: approved' "$DRAFT" >/dev/null || fail 'draft review round is not approved'
  [ "$(sha256_file "$PLAN")" = "$expected" ] || fail 'approved plan hash mismatch'
  [ "$(json_value "$SEAL" schemaVersion)" = 1 ] || fail 'sealed RC schema mismatch'
  [ "$(json_value "$SEAL" approvedPlanSha256)" = "$expected" ] || fail 'sealed RC plan binding mismatch'
  ai_sha=$(json_value "$SEAL" ai sha)
  case "$ai_sha" in *[!0-9a-f]*) fail 'sealed AI SHA is invalid' ;; esac
  [ "${#ai_sha}" -eq 40 ] || fail 'sealed AI SHA is invalid'
  for key in backendImage frontImage; do
    image=$(json_value "$SEAL" ai "$key")
    case "$image" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) fail "sealed AI $key is not digest-pinned" ;; esac
  done
}
check_readback() {
  [ -f "$READBACK" ] || fail 'AI API readback receipt is missing'
  [ "$(json_value "$READBACK" schemaVersion)" = 1 ] || fail 'AI readback schema mismatch'
  [ "$(json_value "$READBACK" deploySha)" = "$(json_value "$SEAL" ai sha)" ] || fail 'AI readback SHA mismatch'
  [ "$(json_value "$READBACK" database)" = ok ] || fail 'AI database is unhealthy'
  [ "$(json_value "$READBACK" deployLockAvailable)" = true ] || fail 'AI deploy lock is held'
  [ "$(json_value "$READBACK" jenkinsIdle)" = true ] || fail 'Jenkins deployment is concurrent'
  [ "$(json_value "$READBACK" memorySwapFreeMiB)" -ge "$MIN_AI_MEMORY_SWAP_MIB" ] || fail 'AI memory plus swap capacity is below 1024 MiB'
  [ "$(json_value "$READBACK" diskFreeMiB)" -ge "$MIN_AI_DISK_MIB" ] || fail 'AI free disk is below 10 GiB'
  [ "$(json_value "$READBACK" volumesHealthy)" = true ] || fail 'AI volumes are unhealthy'
  [ "$(json_value "$READBACK" queuesDrained)" = true ] || fail 'AI queues are not drained'
  [ "$(json_value "$READBACK" backupVerified)" = true ] || fail 'AI backup is missing or unverifiable'
  [ "$(json_value "$READBACK" legacyCompatibility)" = true ] || fail 'legacy rollback compatibility is disabled'
}
fixture() {
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/edge-provisioning-smoke.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT HUP INT TERM
  printf 'fixture approved plan\n' > "$tmp/plan.md"
  digest=$(sha256_file "$tmp/plan.md")
  printf 'approved_plan_sha256: %s\nround_status: approved\n' "$digest" > "$tmp/draft.md"
  cat > "$tmp/seal.json" <<EOF
{"schemaVersion":1,"approvedPlanSha256":"$digest","ai":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","backendImage":"local/backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","frontImage":"local/front@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},"ml":{"sha":"dddddddddddddddddddddddddddddddddddddddd","apiImage":"local/api@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","workerImage":"local/worker@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}}
EOF
  cat > "$tmp/readback.json" <<'EOF'
{"schemaVersion":1,"deploySha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","database":"ok","deployLockAvailable":true,"jenkinsIdle":true,"memorySwapFreeMiB":1024,"diskFreeMiB":10240,"volumesHealthy":true,"queuesDrained":true,"backupVerified":true,"legacyCompatibility":true}
EOF
  PLAN=$tmp/plan.md DRAFT=$tmp/draft.md SEAL=$tmp/seal.json READBACK=$tmp/readback.json
  gate_artifacts
  check_readback
  for mutation in plan lock jenkins memory disk volume queue backup digest; do
    cp "$tmp/readback.json" "$tmp/bad.json"
    case "$mutation" in
      plan) printf 'drift\n' >> "$tmp/plan.md" ;;
      lock) node -e 'const f=process.argv[1],v=require(f);v.deployLockAvailable=false;require("node:fs").writeFileSync(f,JSON.stringify(v))' "$tmp/bad.json" ;;
      jenkins) node -e 'const f=process.argv[1],v=require(f);v.jenkinsIdle=false;require("node:fs").writeFileSync(f,JSON.stringify(v))' "$tmp/bad.json" ;;
      memory) node -e 'const f=process.argv[1],v=require(f);v.memorySwapFreeMiB=1023;require("node:fs").writeFileSync(f,JSON.stringify(v))' "$tmp/bad.json" ;;
      disk) node -e 'const f=process.argv[1],v=require(f);v.diskFreeMiB=10239;require("node:fs").writeFileSync(f,JSON.stringify(v))' "$tmp/bad.json" ;;
      volume) node -e 'const f=process.argv[1],v=require(f);v.volumesHealthy=false;require("node:fs").writeFileSync(f,JSON.stringify(v))' "$tmp/bad.json" ;;
      queue) node -e 'const f=process.argv[1],v=require(f);v.queuesDrained=false;require("node:fs").writeFileSync(f,JSON.stringify(v))' "$tmp/bad.json" ;;
      backup) node -e 'const f=process.argv[1],v=require(f);v.backupVerified=false;require("node:fs").writeFileSync(f,JSON.stringify(v))' "$tmp/bad.json" ;;
      digest) node -e 'const f=process.argv[1],v=require(f);v.deploySha="9999999999999999999999999999999999999999";require("node:fs").writeFileSync(f,JSON.stringify(v))' "$tmp/bad.json" ;;
    esac
    if [ "$mutation" = plan ]; then
      if (gate_artifacts) >/dev/null 2>&1; then fail 'plan drift fixture passed'; fi
      printf 'fixture approved plan\n' > "$tmp/plan.md"
    else
      READBACK=$tmp/bad.json
      if (check_readback) >/dev/null 2>&1; then fail "$mutation rejection fixture passed"; fi
      READBACK=$tmp/readback.json
    fi
  done
  printf '%s\n' 'EDGE_PROVISIONING_SMOKE_FIXTURE_OK'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fixture) MODE=fixture; shift ;;
    --production) MODE=production; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --ai-only) AI_ONLY=true; shift ;;
    --scope-readback) SCOPE_READBACK=true; shift ;;
    --full-lifecycle) FULL_LIFECYCLE=true; shift ;;
    *) usage ;;
  esac
done
[ "$MODE" = fixture ] && { [ "$DRY_RUN" = true ] || usage; fixture; exit 0; }
[ "$MODE" = production ] || usage
gate_artifacts
check_readback
[ "$AI_ONLY" = true ] || [ "$SCOPE_READBACK" = true ] || [ "$FULL_LIFECYCLE" = true ] || usage
printf 'EDGE_PROVISIONING_SMOKE_OK ai_sha=%s mode=read-only\n' "$(json_value "$SEAL" ai sha)"
