#!/usr/bin/env sh
# shellcheck disable=SC2016 # Literal Jenkins/deploy variables are contract fixtures.
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
JENKINSFILE=$REPO_ROOT/Jenkinsfile
DEPLOY=$REPO_ROOT/scripts/deploy/iwinv-deploy.sh
CI_GATE=$REPO_ROOT/scripts/release/verify-github-ci-gate.sh
READINESS=$REPO_ROOT/scripts/deploy/iwinv-overlap-readiness.sh
MANUAL_MEDIA_BACKUP=$REPO_ROOT/scripts/deploy/event-media-backup.sh
CI_WORKFLOW=$REPO_ROOT/.github/workflows/ci.yml

fail() { printf '%s\n' "$1" >&2; exit 1; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "missing contract fragment: $2" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) fail "forbidden contract fragment: $2" ;; *) ;; esac; }
assert_order() {
  first=$(printf '%s\n' "$1" | grep -n -F "$2" | sed -n '1s/:.*//p')
  second=$(printf '%s\n' "$1" | grep -n -F "$3" | sed -n '1s/:.*//p')
  [ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt "$second" ] || fail "expected '$2' before '$3'"
}

[ -f "$CI_GATE" ] || fail 'GitHub ci-gate verifier is required'
[ -f "$READINESS" ] || fail 'overlap release readiness gate is required'
jenkins=$(cat "$JENKINSFILE")
deploy=$(cat "$DEPLOY")
ci_workflow=$(cat "$CI_WORKFLOW")

assert_contains "$ci_workflow" "'scripts/deploy/iwinv-overlap-smoke*.mjs'"
assert_contains "$jenkins" 'git@github.com:SeniorAILab/SeeON-Backend.git'
assert_not_contains "$jenkins" 'git@github.com:SeniorAILab/eldercare-fall-ai.git'
assert_contains "$jenkins" 'stage('\''Verify GitHub CI gate'\'')'
assert_contains "$jenkins" 'sh scripts/release/verify-github-ci-gate.sh "$RELEASE_SHA"'
assert_contains "$jenkins" 'stage('\''Validate release inputs'\'')'
assert_contains "$jenkins" 'sh scripts/deploy/iwinv-overlap-readiness.sh --pre-build "$RELEASE_SHA"'
assert_contains "$jenkins" 'stage('\''Build API ingress'\'')'
assert_contains "$jenkins" '--tag "eldercare-api-ingress:$RELEASE_SHA" --file infra/api-ingress/Dockerfile .'
assert_contains "$jenkins" 'sh infra/api-ingress/nginx-config.test.sh'
assert_contains "$jenkins" 'docker run --rm --entrypoint nginx "eldercare-api-ingress:$RELEASE_SHA" -t'
assert_contains "$jenkins" 'sh scripts/deploy/iwinv-overlap-readiness.sh --pre-deploy "$RELEASE_SHA"'
assert_contains "$jenkins" 'sh scripts/deploy/iwinv-deploy.sh --sha "$RELEASE_SHA"'
assert_not_contains "$jenkins" 'event-media-backup.sh'
assert_not_contains "$jenkins" 'EVENT_MEDIA_BACKUP_DESTINATION'
assert_not_contains "$jenkins" 'EVENT_MEDIA_CLIP_VOLUME'
assert_order "$jenkins" "stage('Verify GitHub CI gate')" "stage('Configure Buildx')"
assert_order "$jenkins" "stage('Validate release inputs')" "stage('Build backend')"
assert_order "$jenkins" "stage('Build API ingress')" "stage('Deploy')"
manual_media_backup=$(cat "$MANUAL_MEDIA_BACKUP")
assert_contains "$manual_media_backup" 'Manual standalone operator tool'
assert_contains "$manual_media_backup" 'FORMAT=seeon-event-media-backup-receipt-v1'
assert_contains "$manual_media_backup" 'MANIFEST_SHA256='
assert_order "$manual_media_backup" 'sh "$SCRIPT_DIR/validate-event-media-backup.sh" "$STAGE"' 'FORMAT=seeon-event-media-backup-receipt-v1'

# New schema-2 releases are backend-only; transitional frontend metadata remains
# readable for existing host-state validation and image-pruning protection.
assert_contains "$deploy" 'API_INGRESS_IMAGE=eldercare-api-ingress:$SHA'
assert_contains "$deploy" "FRONT_IMAGE=''"
assert_contains "$deploy" "HAS_FRONT=0"
assert_contains "$deploy" 'embedded_front_image'
assert_contains "$deploy" 'verify_deploy_receipts'
assert_not_contains "$deploy" 'MEDIA_RECEIPT'
assert_order "$deploy" '  verify_deploy_receipts' '    verify_candidate_migrations "$CURRENT_RELEASE_SHA" "$SHA"'
assert_order "$deploy" '    verify_candidate_migrations "$CURRENT_RELEASE_SHA" "$SHA"' 'verify-live-event-media-volume.sh'
assert_order "$deploy" 'verify-live-event-media-volume.sh' '  verify_image_ids'
assert_order "$deploy" 'if APP_DIR="$APP_DIR" sh "$migration_classifier" "$current_sha" "$candidate_sha"' 'transition_output=$(APP_DIR="$APP_DIR" RELEASE_DIR="$RELEASE_DIR"'
assert_order "$deploy" 'verify_edge_continuity' 'activate_manifest "$RELEASE_DIR/$SHA.json"'
assert_contains "$deploy" 'activate_manifest "$RELEASE_DIR/$SHA.json"
consume_history_transition_authorization
prune_release_manifests
prune_images'

printf '%s\n' 'overlap release integration contract tests passed'
