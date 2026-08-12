#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)

fail() { printf '%s\n' "$1" >&2; exit 1; }
assert_not_contains() {
  label=$1
  source=$2
  fragment=$3
  case "$source" in *"$fragment"*) fail "$label still contains forbidden deployment backup contract: $fragment" ;; esac
}
assert_contains() {
  label=$1
  source=$2
  fragment=$3
  case "$source" in *"$fragment"*) ;; *) fail "$label is missing required contract: $fragment" ;; esac
}

jenkins=$(cat "$REPO_ROOT/Jenkinsfile")
readiness=$(cat "$REPO_ROOT/scripts/deploy/iwinv-overlap-readiness.sh")
deploy=$(cat "$REPO_ROOT/scripts/deploy/iwinv-deploy.sh")
env_example=$(cat "$REPO_ROOT/.env.host.prod.example")
seed=$(cat "$REPO_ROOT/scripts/deploy/jenkins-job-seed.groovy")
package_json=$(cat "$REPO_ROOT/package.json")
run_tests=$(cat "$REPO_ROOT/scripts/deploy/run-tests.sh")

for fragment in EVENT_MEDIA_BACKUP_DESTINATION EVENT_MEDIA_CLIP_VOLUME event-media-backup.sh; do
  assert_not_contains Jenkinsfile "$jenkins" "$fragment"
done
for fragment in MEDIA_RECEIPT media-backup.receipt seeon-event-media-backup; do
  assert_not_contains readiness "$readiness" "$fragment"
  assert_not_contains deploy "$deploy" "$fragment"
done
for fragment in EVENT_MEDIA_BACKUP_DESTINATION EVENT_MEDIA_CLIP_VOLUME; do
  assert_not_contains production-env-example "$env_example" "$fragment"
  assert_not_contains jenkins-job-seed "$seed" "$fragment"
done
env_verify=$(printf '%s\n' "$package_json" | sed -n '/"env:verify"/p')
assert_not_contains env-verify "$env_verify" 'event-media-backup-inputs.test.sh'
assert_contains package-scripts "$package_json" '"deploy:event-media:manual-test"'
assert_contains readiness "$readiness" 'verify-live-event-media-volume.sh'
assert_contains deploy "$deploy" 'verify-live-event-media-volume.sh'
assert_contains deploy "$deploy" 'verify-additive-migrations.sh'
assert_contains deploy-tests "$run_tests" 'Manual backup tooling has its own deploy:event-media:manual-test gate.'

printf '%s\n' 'iwinv deployment is independent of event-media backup tooling'
