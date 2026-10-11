#!/usr/bin/env sh
# Contract tests for the plain deploy path: dump -> migrate -> up -> /health sha,
# plus the Jenkinsfile stages that drive it. Docker is mocked; everything else is real.
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/iwinv-deploy.sh
JENKINSFILE=$REPO_ROOT/Jenkinsfile
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

fail() { printf '%s\n' "$*" >&2; exit 1; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "missing expected output: $2
--- got:
$1";; esac; }
assert_not_contains() { case "$1" in *"$2"*) fail "unexpected output: $2";; esac; }
assert_order() { first=${1%%"$2"*}; [ "$first" != "$1" ] || fail "missing: $2"; rest=${1#*"$2"}; case "$rest" in *"$3"*) ;; *) fail "expected '$2' before '$3'";; esac; }

SHA=0123456789abcdef0123456789abcdef01234567
ROOT=$TMP/root
mkdir -p "$TMP/bin" "$ROOT/shared" "$ROOT/backups/db" "$ROOT/releases"
# Jenkins runs main's tooling from a temp dir against the release checkout (APP_DIR).
TOOLS=$TMP/tools
mkdir -p "$TOOLS"
cp "$SCRIPT" "$REPO_ROOT/scripts/deploy/controlled-compose.sh" "$REPO_ROOT/scripts/deploy/event-clip-runtime-env.sh" "$TOOLS/"
printf 'POSTGRES_USER=x\n' > "$ROOT/shared/.env"; chmod 600 "$ROOT/shared/.env"
cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env sh
printf 'docker %s\n' "$*" >> "$MOCK_LOG"
case "$*" in
  'image inspect '*) [ -z "${MOCK_MISSING_IMAGE:-}" ] || exit 1 ;;
  'images --format '*' eldercare-backend') printf 'eldercare-backend:%s\n' "$MOCK_SHA" old4 old3 old2 old1 ;;
  'images --format '*) ;;
  *'pg_dump'*) printf 'PGDMP' ;;
  *'prisma migrate deploy'*) [ "${MOCK_MIGRATE_FAIL:-0}" != 1 ] || exit 1 ;;
  *'wget -q -T 5 -O - http://127.0.0.1:3000/health'*)
    [ -z "${MOCK_HEALTH_DELAY:-}" ] || sleep "$MOCK_HEALTH_DELAY"
    printf '{"status":"ok","sha":"%s","database":"ok"}\n' "${MOCK_HEALTH_SHA:-$MOCK_SHA}"
    [ "${MOCK_HEALTH_FAIL:-0}" != 1 ] || exit 1 ;;
  *'SELECT CASE WHEN'*) printf '%s\n' "${MOCK_AUTHZ:-ok}" ;;
esac
EOF
chmod +x "$TMP/bin/docker"

deploy() {
  PATH="$TMP/bin:$PATH" MOCK_LOG="$TMP/docker.log" MOCK_SHA="$SHA" APP_ROOT="$ROOT" APP_DIR="$REPO_ROOT" \
    HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-120}" sh "$TOOLS/iwinv-deploy.sh" "$@" 2>&1
}
run_failing() { set +e; output=$(deploy "$@"); status=$?; set -e; [ "$status" -ne 0 ] || fail "deploy unexpectedly passed: $*"; }
docker_log() { cat "$TMP/docker.log"; }

# Usage is strict and the lock is released on every exit.
run_failing --sha not-a-sha; assert_contains "$output" 'SHA must be exactly 40 lowercase hexadecimal characters.'
run_failing --restore-db "$TMP/x.dump"; assert_contains "$output" '--restore-db requires <dump> --ack-data-loss.'
mkdir "$ROOT/shared/deploy.lock"
run_failing --sha "$SHA"; assert_contains "$output" 'Another deployment is already running'
rmdir "$ROOT/shared/deploy.lock"

