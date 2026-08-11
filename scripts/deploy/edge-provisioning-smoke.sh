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
APPROVED_PLAN_SHA256=${EDGE_PROVISIONING_APPROVED_PLAN_SHA256:-}
SEAL_SHA256=${EDGE_PROVISIONING_SEAL_SHA256:-}
READBACK_SHA256=${EDGE_PROVISIONING_AI_READBACK_SHA256:-}

fail() { printf '%s\n' "$1" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: edge-provisioning-smoke.sh --fixture --dry-run | --production [--ai-only|--scope-readback|--full-lifecycle]' >&2
  exit 2
}
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
require_sha256() {
  value=$1
  label=$2
  case "$value" in *[!0-9a-f]*) fail "$label SHA-256 is invalid" ;; esac
  [ "${#value}" -eq 64 ] || fail "$label SHA-256 is invalid"
}
json_value() {
  node -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));let out=value;for(const key of process.argv.slice(2))out=out?.[key];if(typeof out!=="string"&&typeof out!=="number"&&typeof out!=="boolean")process.exit(2);process.stdout.write(String(out));' "$@"
}
approved_sha() { awk -F': *' '$1 == "approved_plan_sha256" { print $2; exit }' "$1"; }
check_sealed_image() {
  repo=$1
  image=$2
  expected_repository=$3
  ref=$(json_value "$SEAL" "$repo" "$image" ref)
  image_id=$(json_value "$SEAL" "$repo" "$image" imageId)
  platform=$(json_value "$SEAL" "$repo" "$image" platform)
  revision=$(json_value "$SEAL" "$repo" "$image" revision)
  repository=$(json_value "$SEAL" "$repo" "$image" repository)
  case "$ref" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) fail "sealed $repo $image is not digest-pinned" ;; esac
  case "$image_id" in sha256:????????????????????????????????????????????????????????????????) ;; *) fail "sealed $repo $image ID is invalid" ;; esac
  case "$platform" in linux/amd64|linux/arm64) ;; *) fail "sealed $repo $image platform is invalid" ;; esac
  [ "$revision" = "$(json_value "$SEAL" "$repo" sha)" ] || fail "sealed $repo $image revision mismatch"
  [ "$repository" = "$expected_repository" ] || fail "sealed $repo $image repository mismatch"
}
gate_artifacts() {
  [ -f "$PLAN" ] && [ -f "$DRAFT" ] && [ -f "$SEAL" ] || fail 'approved plan, draft, and sealed RC receipt are required'
  require_sha256 "$APPROVED_PLAN_SHA256" 'approved plan anchor'
  require_sha256 "$SEAL_SHA256" 'sealed RC anchor'
  [ "$(sha256_file "$PLAN")" = "$APPROVED_PLAN_SHA256" ] || fail 'approved plan content changed'
  [ "$(approved_sha "$DRAFT")" = "$APPROVED_PLAN_SHA256" ] || fail 'draft approved-plan binding mismatch'
  grep -Fx 'round_status: approved' "$DRAFT" >/dev/null || fail 'draft review round is not approved'
  [ "$(sha256_file "$SEAL")" = "$SEAL_SHA256" ] || fail 'sealed RC content-address mismatch'
  [ "$(json_value "$SEAL" schemaVersion)" = 2 ] || fail 'sealed RC schema mismatch'
  [ "$(json_value "$SEAL" approvedPlanSha256)" = "$APPROVED_PLAN_SHA256" ] || fail 'sealed RC plan binding mismatch'
  [ "$(json_value "$SEAL" ai repository)" = SeniorAILab/eldercare-fall-ai ] || fail 'sealed AI repository identity mismatch'
  [ "$(json_value "$SEAL" ml repository)" = SeniorAILab/eldercare-fall-ml-v2 ] || fail 'sealed ML repository identity mismatch'
  for repo in ai ml; do
    sha=$(json_value "$SEAL" "$repo" sha)
    tree=$(json_value "$SEAL" "$repo" tree)
    case "$sha$tree" in *[!0-9a-f]*) fail "sealed $repo commit provenance is invalid" ;; esac
    [ "${#sha}" -eq 40 ] && [ "${#tree}" -eq 40 ] || fail "sealed $repo commit provenance is invalid"
  done
  check_sealed_image ai backendImage SeniorAILab/eldercare-fall-ai
  check_sealed_image ai frontImage SeniorAILab/eldercare-fall-ai
  check_sealed_image ml apiImage SeniorAILab/eldercare-fall-ml-v2
  check_sealed_image ml workerImage SeniorAILab/eldercare-fall-ml-v2
}
check_snapshot() {
  section=$1
  [ "$(json_value "$READBACK" "$section" database)" = ok ] || fail "AI $section database is unhealthy"
  [ "$(json_value "$READBACK" "$section" deployLockAvailable)" = true ] || fail "AI $section deploy lock is held"
  [ "$(json_value "$READBACK" "$section" jenkinsIdle)" = true ] || fail "AI $section Jenkins deployment is concurrent"
  [ "$(json_value "$READBACK" "$section" memorySwapFreeMiB)" -ge "$MIN_AI_MEMORY_SWAP_MIB" ] || fail "AI $section memory plus swap is below 1024 MiB"
  [ "$(json_value "$READBACK" "$section" diskFreeMiB)" -ge "$MIN_AI_DISK_MIB" ] || fail "AI $section free disk is below 10 GiB"
  [ "$(json_value "$READBACK" "$section" volumesHealthy)" = true ] || fail "AI $section volumes are unhealthy"
  [ "$(json_value "$READBACK" "$section" queuesDrained)" = true ] || fail "AI $section queues are not drained"
  [ "$(json_value "$READBACK" "$section" backupVerified)" = true ] || fail "AI $section backup is unverifiable"
  [ "$(json_value "$READBACK" "$section" schemaIntegrity)" = true ] || fail "AI $section schema integrity failed"
  [ "$(json_value "$READBACK" "$section" scopeVerified)" = true ] || fail "AI $section facility scope failed"
  [ "$(json_value "$READBACK" "$section" legacyCompatibility)" = true ] || fail "AI $section legacy compatibility is disabled"
}
execution_ok() {
  execution_id=$1
  node -e '
const fs=require("node:fs");const crypto=require("node:crypto");
const path=require("node:path");
const body=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const item=body.executions.find((value)=>value.id===process.argv[2]);
if(!item||item.exitCode!==0||!Number.isInteger(item.sequence)||item.sequence<1)process.exit(1);
if(!/^[a-f0-9]{64}$/.test(item.evidenceSha256??""))process.exit(1);
if(item.evidencePath!=="executions/"+process.argv[2]+".txt")process.exit(1);
const evidencePath=path.resolve(path.dirname(process.argv[1]),item.evidencePath);
if(crypto.createHash("sha256").update(fs.readFileSync(evidencePath)).digest("hex")!==item.evidenceSha256)process.exit(1);
const started=Date.parse(item.startedAt),completed=Date.parse(item.completedAt);
if(!Number.isFinite(started)||!Number.isFinite(completed)||completed<started)process.exit(1);
' "$READBACK" "$execution_id" || fail "AI execution evidence failed: $execution_id"
}
check_readback() {
  [ -f "$READBACK" ] || fail 'AI execution receipt is missing'
  require_sha256 "$READBACK_SHA256" 'AI execution receipt anchor'
  [ "$(sha256_file "$READBACK")" = "$READBACK_SHA256" ] || fail 'AI execution receipt content-address mismatch'
  [ "$(json_value "$READBACK" schemaVersion)" = 2 ] || fail 'AI execution receipt schema mismatch'
  [ "$(json_value "$READBACK" deploySha)" = "$(json_value "$SEAL" ai sha)" ] || fail 'AI execution receipt SHA mismatch'
  check_snapshot preflight
  if [ "$SCOPE_READBACK" = true ]; then execution_ok scope-readback; fi
  if [ "$FULL_LIFECYCLE" = true ]; then
    for id in credential-issue enrollment topology-sync heartbeat event-clip-download credential-rotation timeout-retry restart rollback-dry-run; do execution_ok "$id"; done
    check_snapshot postRestart
    node -e '
const fs=require("node:fs");const body=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const restart=body.executions.find((value)=>value.id==="restart");
if(body.postRestart.generation<=body.preflight.generation)process.exit(1);
const observed=Date.parse(body.postRestart.observedAt),completed=Date.parse(restart.completedAt);
if(!Number.isFinite(observed)||!Number.isFinite(completed)||observed<=completed)process.exit(1);
' "$READBACK" || fail 'AI post-restart evidence is stale'
  fi
}
fixture() {
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/edge-provisioning-smoke.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT HUP INT TERM
  printf 'fixture approved plan\n' >"$tmp/plan.md"
  APPROVED_PLAN_SHA256=$(sha256_file "$tmp/plan.md")
  printf 'approved_plan_sha256: %s\nround_status: approved\n' "$APPROVED_PLAN_SHA256" >"$tmp/draft.md"
  cat >"$tmp/seal.json" <<EOF
{"schemaVersion":2,"approvedPlanSha256":"$APPROVED_PLAN_SHA256","ai":{"repository":"SeniorAILab/eldercare-fall-ai","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tree":"1111111111111111111111111111111111111111","backendImage":{"ref":"local/backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","imageId":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","platform":"linux/arm64","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repository":"SeniorAILab/eldercare-fall-ai"},"frontImage":{"ref":"local/front@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","imageId":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","platform":"linux/arm64","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","repository":"SeniorAILab/eldercare-fall-ai"}},"ml":{"repository":"SeniorAILab/eldercare-fall-ml-v2","sha":"dddddddddddddddddddddddddddddddddddddddd","tree":"2222222222222222222222222222222222222222","apiImage":{"ref":"local/api@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","imageId":"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","platform":"linux/arm64","revision":"dddddddddddddddddddddddddddddddddddddddd","repository":"SeniorAILab/eldercare-fall-ml-v2"},"workerImage":{"ref":"local/worker@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","imageId":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","platform":"linux/amd64","revision":"dddddddddddddddddddddddddddddddddddddddd","repository":"SeniorAILab/eldercare-fall-ml-v2"}}}
EOF
  snapshot='"database":"ok","deployLockAvailable":true,"jenkinsIdle":true,"memorySwapFreeMiB":1024,"diskFreeMiB":10240,"volumesHealthy":true,"queuesDrained":true,"backupVerified":true,"schemaIntegrity":true,"scopeVerified":true,"legacyCompatibility":true'
  executions=
  sequence=0
  mkdir "$tmp/executions" "$tmp/state"
  for id in credential-issue enrollment topology-sync heartbeat event-clip-download credential-rotation timeout-retry restart rollback-dry-run scope-readback; do
    sequence=$((sequence + 1))
    case "$id" in
      restart) printf '2\n' >"$tmp/state/generation" ;;
      rollback-dry-run) cp "$tmp/state/generation" "$tmp/state/rollback-generation"; cmp "$tmp/state/generation" "$tmp/state/rollback-generation" ;;
      *) printf '%s\n' "$id" >"$tmp/state/$id" ;;
    esac >"$tmp/executions/$id.txt" 2>&1
    printf 'action=%s exit=0\n' "$id" >>"$tmp/executions/$id.txt"
    evidence_sha=$(sha256_file "$tmp/executions/$id.txt")
    row="{\"id\":\"$id\",\"sequence\":$sequence,\"startedAt\":\"2026-08-11T00:00:00Z\",\"completedAt\":\"2026-08-11T00:00:01Z\",\"exitCode\":0,\"evidencePath\":\"executions/$id.txt\",\"evidenceSha256\":\"$evidence_sha\"}"
    [ -z "$executions" ] && executions=$row || executions="$executions,$row"
  done
  printf '{"schemaVersion":2,"deploySha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","preflight":{"generation":1,"observedAt":"2026-08-10T23:59:59Z",%s},"executions":[%s],"postRestart":{"generation":2,"observedAt":"2026-08-11T00:00:02Z",%s}}\n' "$snapshot" "$executions" "$snapshot" >"$tmp/readback.json"
  PLAN=$tmp/plan.md DRAFT=$tmp/draft.md SEAL=$tmp/seal.json READBACK=$tmp/readback.json
  SEAL_SHA256=$(sha256_file "$SEAL") READBACK_SHA256=$(sha256_file "$READBACK") FULL_LIFECYCLE=true SCOPE_READBACK=true
  gate_artifacts
  check_readback
  cp "$tmp/executions/restart.txt" "$tmp/restart.txt.original"
  printf 'forged\n' >>"$tmp/executions/restart.txt"
  if (check_readback) >/dev/null 2>&1; then fail 'forged execution evidence passed'; fi
  mv "$tmp/restart.txt.original" "$tmp/executions/restart.txt"
  printf '%s\n' 'AI_EXECUTION_CONTENT_ADDRESS_REJECTION_OK'
  cp "$SEAL" "$tmp/bad-seal.json"
  node -e 'const fs=require("node:fs"),p=process.argv[1],v=JSON.parse(fs.readFileSync(p));v.ai.backendImage.platform="darwin/arm64";fs.writeFileSync(p,JSON.stringify(v))' "$tmp/bad-seal.json"
  original_seal=$SEAL original_seal_sha=$SEAL_SHA256 SEAL=$tmp/bad-seal.json SEAL_SHA256=$(sha256_file "$tmp/bad-seal.json")
  if (gate_artifacts) >/dev/null 2>&1; then fail 'invalid image provenance passed'; fi
  SEAL=$original_seal SEAL_SHA256=$original_seal_sha
  printf '%s\n' 'AI_IMAGE_PROVENANCE_REJECTION_OK'
  cp "$READBACK" "$tmp/invalid-timestamp.json"
  node -e 'const fs=require("node:fs"),p=process.argv[1],v=JSON.parse(fs.readFileSync(p));v.postRestart.observedAt="invalid";fs.writeFileSync(p,JSON.stringify(v))' "$tmp/invalid-timestamp.json"
  original_readback=$READBACK original_readback_sha=$READBACK_SHA256 READBACK=$tmp/invalid-timestamp.json READBACK_SHA256=$(sha256_file "$tmp/invalid-timestamp.json")
  if (check_readback) >/dev/null 2>&1; then fail 'invalid post-restart timestamp passed'; fi
  READBACK=$original_readback READBACK_SHA256=$original_readback_sha
  printf '%s\n' 'AI_INVALID_TIMESTAMP_REJECTION_OK'
  cp "$READBACK" "$tmp/tampered.json"
  node -e 'const fs=require("node:fs"),p=process.argv[1],v=JSON.parse(fs.readFileSync(p));v.postRestart.queuesDrained=false;fs.writeFileSync(p,JSON.stringify(v))' "$tmp/tampered.json"
  READBACK=$tmp/tampered.json
  if (check_readback) >/dev/null 2>&1; then fail 'tampered post-restart receipt passed'; fi
  READBACK_SHA256=$(sha256_file "$READBACK")
  if (check_readback) >/dev/null 2>&1; then fail 'stale post-restart state passed'; fi
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
printf 'EDGE_PROVISIONING_SMOKE_OK ai_sha=%s mode=authenticated-execution\n' "$(json_value "$SEAL" ai sha)"
