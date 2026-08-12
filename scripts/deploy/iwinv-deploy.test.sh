#!/usr/bin/env sh
# shellcheck disable=SC2016 # Literal shell source contracts are asserted below.
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/iwinv-deploy.sh
JENKINSFILE=$REPO_ROOT/Jenkinsfile
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/bin" "$TMP/root/shared" "$TMP/root/backups/db" "$TMP/root/releases"

cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env sh
log=${MOCK_LOG:-}
[ -z "$log" ] || printf '%s\n' "docker $*" >> "$log"
if [ "${1:-}" = images ]; then
  [ "${MOCK_IMAGES_FAIL:-0}" != 1 ] || exit 1
  printf '%s\n' "eldercare-backend:${MOCK_SHA}" "eldercare-api-ingress:${MOCK_SHA}" "eldercare-front:${MOCK_SHA}" "eldercare-backend:cccccccccccccccccccccccccccccccccccccccc" "eldercare-api-ingress:cccccccccccccccccccccccccccccccccccccccc"
  exit 0
fi
if [ "${1:-}" = image ] && [ "${2:-}" = inspect ]; then
  image=${5:-}
  image_sha=${MOCK_IMAGE_ID_SHA:-${image#*:}}
  case "$image" in
    eldercare-backend:*) printf 'sha256:backend-%s\n' "$image_sha" ;;
    eldercare-api-ingress:*) printf 'sha256:api-ingress-%s\n' "$image_sha" ;;
    eldercare-front:*) printf 'sha256:front-%s\n' "$image_sha" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "${1:-}" = image ] && [ "${2:-}" = rm ]; then
  [ "${MOCK_IMAGE_RM_FAIL:-0}" != 1 ] || exit 1
  exit 0
fi
if [ "${1:-}" = compose ]; then
  case " $* " in
    *pg_dump*) [ "${MOCK_PGDUMP_FAIL:-0}" != 1 ] || exit 1; printf 'mock dump\n' ;;
    *'pg_restore --list'*) [ "${MOCK_RESTORE_LIST_FAIL:-0}" != 1 ] || exit 1 ;;
    *'pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --clean --if-exists --no-owner --exit-on-error --single-transaction'*) ;;
    *has_table_privilege*) printf '%s\n' "${MOCK_AUTH_RESULT:-ok}" ;;
    *psql*) printf '0\n' ;;
    *'exec -T db sh'*) ;;
    *'front wget'*)
      [ "${MOCK_FRONT_UNREACHABLE:-0}" != 1 ] || exit 1
      printf '%s\n' "${MOCK_FRONT_VERSION:-$MOCK_SHA}" ;;
    *'api-ingress wget'*)
      [ "${MOCK_INGRESS_FAIL:-0}" != 1 ] || exit 1
      printf '{"sha":"%s","database":"ok"}\n' "$MOCK_SHA" ;;
    *'backend node'*)
      if [ "${MOCK_BACKEND_FAIL:-0}" = 1 ]; then printf 'status=503\nbody={"sha":"wrong","database":"down"}\n'; exit 1; fi
      printf 'status=200\nbody={"sha":"%s","database":"ok"}\n' "$MOCK_SHA" ;;
    *' config '*) ;;
    *' pull db '*) ;;
    *' up -d --wait --wait-timeout 120 db '*) ;;
    *' ps -q --status running backend '*) ;;
    *' up -d --wait --wait-timeout 120 backend api-ingress front '*) [ "${MOCK_APP_START_FAIL:-0}" != 1 ] || exit 1 ;;
    *' up -d --wait --wait-timeout 120 backend api-ingress '*) [ "${MOCK_APP_START_FAIL:-0}" != 1 ] || exit 1 ;;
    *' up -d --wait --wait-timeout 120 backend front '*) [ "${MOCK_APP_START_FAIL:-0}" != 1 ] || exit 1 ;;
    *' stop front api-ingress backend '*) ;;
    *'prisma migrate deploy'*) [ "${MOCK_MIGRATE_FAIL:-0}" != 1 ] || exit 1 ;;
    *'seed-super-admin.js'*) ;;
    *) printf 'unexpected docker compose command: %s\n' "$*" >&2; exit 1 ;;
  esac
  exit 0
fi
exit 1
EOF
cat > "$TMP/bin/free" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' 'Mem: 6144 1024 1024 0 4096 4096' 'Swap: 4096 0 4096'
EOF
cat > "$TMP/bin/sha256sum" <<'EOF'
#!/usr/bin/env sh
printf '%s  %s\n' '0000000000000000000000000000000000000000000000000000000000000000' "${1:--}"
EOF
cat > "$TMP/bin/rmdir" <<'EOF'
#!/usr/bin/env sh
[ "${FAIL_RMDIR:-0}" != 1 ] || exit 1
exec /bin/rmdir "$@"
EOF
chmod +x "$TMP/bin/docker" "$TMP/bin/free" "$TMP/bin/sha256sum" "$TMP/bin/rmdir"

cat > "$TMP/host.env" <<'EOF'
POSTGRES_USER=fall
POSTGRES_PASSWORD=test
POSTGRES_DB=fall_prod
APP_DB_USER=fall_app
APP_DB_PASSWORD=test
DATABASE_URL=postgresql://fall_app:test@db/fall_prod
DIRECT_URL=postgresql://fall:test@db/fall_prod
FRONT_ORIGIN=http://localhost:3000
ALERT_DASHBOARD_URL=http://localhost:3000
SESSION_JWT_SECRET=secret
SMTP_HOST=mail
SMTP_USER=user
SMTP_PASSWORD=password
EDGE_FACILITY_TOKEN=token
EOF