# Success: leftover release-state files from the old pipeline are ignored and untouched.
printf '{"sha":"e9ba287204ba8bb2dce0f55cceecc6661fd5f4b5","pre_migration_dump":"normal-old.dump"}\n' > "$ROOT/releases/pending.json"
printf 'stale\n' > "$ROOT/releases/current.json"
: > "$ROOT/backups/db/normal-old.dump"
for n in 1 2 3 4 5 6; do : > "$ROOT/backups/db/deploy-20260101T00000${n}Z-old.dump"; done
cp "$ROOT/releases/pending.json" "$TMP/pending.before"
PREV_SHA=e9ba287204ba8bb2dce0f55cceecc6661fd5f4b5
printf 'BACKEND_IMAGE=eldercare-backend:%s\nAPI_INGRESS_IMAGE=eldercare-api-ingress:%s\n' "$PREV_SHA" "$PREV_SHA" > "$ROOT/shared/release-images.env"
cp "$ROOT/shared/release-images.env" "$TMP/prev-images.env"
: > "$TMP/docker.log"
output=$(deploy --sha "$SHA")
log=$(docker_log)
assert_contains "$output" "Deploy complete. sha=$SHA"
[ "$(cat "$ROOT/shared/release-images.env")" = "BACKEND_IMAGE=eldercare-backend:$SHA
API_INGRESS_IMAGE=eldercare-api-ingress:$SHA" ] || fail 'release image env is not exactly the release tags'
[ "$(stat -c '%a' "$ROOT/shared/release-images.env")" = 600 ] || fail 'release image env is not owner-only'
assert_order "$log" 'compose' 'stop api-ingress backend'
assert_order "$log" 'pg_dump' 'prisma migrate deploy'
assert_order "$log" 'prisma migrate deploy' 'seed-super-admin.js'
assert_order "$log" 'seed-super-admin.js' 'up -d --wait --wait-timeout 120 backend api-ingress'
assert_order "$log" 'up -d --wait --wait-timeout 120 backend api-ingress' 'wget -q -T 5 -O - http://127.0.0.1:3000/health'
assert_contains "$log" '--env-file '"$ROOT"'/shared/release-images.env -f compose.yaml -f compose.prod.yaml'
assert_not_contains "$log" 'pg_restore --username'
cmp -s "$TMP/pending.before" "$ROOT/releases/pending.json" || fail 'leftover pending.json was modified'
[ "$(cat "$ROOT/releases/current.json")" = stale ] || fail 'leftover current.json was modified'
[ ! -d "$ROOT/shared/deploy.lock" ] || fail 'lock not released after success'
# Dump retention: newest 5 deploy-*.dump kept, other dumps never touched.
[ "$(find "$ROOT/backups/db" -name 'deploy-*.dump' | wc -l)" -eq 5 ] || fail 'deploy dump retention is not 5'
find "$ROOT/backups/db" -name "deploy-*-$SHA.dump" -size +0 | grep -q . || fail 'new deploy dump missing'
NEW_DUMP=$(find "$ROOT/backups/db" -name "deploy-*-$SHA.dump")
cmp -s "$TMP/prev-images.env" "$NEW_DUMP.images.env" || fail 'dump does not record the pre-deploy images'
[ ! -e "$ROOT/backups/db/deploy-20260101T000001Z-old.dump" ] && [ ! -e "$ROOT/backups/db/deploy-20260101T000002Z-old.dump" ] || fail 'oldest dumps not rotated'
[ -e "$ROOT/backups/db/normal-old.dump" ] || fail 'non-deploy dump was removed'
# Image retention: current + 2 newest others kept; never a broad prune.
assert_not_contains "$log" "image rm eldercare-backend:$SHA"
assert_not_contains "$log" 'image rm eldercare-backend:old4'
assert_not_contains "$log" 'image rm eldercare-backend:old3'
assert_contains "$log" 'image rm eldercare-backend:old2'
assert_contains "$log" 'image rm eldercare-backend:old1'
assert_not_contains "$log" 'prune'

# The emergency event-clip override is the last env file, so it wins over the base env.
printf 'EVENT_CLIPS_ENABLED=false\n' > "$ROOT/shared/event-clips-runtime.env"; chmod 600 "$ROOT/shared/event-clips-runtime.env"
: > "$TMP/docker.log"
deploy --sha "$SHA" >/dev/null
assert_contains "$(docker_log)" "--env-file $ROOT/shared/.env --env-file $ROOT/shared/release-images.env --env-file $ROOT/shared/event-clips-runtime.env -f compose.yaml"
rm -f "$ROOT/shared/event-clips-runtime.env"

# Missing images: refuse before stopping anything or dumping.
: > "$TMP/docker.log"
MOCK_MISSING_IMAGE=1 run_failing --sha "$SHA"
assert_contains "$output" "Release images for $SHA are not built."
assert_not_contains "$(docker_log)" 'stop api-ingress backend'
assert_not_contains "$output" '--restore-db'

# Migration failure: app is not started, DB is not auto-restored, exact restore command printed.
: > "$TMP/docker.log"
MOCK_MIGRATE_FAIL=1 run_failing --sha "$SHA"
log=$(docker_log)
assert_not_contains "$log" 'up -d --wait --wait-timeout 120 backend api-ingress'
assert_not_contains "$log" 'pg_restore --username'
assert_contains "$output" 'The database is NOT restored automatically.'
assert_contains "$output" 'RELEASE_TAG=<previous tag>'
assert_contains "$output" "sh scripts/deploy/iwinv-deploy.sh --restore-db $ROOT/backups/db/deploy-"
[ ! -d "$ROOT/shared/deploy.lock" ] || fail 'lock not released after migrate failure'

# /health never reports the release SHA: bounded wait, then fail with the same hint.
: > "$TMP/docker.log"
MOCK_HEALTH_SHA=e9ba287204ba8bb2dce0f55cceecc6661fd5f4b5 HEALTH_TIMEOUT_SECONDS=1 run_failing --sha "$SHA"
assert_contains "$output" "Health did not report $SHA within 1s (last sha=e9ba287204ba8bb2dce0f55cceecc6661fd5f4b5)."
assert_contains "$output" '--restore-db'
assert_not_contains "$(docker_log)" 'image rm'
# A matching response that arrives after the window is not accepted.
: > "$TMP/docker.log"
MOCK_HEALTH_DELAY=2 HEALTH_TIMEOUT_SECONDS=1 run_failing --sha "$SHA"
assert_contains "$output" "Health did not report $SHA within 1s (last sha=$SHA)."
assert_not_contains "$(docker_log)" 'image rm'
# A failed probe never counts, even if it printed the matching SHA.
: > "$TMP/docker.log"
MOCK_HEALTH_FAIL=1 HEALTH_TIMEOUT_SECONDS=1 run_failing --sha "$SHA"
assert_contains "$output" "Health did not report $SHA within 1s (last sha=none)."
[ ! -d "$ROOT/shared/deploy.lock" ] || fail 'lock not released after health timeout'

# Explicit operator restore: restarts the images live when the dump was taken
# (not the failed candidate), restores, re-applies the event ACL, verifies authorization.
: > "$TMP/restore.dump"
cp "$TMP/prev-images.env" "$TMP/restore.dump.images.env"
: > "$TMP/docker.log"
output=$(deploy --restore-db "$TMP/restore.dump" --ack-data-loss)
log=$(docker_log)
cmp -s "$TMP/prev-images.env" "$ROOT/shared/release-images.env" || fail 'restore did not reinstate the pre-deploy images'
assert_contains "$output" "eldercare-backend:$PREV_SHA"
assert_contains "$output" "Database restore complete from $TMP/restore.dump."
assert_order "$log" 'stop api-ingress backend' 'pg_restore --username'
assert_order "$log" 'pg_restore --username' 'REVOKE UPDATE, DELETE ON public.events FROM fall_app'
assert_order "$log" 'SELECT CASE WHEN' 'up -d --wait --wait-timeout 120 backend api-ingress'
# A broken authorization invariant fails and does not restart the app.
: > "$TMP/docker.log"
MOCK_AUTHZ=fall_app_can_update_events run_failing --restore-db "$TMP/restore.dump" --ack-data-loss
assert_contains "$output" 'Post-restore authorization invariant failed: fall_app_can_update_events'
assert_not_contains "$(docker_log)" 'up -d --wait --wait-timeout 120 backend api-ingress'

# The deploy never touches Docker volumes or event-media backup tooling.
deploy_source=$(cat "$SCRIPT")
for forbidden in 'volume rm' 'down -v' 'system prune' 'event-media-backup' 'current.json' 'pending.json'; do
  assert_not_contains "$deploy_source" "$forbidden"
done
[ "$(wc -l < "$SCRIPT")" -lt 150 ] || fail 'deploy helper must stay under 150 lines'

# Jenkinsfile: resolve -> CI gate -> build -> deploy, and nothing else blocks.
jenkins=$(cat "$JENKINSFILE")
seed=$(cat "$REPO_ROOT/scripts/deploy/jenkins-job-seed.groovy")
assert_contains "$jenkins" "string(name: 'RELEASE_TAG', defaultValue: ''"
assert_contains "$jenkins" 'RELEASE_TAG="$REQUESTED_RELEASE_TAG" sh "$WORKSPACE/.iwinv-resolve-release.jenkins.sh"'
assert_contains "$jenkins" "sshagent(credentials: ['seeon-backend-github-deploy-key'])"
assert_contains "$jenkins" "repository='git@github.com:SeniorAILab/SeeON-Backend.git'"
assert_contains "$jenkins" 'verify-github-ci-gate.sh "$RELEASE_SHA"'
assert_contains "$jenkins" '--tag "eldercare-backend:$RELEASE_SHA"'
assert_contains "$jenkins" '--tag "eldercare-api-ingress:$RELEASE_SHA"'
assert_contains "$jenkins" "lock(resource: 'eldercare-fall-ai-deploy')"
assert_contains "$jenkins" 'emailext('
assert_contains "$jenkins" "\${env.RELEASE_SHA ?: 'unresolved'}"
assert_order "$jenkins" "stage('Resolve release')" "stage('Verify GitHub CI gate')"
assert_order "$jenkins" "stage('Verify GitHub CI gate')" "stage('Build backend')"
assert_order "$jenkins" "stage('Build API ingress')" "stage('Deploy')"
[ "$(printf '%s\n' "$jenkins" | grep -c -F 'APP_DIR="$WORKSPACE" sh "$tools/scripts/deploy/iwinv-deploy.sh" --sha "$RELEASE_SHA"')" -eq 1 ] || fail 'expected exactly one deploy invocation'
assert_order "$jenkins" 'git archive refs/remotes/origin/main scripts/deploy' 'APP_DIR="$WORKSPACE" sh "$tools/scripts/deploy/iwinv-deploy.sh"'
[ "$(printf '%s\n' "$jenkins" | grep -c "stage('")" -eq 6 ] || fail 'Jenkinsfile must have exactly 6 stages'
for forbidden in NO_OP overlap-readiness preflight-only RELEASES_DIR eldercare-front GHCR ghcr.io 'docker push' 'docker pull' event-media-backup.sh; do
  assert_not_contains "$jenkins" "$forbidden"
done
assert_contains "$seed" "pipelineJob('eldercare-fall-ai-cd')"
assert_contains "$seed" "credentials('seeon-backend-github-deploy-key')"
assert_contains "$seed" "tokenCredentialId('eldercare-webhook-token')"
assert_contains "$seed" 'printPostContent(false)'
compose_prod=$(cat "$REPO_ROOT/compose.prod.yaml")
assert_contains "$compose_prod" 'SMTP_SECURE: ${SMTP_SECURE-}'

printf 'iwinv deploy contract tests passed\n'