SHA=0123456789abcdef0123456789abcdef01234567
ROLLBACK_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
CURRENT_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
manifest() {
  printf '{"sha":"%s","backend_image":"eldercare-backend:%s","backend_image_id":"sha256:backend-%s","front_image":"eldercare-front:%s","front_image_id":"sha256:front-%s","compose_sha256":"compose","env_sha256":"env","pre_migration_dump":"normal-test.dump","timestamp":"2026-07-11T00:00:00Z"}\n' "$1" "$1" "$1" "$1" "$1"
}
schema_two_manifest() {
  printf '{"schema":"2","sha":"%s","backend_image":"eldercare-backend:%s","backend_image_id":"sha256:backend-%s","api_ingress_image":"eldercare-api-ingress:%s","api_ingress_image_id":"sha256:api-ingress-%s","embedded_front_image":"eldercare-front:%s","embedded_front_image_id":"sha256:front-%s","compose_sha256":"compose","env_sha256":"env","pre_migration_dump":"normal-test.dump","timestamp":"2026-08-12T00:00:00Z"}\n' "$1" "$1" "$1" "$1" "$1" "$1" "$1"
}
schema_two_backend_ingress_manifest() {
  printf '{"schema":"2","sha":"%s","backend_image":"eldercare-backend:%s","backend_image_id":"sha256:backend-%s","api_ingress_image":"eldercare-api-ingress:%s","api_ingress_image_id":"sha256:api-ingress-%s","compose_sha256":"compose","env_sha256":"env","pre_migration_dump":"normal-test.dump","timestamp":"2026-08-12T00:00:00Z"}\n' "$1" "$1" "$1" "$1" "$1"
}
pointer() {
  manifest "$1" > "$TMP/root/releases/$1.json"
  cp "$TMP/root/releases/$1.json" "$TMP/root/releases/$2.json"
  : > "$TMP/root/backups/db/normal-test.dump"
}
manifest_with_dump() {
  dump=$2
  printf '{"sha":"%s","backend_image":"eldercare-backend:%s","backend_image_id":"sha256:backend-%s","front_image":"eldercare-front:%s","front_image_id":"sha256:front-%s","compose_sha256":"compose","env_sha256":"env","pre_migration_dump":"%s","timestamp":"2026-07-11T00:00:00Z"}\n' "$1" "$1" "$1" "$1" "$1" "$dump"
}
pointer_with_dump() {
  manifest_with_dump "$1" "$3" > "$TMP/root/releases/$1.json"
  cp "$TMP/root/releases/$1.json" "$TMP/root/releases/$2.json"
  : > "$TMP/root/backups/db/$3"
}
run_deploy() {
  PATH="$TMP/bin:$PATH" APP_ROOT="$TMP/root" APP_DIR="$REPO_ROOT" ENV_FILE="$TMP/host.env" \
  MEMORY_MIN_MB="${TEST_MEMORY_MIN_MB:-1}" DISK_MIN_MB=1 MOCK_SHA="${MOCK_SHA:-$SHA}" MOCK_LOG="$TMP/mock.log" \
  sh "$SCRIPT" "$@" 2>&1
}
assert_contains() { case "$1" in *"$2"*) ;; *) printf 'missing expected output: %s\n%s\n' "$2" "$1" >&2; exit 1;; esac; }
assert_not_contains() { case "$1" in *"$2"*) printf 'unexpected output: %s\n%s\n' "$2" "$1" >&2; exit 1;; *) ;; esac; }
assert_failure() { [ "$1" -ne 0 ] || { printf 'command unexpectedly passed\n' >&2; exit 1; }; }
assert_order() {
  first=$(printf '%s\n' "$1" | grep -n -F "$2" | sed -n '1s/:.*//p')
  second=$(printf '%s\n' "$1" | grep -n -F "$3" | sed -n '1s/:.*//p')
  [ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt "$second" ] || {
    printf 'expected command ordering %s before %s\n%s\n' "$2" "$3" "$1" >&2
    exit 1
  }
}
release_state() {
  (
    cd "$TMP/root/releases"
    for release_file in ./*.json; do
      [ -f "$release_file" ] && cksum "$release_file"
    done | sort
  )
}

# Source-controlled webhook contract keeps the credential and quiet logging without webhook payload parsing.
jenkins=$(sed -n '1,120p' "$JENKINSFILE")
assert_contains "$jenkins" "tokenCredentialId: 'eldercare-webhook-token'"
assert_contains "$jenkins" 'printContributedVariables: false'
assert_contains "$jenkins" 'printPostContent: false'
assert_not_contains "$jenkins" '$.workflow_run.head_sha'
assert_not_contains "$jenkins" '$.ref'
assert_not_contains "$jenkins" 'regexpFilterExpression'
assert_not_contains "$jenkins" "string(name: 'REF'"
# Jenkins materializes the resolver from origin/main before executing it, so a stale deployment checkout cannot select release logic.
assert_contains "$jenkins" 'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main'
assert_contains "$jenkins" 'git show refs/remotes/origin/main:scripts/deploy/iwinv-resolve-release.sh > "$WORKSPACE/.iwinv-resolve-release.jenkins.sh"'
assert_contains "$jenkins" 'RELEASES_DIR="$DEPLOY_ROOT/releases" sh "$WORKSPACE/.iwinv-resolve-release.jenkins.sh"'
assert_contains "$jenkins" 'rm -f "$WORKSPACE/.iwinv-resolve-release.jenkins.sh"'
# Resolver output parsing accepts only the expected keys and validates every value.
assert_contains "$jenkins" 'def match = line =~ /^(RELEASE_TAG|RELEASE_SHA|NO_OP)=(.*)$/'
assert_contains "$jenkins" 'Resolver output contains duplicate ${key}'
assert_contains "$jenkins" 'releaseValues.RELEASE_SHA ==~ /[0-9a-f]{40}/'
assert_contains "$jenkins" "['0', '1'].contains(releaseValues.NO_OP)"
assert_contains "$jenkins" 'releaseValues.RELEASE_TAG ==~ /v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)/'

# Strict mode parser rejects duplicate and conflicting primary modes before any Docker command.
: > "$TMP/mock.log"
set +e
output=$(run_deploy --sha "$SHA" --sha "$SHA" --dry-run); status=$?
set -e
assert_failure "$status"; assert_not_contains "$output" 'docker compose'
set +e
output=$(run_deploy --sha "$SHA" --rollback --dry-run); status=$?
set -e
assert_failure "$status"; assert_not_contains "$output" 'docker compose'
: > "$TMP/mock.log"
set +e
output=$(run_deploy --restore-db "$TMP/restore.dump"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" '--restore-db requires --ack-data-loss.'
log=$(sed -n '1,200p' "$TMP/mock.log")
assert_not_contains "$log" 'docker '
# Preflight-only is mutually exclusive with every operational flag and fails before side effects.
assert_preflight_mixed() {
  : > "$TMP/mock.log"
  set +e
  output=$(run_deploy --preflight-only "$@"); status=$?
  set -e
  assert_failure "$status"
  assert_contains "$output" 'Usage: iwinv-deploy.sh'
  [ ! -s "$TMP/mock.log" ] || { printf 'preflight mixed mode invoked Docker: %s\n' "$*" >&2; exit 1; }
  [ ! -e "$TMP/root/shared/deploy.lock" ] || { printf 'preflight mixed mode acquired lock: %s\n' "$*" >&2; exit 1; }
}
assert_preflight_mixed --sha "$SHA"
assert_preflight_mixed --rollback
assert_preflight_mixed --restore-db "$TMP/restore.dump"
assert_preflight_mixed --ack-data-loss
assert_preflight_mixed --dry-run

# Dry-run exposes the db-only pull, protected-image pruning, retention, and preflight gates.
output=$(run_deploy --sha "$SHA" --dry-run)
assert_contains "$output" 'compose pull db'
assert_not_contains "$output" 'compose pull backend'
assert_not_contains "$output" 'compose pull front'
assert_contains "$output" "would verify exact local images eldercare-backend:$SHA, eldercare-api-ingress:$SHA, and eldercare-front:$SHA"
assert_contains "$output" 'would create and validate pre-migration dump'
assert_contains "$output" 'would sync app role, assert Prisma tracking, run migrate deploy, and bootstrap super-admin'
assert_not_contains "$output" "docker image rm eldercare-backend:$SHA"
assert_not_contains "$output" "docker image rm eldercare-front:$SHA"
# Normal deploy rejects a preexisting target manifest or current SHA before Docker, backups, or database work.
manifest "$SHA" > "$TMP/root/releases/$SHA.json"
: > "$TMP/mock.log"
set +e
output=$(run_deploy --sha "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Immutable release manifest already exists'
log=$(sed -n '1,200p' "$TMP/mock.log")
assert_not_contains "$log" 'docker '
rm -f "$TMP/root/releases/$SHA.json"
pointer "$SHA" current
: > "$TMP/mock.log"
set +e
output=$(run_deploy --sha "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Refusing deploy of already-current SHA'
log=$(sed -n '1,200p' "$TMP/mock.log")
assert_not_contains "$log" 'docker '
rm -f "$TMP/root/releases/current.json" "$TMP/root/releases/$SHA.json"

set +e
output=$(TEST_MEMORY_MIN_MB=999999 run_deploy --sha "$SHA" --dry-run); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'Insufficient available memory plus swap'
assert_not_contains "$output" 'compose pull db'

for index in 01 02 03 04 05 06 07; do
  : > "$TMP/root/backups/db/normal-20260711-0000${index}-$SHA.dump"
done
baseline=baseline-20260711-$SHA.dump
: > "$TMP/root/backups/db/$baseline"
printf '%s\n' "$baseline" > "$TMP/root/backups/db/baseline.marker"
output=$(run_deploy --sha "$SHA" --dry-run)
assert_contains "$output" "would remove $TMP/root/backups/db/normal-20260711-000001-$SHA.dump"
assert_contains "$output" "would remove $TMP/root/backups/db/normal-20260711-000002-$SHA.dump"
assert_not_contains "$output" "would remove $TMP/root/backups/db/$baseline"

# Requested rollback SHA must match the immutable manifest, not merely its filename.
pointer "$CURRENT_SHA" current
manifest "$SHA" > "$TMP/root/releases/$ROLLBACK_SHA.json"
set +e
output=$(run_deploy --rollback "$ROLLBACK_SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Rollback manifest SHA does not match requested SHA'

# A schema-2 current pointer can roll back through a schema-1 previous pointer.
schema_two_manifest "$CURRENT_SHA" > "$TMP/root/releases/$CURRENT_SHA.json"
cp "$TMP/root/releases/$CURRENT_SHA.json" "$TMP/root/releases/current.json"
manifest "$ROLLBACK_SHA" > "$TMP/root/releases/$ROLLBACK_SHA.json"
cp "$TMP/root/releases/$ROLLBACK_SHA.json" "$TMP/root/releases/previous.json"
: > "$TMP/mock.log"
output=$(MOCK_SHA="$ROLLBACK_SHA" run_deploy --rollback)
assert_contains "$output" 'compose up -d --wait --wait-timeout 120 backend front'
cmp -s "$TMP/root/releases/$ROLLBACK_SHA.json" "$TMP/root/releases/current.json"
cmp -s "$TMP/root/releases/$CURRENT_SHA.json" "$TMP/root/releases/previous.json"
log=$(sed -n '1,240p' "$TMP/mock.log")
assert_contains "$log" 'image inspect --format {{.Id}} eldercare-backend:'
assert_contains "$log" 'image inspect --format {{.Id}} eldercare-front:'
assert_not_contains "$log" 'image inspect --format {{.Id}} eldercare-api-ingress:'
assert_contains "$log" 'image rm eldercare-api-ingress:cccccccccccccccccccccccccccccccccccccccc'

# Schema-2 without a transitional front starts and probes only backend + ingress.
schema_two_manifest "$CURRENT_SHA" > "$TMP/root/releases/$CURRENT_SHA.json"
cp "$TMP/root/releases/$CURRENT_SHA.json" "$TMP/root/releases/current.json"
schema_two_backend_ingress_manifest "$ROLLBACK_SHA" > "$TMP/root/releases/$ROLLBACK_SHA.json"
cp "$TMP/root/releases/$ROLLBACK_SHA.json" "$TMP/root/releases/previous.json"
: > "$TMP/mock.log"
set +e
output=$(MOCK_INGRESS_FAIL=1 MOCK_SHA="$ROLLBACK_SHA" run_deploy --rollback); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'API ingress health request failed'
log=$(sed -n '1,240p' "$TMP/mock.log")
ingress_health_calls=$(printf '%s\n' "$log" | grep -c 'api-ingress wget' || :)
[ "$ingress_health_calls" -eq 1 ] || { printf 'expected exactly one API ingress health attempt, got %s\n' "$ingress_health_calls" >&2; exit 1; }
: > "$TMP/mock.log"
output=$(MOCK_SHA="$ROLLBACK_SHA" run_deploy --rollback)
assert_contains "$output" 'compose up -d --wait --wait-timeout 120 backend api-ingress'
assert_not_contains "$output" 'backend api-ingress front'
log=$(sed -n '1,240p' "$TMP/mock.log")
assert_contains "$log" 'api-ingress wget'
assert_not_contains "$log" 'front wget'

# Unknown schema fails before Docker, DB, release-env, or pointer mutation.
schema_two_manifest "$CURRENT_SHA" | sed 's/"schema":"2"/"schema":"3"/' > "$TMP/root/releases/$CURRENT_SHA.json"
cp "$TMP/root/releases/$CURRENT_SHA.json" "$TMP/root/releases/current.json"
cp "$TMP/root/releases/current.json" "$TMP/current.before-unknown-schema"
printf 'BACKEND_IMAGE=sentinel\nAPI_INGRESS_IMAGE=sentinel\nFRONT_IMAGE=sentinel\n' > "$TMP/root/shared/release-images.env"
cp "$TMP/root/shared/release-images.env" "$TMP/release-env.before-unknown-schema"
: > "$TMP/mock.log"
set +e
output=$(run_deploy --sha "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Unsupported release manifest schema'
[ ! -s "$TMP/mock.log" ]
cmp -s "$TMP/current.before-unknown-schema" "$TMP/root/releases/current.json"
cmp -s "$TMP/release-env.before-unknown-schema" "$TMP/root/shared/release-images.env"
# Restore a valid independent previous pointer for the remaining scenarios.
pointer "$ROLLBACK_SHA" previous

# Restore proves target code images before validating or restoring the database.
pointer "$SHA" current
: > "$TMP/restore.dump"; : > "$TMP/mock.log"
set +e
output=$(MOCK_IMAGE_ID_SHA="$ROLLBACK_SHA" run_deploy --restore-db "$TMP/restore.dump" --ack-data-loss); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Backend image ID differs from manifest'
log=$(sed -n '1,200p' "$TMP/mock.log")
assert_not_contains "$log" 'pg_restore --clean'

# Restore always recreates the runtime role, restores dump ACLs, and verifies authorization invariants.
: > "$TMP/mock.log"
output=$(run_deploy --restore-db "$TMP/restore.dump" --ack-data-loss)
log=$(sed -n '1,240p' "$TMP/mock.log")
assert_contains "$log" 'pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --clean --if-exists --no-owner --exit-on-error --single-transaction'
assert_not_contains "$log" '--no-privileges'
assert_contains "$log" 'exec -T db sh'
assert_contains "$log" 'has_table_privilege'
assert_contains "$output" 'compose up -d --wait --wait-timeout 120 backend front'
assert_order "$log" 'exec -T db sh' 'pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"'
assert_order "$log" 'pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"' 'has_table_privilege'
: > "$TMP/mock.log"
set +e
output=$(MOCK_AUTH_RESULT=invalid run_deploy --restore-db "$TMP/restore.dump" --ack-data-loss); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Post-restore authorization invariant failed: invalid'
log=$(sed -n '1,240p' "$TMP/mock.log")
assert_order "$log" 'exec -T db sh' 'pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"'
assert_order "$log" 'pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"' 'has_table_privilege'
assert_not_contains "$log" 'up -d --wait --wait-timeout 120 backend front'

# Rollback plus acknowledged restore executes the same authorization-preserving restore before starting target code.
manifest "$ROLLBACK_SHA" > "$TMP/root/releases/$ROLLBACK_SHA.json"
: > "$TMP/mock.log"
output=$(MOCK_SHA="$ROLLBACK_SHA" run_deploy --rollback "$ROLLBACK_SHA" --restore-db "$TMP/restore.dump" --ack-data-loss)
log=$(sed -n '1,240p' "$TMP/mock.log")
assert_contains "$log" 'pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --clean --if-exists --no-owner --exit-on-error --single-transaction'
assert_not_contains "$log" '--no-privileges'
assert_contains "$log" 'has_function_privilege'
assert_contains "$output" 'compose up -d --wait --wait-timeout 120 backend front'
manifest "$SHA" > "$TMP/root/releases/$SHA.json"
# The post-readiness check is one attempt and includes the backend HTTP/body diagnostic.
: > "$TMP/mock.log"
set +e
output=$(MOCK_BACKEND_FAIL=1 run_deploy --rollback "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Backend exact-SHA health verification failed'
assert_contains "$output" 'status=503'; assert_contains "$output" 'body={"sha":"wrong","database":"down"}'
log=$(sed -n '1,200p' "$TMP/mock.log")
health_calls=$(printf '%s\n' "$log" | grep -c 'backend node' || :)
[ "$health_calls" -eq 1 ] || { printf 'expected exactly one backend health attempt, got %s\n' "$health_calls" >&2; exit 1; }
# A wrong or malformed frontend version fails after one request and includes the response diagnostic.
for front_version in "$ROLLBACK_SHA" 'not-a-sha'; do
  : > "$TMP/mock.log"
  set +e
  output=$(MOCK_FRONT_VERSION="$front_version" run_deploy --rollback "$SHA"); status=$?
  set -e
  assert_failure "$status"; assert_contains "$output" 'Frontend exact-SHA verification failed'
  assert_contains "$output" "$front_version"
  log=$(sed -n '1,200p' "$TMP/mock.log")
  front_version_calls=$(printf '%s\n' "$log" | grep -c 'front wget' || :)
  [ "$front_version_calls" -eq 1 ] || { printf 'expected exactly one frontend version attempt, got %s\n' "$front_version_calls" >&2; exit 1; }
done
: > "$TMP/mock.log"
set +e
output=$(MOCK_FRONT_VERSION="$(printf '%s\nextra' "$SHA")" run_deploy --rollback "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Frontend exact-SHA verification failed'
log=$(sed -n '1,200p' "$TMP/mock.log")
front_version_calls=$(printf '%s\n' "$log" | grep -c 'front wget' || :)
[ "$front_version_calls" -eq 1 ] || { printf 'expected exactly one frontend version attempt, got %s\n' "$front_version_calls" >&2; exit 1; }


# Explicit rollback to the active release is rejected before any service, database, pointer, manifest, or image change.
pointer "$CURRENT_SHA" current
pointer "$ROLLBACK_SHA" previous
: > "$TMP/mock.log"
set +e
output=$(MOCK_SHA="$CURRENT_SHA" run_deploy --rollback "$CURRENT_SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Refusing rollback to already-current SHA'
log=$(sed -n '1,200p' "$TMP/mock.log")
assert_not_contains "$log" 'docker compose'
[ "$(sed -n 's/.*"sha":"\([^"]*\)".*/\1/p' "$TMP/root/releases/current.json")" = "$CURRENT_SHA" ]
[ "$(sed -n 's/.*"sha":"\([^"]*\)".*/\1/p' "$TMP/root/releases/previous.json")" = "$ROLLBACK_SHA" ]
[ -f "$TMP/root/releases/$CURRENT_SHA.json" ] || { printf 'current immutable manifest was removed\n' >&2; exit 1; }
[ -f "$TMP/root/releases/$ROLLBACK_SHA.json" ] || { printf 'previous immutable manifest was removed\n' >&2; exit 1; }
# Bare rollback to an identical previous release is rejected before any service or database work.
pointer "$CURRENT_SHA" previous
: > "$TMP/mock.log"
set +e
output=$(MOCK_SHA="$CURRENT_SHA" run_deploy --rollback); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Refusing rollback to already-current SHA'
log=$(sed -n '1,200p' "$TMP/mock.log")
assert_not_contains "$log" 'docker compose'
[ "$(sed -n 's/.*"sha":"\([^"]*\)".*/\1/p' "$TMP/root/releases/current.json")" = "$CURRENT_SHA" ]
[ "$(sed -n 's/.*"sha":"\([^"]*\)".*/\1/p' "$TMP/root/releases/previous.json")" = "$CURRENT_SHA" ]
# A malformed existing pointer blocks every mode before Docker or release-state effects.
pointer "$CURRENT_SHA" current
printf '{"sha":"not-a-sha"}\n' > "$TMP/root/releases/previous.json"
manifest "$ROLLBACK_SHA" > "$TMP/root/releases/$ROLLBACK_SHA.json"
manifest "$SHA" > "$TMP/root/releases/$SHA.json"
printf 'BACKEND_IMAGE=sentinel\nFRONT_IMAGE=sentinel\n' > "$TMP/root/shared/release-images.env"
cp "$TMP/root/shared/release-images.env" "$TMP/release-images.env.before"
release_state_before=$(release_state)
: > "$TMP/mock.log"
set +e
output=$(MOCK_SHA="$ROLLBACK_SHA" run_deploy --rollback "$ROLLBACK_SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Invalid SHA in manifest'
log=$(sed -n '1,240p' "$TMP/mock.log")
assert_not_contains "$log" 'docker '
cmp -s "$TMP/release-images.env.before" "$TMP/root/shared/release-images.env" || {
  printf 'release-images.env changed after malformed previous pointer rollback\n' >&2; exit 1
}
[ "$release_state_before" = "$(release_state)" ] || {
  printf 'release pointers or manifests changed after malformed previous pointer rollback\n' >&2; exit 1
}
: > "$TMP/mock.log"
set +e
output=$(run_deploy --sha "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Invalid SHA in manifest'
log=$(sed -n '1,240p' "$TMP/mock.log")
assert_not_contains "$log" 'docker '
cmp -s "$TMP/release-images.env.before" "$TMP/root/shared/release-images.env" || {
  printf 'release-images.env changed after malformed previous pointer normal deploy\n' >&2; exit 1
}
[ "$release_state_before" = "$(release_state)" ] || {
  printf 'release pointers or manifests changed after malformed previous pointer normal deploy\n' >&2; exit 1
}
# Rollback activates the existing immutable manifest, retains only current/previous immutable releases, and prunes stale images.
pointer "$CURRENT_SHA" current
pointer "$ROLLBACK_SHA" previous
manifest "$SHA" > "$TMP/root/releases/$SHA.json"
: > "$TMP/mock.log"
output=$(MOCK_SHA="$ROLLBACK_SHA" run_deploy --rollback "$ROLLBACK_SHA")
assert_contains "$output" "compose up -d --wait --wait-timeout 120 backend front"
[ "$(sed -n 's/.*"sha":"\([^"]*\)".*/\1/p' "$TMP/root/releases/current.json")" = "$ROLLBACK_SHA" ]
[ "$(sed -n 's/.*"sha":"\([^"]*\)".*/\1/p' "$TMP/root/releases/previous.json")" = "$CURRENT_SHA" ]
[ ! -e "$TMP/root/releases/$SHA.json" ] || { printf 'stale immutable manifest was retained\n' >&2; exit 1; }

# An image-prune failure fails an otherwise successful deployment; a cleanup failure does too.
manifest "$SHA" > "$TMP/root/releases/$SHA.json"
set +e
output=$(MOCK_IMAGE_RM_FAIL=1 MOCK_SHA="$CURRENT_SHA" run_deploy --rollback "$CURRENT_SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'docker image rm'
set +e
output=$(MOCK_IMAGES_FAIL=1 MOCK_SHA="$ROLLBACK_SHA" run_deploy --rollback "$ROLLBACK_SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Unable to list Docker images for pruning.'
set +e
output=$(FAIL_RMDIR=1 MOCK_SHA="$CURRENT_SHA" run_deploy --rollback "$CURRENT_SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Failed to release deployment lock'
/bin/rmdir "$TMP/root/shared/deploy.lock"
# Preflight has no Docker, lock, release, or image side effects.
rm -f "$TMP/root/shared/release-images.env"
rm -f "$TMP/root/releases"/*.json "$TMP/root/backups/db"/*
: > "$TMP/mock.log"
output=$(run_deploy --preflight-only)
assert_contains "$output" 'preflight available_memory_plus_swap_mb='
[ ! -e "$TMP/root/shared/deploy.lock" ]
[ ! -e "$TMP/root/shared/release-images.env" ]
[ ! -s "$TMP/mock.log" ]
set +e
output=$(TEST_MEMORY_MIN_MB=999999 run_deploy --preflight-only); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Insufficient available memory plus swap'

# A pointer must byte-match its immutable record before any Docker side effect.
pointer "$CURRENT_SHA" current
sed 's/"compose"/"different"/' "$TMP/root/releases/current.json" > "$TMP/root/releases/current.json.bad"
mv "$TMP/root/releases/current.json.bad" "$TMP/root/releases/current.json"
: > "$TMP/mock.log"
set +e
output=$(run_deploy --sha "$SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Release pointer does not match immutable manifest'
[ ! -s "$TMP/mock.log" ]
pointer "$CURRENT_SHA" current

# First-bootstrap restore is DB-only and explicitly targets a transactionally atomic database restore.
rm -f "$TMP/root/releases"/*.json "$TMP/root/shared/release-images.env"
: > "$TMP/restore.dump"; : > "$TMP/mock.log"
output=$(run_deploy --restore-db "$TMP/restore.dump" --ack-data-loss)
log=$(sed -n '1,240p' "$TMP/mock.log")
assert_contains "$output" 'no release manifest exists, so application images were not started'
assert_contains "$log" 'pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --clean --if-exists --no-owner --exit-on-error --single-transaction'
assert_not_contains "$log" 'up -d --wait --wait-timeout 120 backend front'
assert_not_contains "$log" 'image inspect'
assert_order "$log" 'pg_restore --list' 'pg_restore --username'
assert_order "$log" 'pg_restore --username' 'has_table_privilege'
assert_contains "$log" 'REVOKE UPDATE, DELETE ON public.events FROM fall_app'
assert_order "$log" 'pg_restore --username' 'REVOKE UPDATE, DELETE ON public.events'
assert_order "$log" 'REVOKE UPDATE, DELETE ON public.events' 'has_table_privilege'

# Current/previous manifest dumps survive rotation and a missing retained dump fails closed.
pointer "$CURRENT_SHA" current
pointer "$ROLLBACK_SHA" previous
for index in 01 02 03 04 05 06; do
  : > "$TMP/root/backups/db/normal-20260711-0000${index}-$SHA.dump"
done
: > "$TMP/mock.log"
output=$(run_deploy --sha "$SHA" --dry-run)
assert_not_contains "$output" "would remove $TMP/root/backups/db/normal-test.dump"
assert_contains "$output" "would remove $TMP/root/backups/db/normal-20260711-000001-$SHA.dump"
rm -f "$TMP/root/backups/db/normal-test.dump"
set +e
output=$(run_deploy --sha "$SHA" --dry-run); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Release manifest references missing pre-migration dump'
: > "$TMP/root/backups/db/normal-test.dump"

# Existing-release deployments stop writers and validate the dump before DB pull/up.
: > "$TMP/mock.log"
output=$(run_deploy --sha "$SHA")
log=$(sed -n '1,320p' "$TMP/mock.log")
assert_order "$log" 'stop front api-ingress backend' 'pg_dump'
assert_order "$log" 'pg_dump' 'pull db'
assert_order "$log" 'pg_restore --list' 'pull db'
assert_contains "$output" 'compose up -d --wait --wait-timeout 120 backend api-ingress front'
assert_contains "$log" 'api-ingress wget'
assert_contains "$log" 'front wget'
# Schema-2 writer output is one canonical line with a fixed key order and all image IDs.
grep -Eq '^\{"schema":"2","sha":"[0-9a-f]{40}","backend_image":"eldercare-backend:[0-9a-f]{40}","backend_image_id":"sha256:backend-[0-9a-f]{40}","api_ingress_image":"eldercare-api-ingress:[0-9a-f]{40}","api_ingress_image_id":"sha256:api-ingress-[0-9a-f]{40}","embedded_front_image":"eldercare-front:[0-9a-f]{40}","embedded_front_image_id":"sha256:front-[0-9a-f]{40}","compose_sha256":"[0-9a-f]{64}","env_sha256":"[0-9a-f]{64}","pre_migration_dump":"normal-[^"]+\.dump","timestamp":"[^"]+"\}$' "$TMP/root/releases/current.json" || {
  printf 'schema-2 writer did not emit canonical fixed-order manifest:\n' >&2
  cat "$TMP/root/releases/current.json" >&2
  exit 1
}

# Candidate image IDs are not inherited from the current release.
NEXT_SHA=1111111111111111111111111111111111111111
: > "$TMP/mock.log"
output=$(MOCK_SHA="$NEXT_SHA" run_deploy --sha "$NEXT_SHA")
assert_contains "$output" "Deploy complete. sha=$NEXT_SHA"
cmp -s "$TMP/root/releases/$NEXT_SHA.json" "$TMP/root/releases/current.json"
cmp -s "$TMP/root/releases/$SHA.json" "$TMP/root/releases/previous.json"

# pg_dump or archive validation failures publish no final dump and leave no temporary archive.
FAIL_SHA=2222222222222222222222222222222222222222
rm -f "$TMP/root/releases"/*.json "$TMP/root/backups/db"/*
for failure_mode in pg_dump archive_validation; do
  set +e
  if [ "$failure_mode" = pg_dump ]; then
    output=$(MOCK_PGDUMP_FAIL=1 MOCK_SHA="$FAIL_SHA" run_deploy --sha "$FAIL_SHA"); status=$?
  else
    output=$(MOCK_RESTORE_LIST_FAIL=1 MOCK_SHA="$FAIL_SHA" run_deploy --sha "$FAIL_SHA"); status=$?
  fi
  set -e
  assert_failure "$status"
  for dump in "$TMP/root/backups/db"/normal-*-"$FAIL_SHA".dump "$TMP/root/backups/db"/.normal-*-"$FAIL_SHA".dump.*.tmp; do
    [ ! -e "$dump" ] || { printf 'failed dump was published or left behind: %s\n' "$dump" >&2; exit 1; }
  done
done
printf '%s\n' 'baseline-missing.dump' > "$TMP/root/backups/db/baseline.marker"
set +e
output=$(run_deploy --sha "$FAIL_SHA" --dry-run); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Baseline marker references missing dump'
rm -f "$TMP/root/backups/db/baseline.marker"

# A failed migration atomically owns its validated clean dump; retries cannot replace or rotate it.
rm -f "$TMP/root/releases"/*.json "$TMP/root/backups/db"/*
CURRENT_DUMP=normal-current.dump
PREVIOUS_DUMP=normal-previous.dump
pointer_with_dump "$CURRENT_SHA" current "$CURRENT_DUMP"
pointer_with_dump "$ROLLBACK_SHA" previous "$PREVIOUS_DUMP"
: > "$TMP/mock.log"
set +e
output=$(MOCK_MIGRATE_FAIL=1 MOCK_SHA="$FAIL_SHA" run_deploy --sha "$FAIL_SHA"); status=$?
set -e
assert_failure "$status"
PENDING_DUMP=$(sed -n 's/.*"pre_migration_dump":"\([^"]*\)".*/\1/p' "$TMP/root/releases/pending.json")
[ -n "$PENDING_DUMP" ] && [ -f "$TMP/root/backups/db/$PENDING_DUMP" ] || {
  printf 'migration failure did not persist its validated pending dump\n' >&2; exit 1
}
[ -f "$TMP/root/backups/db/$CURRENT_DUMP" ] && [ -f "$TMP/root/backups/db/$PREVIOUS_DUMP" ] || {
  printf 'current or previous dump was not protected during rotation\n' >&2; exit 1
}
# Pending ownership is the only retention protection for this intentionally oldest dump.
OLD_PENDING_DUMP=normal-000000-pending.dump
mv "$TMP/root/backups/db/$PENDING_DUMP" "$TMP/root/backups/db/$OLD_PENDING_DUMP"
PENDING_DUMP=$OLD_PENDING_DUMP
printf '{"sha":"%s","pre_migration_dump":"%s"}\n' "$FAIL_SHA" "$PENDING_DUMP" > "$TMP/root/releases/pending.json"
for index in 01 02 03 04 05 06; do
  : > "$TMP/root/backups/db/normal-999999-0000${index}.dump"
done
cp "$TMP/root/releases/pending.json" "$TMP/pending.before-retention-dry-run"
cp "$TMP/root/backups/db/$PENDING_DUMP" "$TMP/pending-dump.before-retention-dry-run"
output=$(run_deploy --sha "$FAIL_SHA" --dry-run)
assert_not_contains "$output" "would remove $TMP/root/backups/db/$PENDING_DUMP"
assert_contains "$output" "would remove $TMP/root/backups/db/normal-999999-000001.dump"
[ -f "$TMP/root/releases/pending.json" ] && [ -f "$TMP/root/backups/db/$PENDING_DUMP" ] || {
  printf 'dry-run cleared pending recovery ownership\n' >&2; exit 1
}
cmp -s "$TMP/pending.before-retention-dry-run" "$TMP/root/releases/pending.json"
cmp -s "$TMP/pending-dump.before-retention-dry-run" "$TMP/root/backups/db/$PENDING_DUMP"
: > "$TMP/mock.log"
set +e
output=$(MOCK_MIGRATE_FAIL=1 MOCK_SHA="$FAIL_SHA" run_deploy --sha "$FAIL_SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" "reusing pending validated pre-migration dump $PENDING_DUMP"
log=$(sed -n '1,240p' "$TMP/mock.log")
assert_not_contains "$log" 'pg_dump'
[ "$(sed -n 's/.*"pre_migration_dump":"\([^"]*\)".*/\1/p' "$TMP/root/releases/pending.json")" = "$PENDING_DUMP" ]
: > "$TMP/mock.log"
output=$(MOCK_SHA="$FAIL_SHA" run_deploy --sha "$FAIL_SHA")
[ ! -e "$TMP/root/releases/pending.json" ] || { printf 'successful activation did not clear pending recovery\n' >&2; exit 1; }
[ "$(sed -n 's/.*"pre_migration_dump":"\([^"]*\)".*/\1/p' "$TMP/root/releases/current.json")" = "$PENDING_DUMP" ]
# A canonical pending record for another candidate fails before preflight or any durable/runtime side effect.
printf '{"sha":"%s","pre_migration_dump":"%s"}\n' "$FAIL_SHA" "$PENDING_DUMP" > "$TMP/root/releases/pending.json"
cp "$TMP/root/shared/release-images.env" "$TMP/release-images.env.before-pending-mismatch"
cp "$TMP/root/releases/current.json" "$TMP/current.before-pending-mismatch"
cp "$TMP/root/releases/previous.json" "$TMP/previous.before-pending-mismatch"
cp "$TMP/root/releases/pending.json" "$TMP/pending.before-pending-mismatch"
: > "$TMP/mock.log"
set +e
output=$(MOCK_SHA="$NEXT_SHA" run_deploy --sha "$NEXT_SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" "Pending recovery record belongs to a different SHA: $FAIL_SHA"
[ ! -s "$TMP/mock.log" ]
assert_not_contains "$output" 'preflight available_memory_plus_swap_mb='
cmp -s "$TMP/release-images.env.before-pending-mismatch" "$TMP/root/shared/release-images.env"
cmp -s "$TMP/current.before-pending-mismatch" "$TMP/root/releases/current.json"
cmp -s "$TMP/previous.before-pending-mismatch" "$TMP/root/releases/previous.json"
cmp -s "$TMP/pending.before-pending-mismatch" "$TMP/root/releases/pending.json"

# Pending records fail closed when malformed or when their owned dump is unavailable.
printf '{"sha":"%s","pre_migration_dump":"%s","extra":"no"}\n' "$FAIL_SHA" "$PENDING_DUMP" > "$TMP/root/releases/pending.json"
: > "$TMP/mock.log"
set +e
output=$(MOCK_SHA="$NEXT_SHA" run_deploy --sha "$NEXT_SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Malformed pending recovery record'
[ ! -s "$TMP/mock.log" ]
printf '{"sha":"%s","pre_migration_dump":"normal-missing.dump"}\n' "$FAIL_SHA" > "$TMP/root/releases/pending.json"
: > "$TMP/mock.log"
set +e
output=$(MOCK_SHA="$NEXT_SHA" run_deploy --sha "$NEXT_SHA"); status=$?
set -e
assert_failure "$status"; assert_contains "$output" 'Pending recovery record references missing dump'
[ ! -s "$TMP/mock.log" ]

# Acknowledged recovery retains pending ownership on failure and clears it only after success.
: > "$TMP/root/backups/db/$PENDING_DUMP"
printf '{"sha":"%s","pre_migration_dump":"%s"}\n' "$FAIL_SHA" "$PENDING_DUMP" > "$TMP/root/releases/pending.json"
: > "$TMP/restore.dump"
set +e
output=$(MOCK_AUTH_RESULT=invalid MOCK_SHA="$FAIL_SHA" run_deploy --restore-db "$TMP/restore.dump" --ack-data-loss); status=$?
set -e
assert_failure "$status"
[ -f "$TMP/root/releases/pending.json" ] || { printf 'failed acknowledged recovery cleared pending ownership\n' >&2; exit 1; }
for recovery_failure in app_start backend_health frontend_health; do
  set +e
  case "$recovery_failure" in
    app_start) output=$(MOCK_APP_START_FAIL=1 MOCK_SHA="$FAIL_SHA" run_deploy --restore-db "$TMP/restore.dump" --ack-data-loss); status=$? ;;
    backend_health) output=$(MOCK_BACKEND_FAIL=1 MOCK_SHA="$FAIL_SHA" run_deploy --restore-db "$TMP/restore.dump" --ack-data-loss); status=$? ;;
    frontend_health) output=$(MOCK_FRONT_VERSION=wrong MOCK_SHA="$FAIL_SHA" run_deploy --restore-db "$TMP/restore.dump" --ack-data-loss); status=$? ;;
  esac
  set -e
  assert_failure "$status"
  [ -f "$TMP/root/releases/pending.json" ] && [ -f "$TMP/root/backups/db/$PENDING_DUMP" ] || {
    printf 'pending recovery ownership was cleared after %s failure\n' "$recovery_failure" >&2; exit 1
  }
done
output=$(MOCK_SHA="$FAIL_SHA" run_deploy --restore-db "$TMP/restore.dump" --ack-data-loss)
[ ! -e "$TMP/root/releases/pending.json" ] || { printf 'successful acknowledged recovery did not clear pending ownership\n' >&2; exit 1; }

# Post-health prune and terminal lock-release failures preserve canonical pending ownership.
FINAL_LIST_SHA=3333333333333333333333333333333333333333
FINAL_REMOVE_SHA=4444444444444444444444444444444444444444
FINAL_LOCK_SHA=5555555555555555555555555555555555555555
for final_failure in image_list image_remove lock_release; do
  case "$final_failure" in
    image_list) final_sha=$FINAL_LIST_SHA ;;
    image_remove) final_sha=$FINAL_REMOVE_SHA ;;
    lock_release) final_sha=$FINAL_LOCK_SHA ;;
  esac
  final_dump=normal-final-$final_sha.dump
  : > "$TMP/root/backups/db/$final_dump"
  printf '{"sha":"%s","pre_migration_dump":"%s"}\n' "$final_sha" "$final_dump" > "$TMP/root/releases/pending.json"
  cp "$TMP/root/releases/pending.json" "$TMP/pending.before-$final_failure"
  cp "$TMP/root/backups/db/$final_dump" "$TMP/pending-dump.before-$final_failure"
  set +e
  case "$final_failure" in
    image_list) output=$(MOCK_IMAGES_FAIL=1 MOCK_SHA="$final_sha" run_deploy --sha "$final_sha"); status=$? ;;
    image_remove) output=$(MOCK_IMAGE_RM_FAIL=1 MOCK_SHA="$final_sha" run_deploy --sha "$final_sha"); status=$? ;;
    lock_release) output=$(FAIL_RMDIR=1 MOCK_SHA="$final_sha" run_deploy --sha "$final_sha"); status=$? ;;
  esac
  set -e
  assert_failure "$status"
  cmp -s "$TMP/pending.before-$final_failure" "$TMP/root/releases/pending.json"
  cmp -s "$TMP/pending-dump.before-$final_failure" "$TMP/root/backups/db/$final_dump"
  if [ "$final_failure" = lock_release ]; then /bin/rmdir "$TMP/root/shared/deploy.lock"; fi
done

# Code-only rollback never resolves a pending database recovery owner.
ROLLBACK_PENDING_SHA=6666666666666666666666666666666666666666
ROLLBACK_PENDING_DUMP=normal-rollback-pending.dump
: > "$TMP/root/backups/db/$ROLLBACK_PENDING_DUMP"
printf '{"sha":"%s","pre_migration_dump":"%s"}\n' "$ROLLBACK_PENDING_SHA" "$ROLLBACK_PENDING_DUMP" > "$TMP/root/releases/pending.json"
cp "$TMP/root/releases/pending.json" "$TMP/pending.before-code-only-rollback"
output=$(MOCK_SHA="$FINAL_REMOVE_SHA" run_deploy --rollback)
cmp -s "$TMP/pending.before-code-only-rollback" "$TMP/root/releases/pending.json"
[ -f "$TMP/root/backups/db/$ROLLBACK_PENDING_DUMP" ]

# Jenkins resolves the latest main-reachable release, builds its exact SHA once, and has no alternate delivery path.
jenkins=$(sed -n '1,220p' "$JENKINSFILE")
assert_contains "$jenkins" "stage('Resolve release')"
assert_contains "$jenkins" 'scripts/deploy/iwinv-resolve-release.sh'
assert_contains "$jenkins" "env.NO_OP != '1'"
assert_not_contains "$jenkins" 'REGISTER-ONLY'
assert_not_contains "$jenkins" 'params.SHA'

seed=$(cat "$REPO_ROOT/scripts/deploy/jenkins-job-seed.groovy")
assert_contains "$seed" "pipelineJob('eldercare-fall-ai-cd')"
assert_contains "$seed" "tokenCredentialId('eldercare-webhook-token')"
assert_contains "$seed" 'printContributedVariables(false)'
assert_contains "$seed" 'printPostContent(false)'
assert_not_contains "$seed" 'genericVariables'
assert_not_contains "$seed" 'regexpFilter'
assert_not_contains "$seed" 'REGISTER-ONLY'
assert_not_contains "$seed" 'stringParam'
assert_not_contains "$seed" 'workflow_run'
assert_contains "$jenkins" "stage('Preflight resources')"
assert_contains "$jenkins" 'sh scripts/deploy/iwinv-deploy.sh --preflight-only'
assert_order "$jenkins" "stage('Resolve release')" "stage('Build backend')"
assert_contains "$jenkins" '--build-arg DEPLOY_SHA="$RELEASE_SHA"'
assert_contains "$jenkins" '--tag "eldercare-backend:$RELEASE_SHA"'
assert_contains "$jenkins" '--tag "eldercare-front:$RELEASE_SHA"'
assert_contains "$jenkins" 'docker buildx rm "$BUILDX_BUILDER"'
assert_contains "$jenkins" 'docker buildx create --name "$BUILDX_BUILDER" --driver docker-container --buildkitd-config "$config" --use'
assert_buildkit_parallelism() {
  buildkit_assignments=$(printf '%s\n' "$1" | grep -o "max-parallelism[[:space:]]*=[[:space:]]*[0-9][0-9]*'" | sed "s/'$//" || :)
  buildkit_assignment_count=$(printf '%s\n' "$buildkit_assignments" | grep -c . || :)
  [ "$buildkit_assignment_count" -eq 1 ] && [ "$buildkit_assignments" = 'max-parallelism = 1' ] || {
    printf 'BuildKit max-parallelism must have exactly one numeric assignment of 1, got: %s\n' "$buildkit_assignments" >&2
    exit 1
  }
}
assert_buildkit_parallelism "$jenkins"
jenkins_parallelism_ten=$(printf '%s\n' "$jenkins" | sed 's/max-parallelism = 1/max-parallelism = 10/')
set +e
(assert_buildkit_parallelism "$jenkins_parallelism_ten"); status=$?
set -e
assert_failure "$status"
jenkins_parallelism_duplicate=$(printf '%s\n' "$jenkins" | sed "s/'  max-parallelism = 1'/'  max-parallelism = 1' '  max-parallelism = 2'/")
set +e
(assert_buildkit_parallelism "$jenkins_parallelism_duplicate"); status=$?
set -e
assert_failure "$status"
assert_not_contains "$jenkins" 'docker buildx use "$BUILDX_BUILDER"'
deploy_calls=$(printf '%s\n' "$jenkins" | grep -c -F 'sh scripts/deploy/iwinv-deploy.sh --sha "$RELEASE_SHA"' || :)
[ "$deploy_calls" -eq 1 ] || { printf 'expected one deploy invocation, got %s\n' "$deploy_calls" >&2; exit 1; }
assert_contains "$jenkins" "\${env.RELEASE_SHA ?: 'unresolved'}"
assert_not_contains "$jenkins" '${params.SHA}'
assert_not_contains "$jenkins" 'GHCR'
assert_not_contains "$jenkins" 'ghcr.io'
assert_not_contains "$jenkins" 'ML'
assert_not_contains "$jenkins" 'docker pull'
assert_not_contains "$jenkins" 'docker push'
compose_prod=$(sed -n '1,80p' "$REPO_ROOT/compose.prod.yaml")
env_example=$(sed -n '31,60p' "$REPO_ROOT/.env.host.prod.example")
assert_contains "$compose_prod" 'SMTP_SECURE: ${SMTP_SECURE-}'
assert_contains "$env_example" 'omitted SMTP_SECURE lets the adapter use'

printf 'iwinv deploy contract tests passed\n'
