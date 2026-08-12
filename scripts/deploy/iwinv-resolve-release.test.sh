#!/usr/bin/env sh
set -eu

# Git hooks export repo-scoping vars (GIT_DIR etc.) to child processes; with
# GIT_DIR set, the fixture `git init --bare` below re-initializes the caller's
# repository as bare instead of creating a scratch remote. Clear them so the
# fixtures stay confined to $TMP when this test runs under a hook (pre-push
# env:verify gate).
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR GIT_PREFIX

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/iwinv-resolve-release.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
REAL_GIT=$(command -v git)
GIT_SHIM=$TMP/git-shim
mkdir -p "$GIT_SHIM"
cat > "$GIT_SHIM/git" <<'EOF'
#!/usr/bin/env sh
if [ "${1:-}" = ls-remote ]; then
  [ -z "${LS_REMOTE_LOG:-}" ] || printf '%s\n' "$*" >> "$LS_REMOTE_LOG"
  if [ "${LS_REMOTE_ROWS+x}" = x ]; then
    printf '%s\n' "$LS_REMOTE_ROWS"
    exit 0
  fi
fi
exec "$REAL_GIT" "$@"
EOF
cat > "$GIT_SHIM/docker" <<'EOF'
#!/usr/bin/env sh
printf 'docker %s\n' "$*" >> "${DOCKER_LOG:?}"
exit 99
EOF
chmod +x "$GIT_SHIM/git" "$GIT_SHIM/docker"

assert_contains() { case "$1" in *"$2"*) ;; *) printf 'missing expected output: %s\n%s\n' "$2" "$1" >&2; exit 1;; esac; }
assert_failure() { [ "$1" -ne 0 ] || { printf 'command unexpectedly passed\n' >&2; exit 1; }; }

fixture() {
  name=$1
  WORK=$TMP/$name/work
  REMOTE=$TMP/$name/remote.git
  RELEASES=$TMP/$name/releases
  mkdir -p "$TMP/$name" "$RELEASES"
  git init --bare "$REMOTE" >/dev/null
  git init "$WORK" >/dev/null
  git -C "$WORK" checkout -b main >/dev/null
  git -C "$WORK" config user.email release-test@example.com
  git -C "$WORK" config user.name 'Release Test'
  printf '%s\n' "$name" > "$WORK/release.txt"
  git -C "$WORK" add release.txt
  git -C "$WORK" commit -m initial >/dev/null
  git -C "$WORK" remote add origin "$REMOTE"
  git -C "$WORK" push -u origin main >/dev/null
}

run_resolver() {
  (
    cd "$WORK"
    GIT_REMOTE=origin RELEASES_DIR="$RELEASES" sh "$SCRIPT"
  )
}

run_resolver_with_git_shim() {
  (
    cd "$WORK"
    PATH="$GIT_SHIM:$PATH" REAL_GIT="$REAL_GIT" DOCKER_LOG="${DOCKER_LOG:-$TMP/docker.log}" GIT_REMOTE=origin RELEASES_DIR="$RELEASES" sh "$SCRIPT"
  )
}

assert_red() {
  set +e
  output=$(run_resolver); status=$?
  set -e
  assert_failure "$status"
}

assert_red_with_git_shim() {
  set +e
  output=$(run_resolver_with_git_shim); status=$?
  set -e
  assert_failure "$status"
}

manifest() {
  printf '{"sha":"%s","backend_image":"eldercare-backend:%s","backend_image_id":"sha256:backend-%s","front_image":"eldercare-front:%s","front_image_id":"sha256:front-%s","compose_sha256":"compose","env_sha256":"env","pre_migration_dump":"test.dump","timestamp":"2026-07-12T00:00:00Z"}\n' "$1" "$1" "$1" "$1" "$1"
}

schema_two_manifest() {
  printf '{"schema":"2","sha":"%s","backend_image":"eldercare-backend:%s","backend_image_id":"sha256:backend-%s","api_ingress_image":"eldercare-api-ingress:%s","api_ingress_image_id":"sha256:api-ingress-%s","embedded_front_image":"eldercare-front:%s","embedded_front_image_id":"sha256:front-%s","compose_sha256":"compose","env_sha256":"env","pre_migration_dump":"test.dump","timestamp":"2026-08-12T00:00:00Z"}\n' "$1" "$1" "$1" "$1" "$1" "$1" "$1"
}

schema_two_backend_ingress_manifest() {
  printf '{"schema":"2","sha":"%s","backend_image":"eldercare-backend:%s","backend_image_id":"sha256:backend-%s","api_ingress_image":"eldercare-api-ingress:%s","api_ingress_image_id":"sha256:api-ingress-%s","compose_sha256":"compose","env_sha256":"env","pre_migration_dump":"test.dump","timestamp":"2026-08-12T00:00:00Z"}\n' "$1" "$1" "$1" "$1" "$1"
}

pretty_manifest() {
  printf '{\n  "sha" : "%s",\n  "backend_image" : "eldercare-backend:%s",\n  "backend_image_id" : "sha256:backend-%s",\n  "front_image" : "eldercare-front:%s",\n  "front_image_id" : "sha256:front-%s",\n  "compose_sha256" : "compose",\n  "env_sha256" : "env",\n  "pre_migration_dump" : "test.dump",\n  "timestamp" : "2026-07-12T00:00:00Z"\n}\n' "$1" "$1" "$1" "$1" "$1"
}

add_lightweight_tag() {
  git -C "$WORK" tag "$1" "$2"
  git -C "$WORK" push origin "refs/tags/$1" >/dev/null
}

add_annotated_tag() {
  git -C "$WORK" tag -a "$1" "$2" -m "$1"
  git -C "$WORK" push origin "refs/tags/$1" >/dev/null
}

# Lightweight tags resolve directly to the tagged commit.
fixture lightweight
main_sha=$(git -C "$WORK" rev-parse HEAD)
add_lightweight_tag v1.2.3 "$main_sha"
output=$(run_resolver)
assert_contains "$output" 'RELEASE_TAG=v1.2.3'
assert_contains "$output" "RELEASE_SHA=$main_sha"
assert_contains "$output" 'NO_OP=0'

# Annotated tags must use their peeled commit OID rather than the tag object OID.
fixture annotated
main_sha=$(git -C "$WORK" rev-parse HEAD)
add_annotated_tag v1.2.3 "$main_sha"
output=$(run_resolver)
assert_contains "$output" "RELEASE_SHA=$main_sha"
[ "$(git -C "$WORK" rev-parse v1.2.3)" != "$main_sha" ]

# Tags pointing at a blob are rejected after peeled-OID selection.
fixture non-commit
printf 'blob\n' > "$WORK/blob.txt"
blob_sha=$(git -C "$WORK" hash-object -w blob.txt)
add_annotated_tag v1.2.3 "$blob_sha"
assert_red

# Prerelease and non-semver tags do not participate in stable release selection.
fixture ignored-tags
main_sha=$(git -C "$WORK" rev-parse HEAD)
add_lightweight_tag v1.2.3 "$main_sha"
add_lightweight_tag v9.9.9-rc.1 "$main_sha"
add_lightweight_tag release-99 "$main_sha"
output=$(run_resolver)
assert_contains "$output" 'RELEASE_TAG=v1.2.3'
add_lightweight_tag v01.2.3 "$main_sha"
output=$(run_resolver)
assert_contains "$output" 'RELEASE_TAG=v1.2.3'

# Version sorting is semantic rather than lexical.
fixture version-sort
main_sha=$(git -C "$WORK" rev-parse HEAD)
add_lightweight_tag v0.9.0 "$main_sha"
add_lightweight_tag v0.10.0 "$main_sha"
output=$(run_resolver)
assert_contains "$output" 'RELEASE_TAG=v0.10.0'

# Leading-zero semver tags are not stable production releases.
fixture leading-zero-version
main_sha=$(git -C "$WORK" rev-parse HEAD)
add_lightweight_tag v01.2.3 "$main_sha"
assert_red

# The resolver performs exactly one remote tag lookup.
fixture single-ls-remote
main_sha=$(git -C "$WORK" rev-parse HEAD)
add_lightweight_tag v1.2.3 "$main_sha"
ls_remote_log=$TMP/single-ls-remote.log
: > "$ls_remote_log"
output=$(LS_REMOTE_LOG="$ls_remote_log" run_resolver_with_git_shim)
assert_contains "$output" 'RELEASE_TAG=v1.2.3'
ls_remote_calls=$(wc -l < "$ls_remote_log")
[ "$ls_remote_calls" -eq 1 ] || { printf 'expected exactly one git ls-remote call, got %s\n' "$ls_remote_calls" >&2; exit 1; }

# Malformed remote OIDs are rejected before commit resolution.
assert_malformed_remote_oid() {
  fixture "malformed-oid-$1"
  rows=$(printf '%s\trefs/tags/v1.2.3' "$2")
  LS_REMOTE_ROWS="$rows" assert_red_with_git_shim
}
short_oid=$(printf '%039d' 0 | tr 0 a)
assert_malformed_remote_oid short "$short_oid"
mixed_case_oid=$(printf '%039d' 0 | tr 0 a)A
assert_malformed_remote_oid mixed-case "$mixed_case_oid"

# No stable tag is a hard failure.
fixture no-tags
assert_red

# A stable tag on a commit outside main is a hard failure.
fixture off-main
git -C "$WORK" checkout -b release-only >/dev/null
git -C "$WORK" commit --allow-empty -m off-main >/dev/null
off_main_sha=$(git -C "$WORK" rev-parse HEAD)
add_lightweight_tag v1.2.3 "$off_main_sha"
git -C "$WORK" checkout main >/dev/null
assert_red

# Missing current.json is a bootstrap deployment, not a no-op.
fixture release-pointer
main_sha=$(git -C "$WORK" rev-parse HEAD)
add_lightweight_tag v1.2.3 "$main_sha"
output=$(run_resolver)
assert_contains "$output" 'NO_OP=0'

# A valid pointer identical to its immutable manifest is a no-op only for the same release.
manifest "$main_sha" > "$RELEASES/$main_sha.json"
cp "$RELEASES/$main_sha.json" "$RELEASES/current.json"
output=$(run_resolver)
assert_contains "$output" 'NO_OP=1'

# Whitespace around schema-1 manifest separators is accepted when immutable bytes match.
pretty_manifest "$main_sha" > "$RELEASES/$main_sha.json"
cp "$RELEASES/$main_sha.json" "$RELEASES/current.json"
output=$(run_resolver)
assert_contains "$output" 'NO_OP=1'

# Both schema-2 layouts are readable, including the first transitional release.
schema_two_manifest "$main_sha" > "$RELEASES/$main_sha.json"
cp "$RELEASES/$main_sha.json" "$RELEASES/current.json"
output=$(run_resolver)
assert_contains "$output" 'NO_OP=1'
schema_two_backend_ingress_manifest "$main_sha" > "$RELEASES/$main_sha.json"
cp "$RELEASES/$main_sha.json" "$RELEASES/current.json"
output=$(run_resolver)
assert_contains "$output" 'NO_OP=1'

# A valid pointer for another release proceeds with deployment.
other_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
manifest "$other_sha" > "$RELEASES/$other_sha.json"
cp "$RELEASES/$other_sha.json" "$RELEASES/current.json"
output=$(run_resolver)
assert_contains "$output" 'NO_OP=0'

# A syntactically invalid schema-1 lookalike is rejected by the resolver's
# manifest reader before any release environment or Docker side effect.
printf 'NOT-JSON "sha":"%s","backend_image":"eldercare-backend:%s","backend_image_id":"sha256:backend-%s","front_image":"eldercare-front:%s","front_image_id":"sha256:front-%s","compose_sha256":"compose","env_sha256":"env","pre_migration_dump":"test.dump","timestamp":"2026-08-12T00:00:00Z" TRAILING-GARBAGE\n' "$main_sha" "$main_sha" "$main_sha" "$main_sha" "$main_sha" > "$RELEASES/$main_sha.json"
cp "$RELEASES/$main_sha.json" "$RELEASES/current.json"
release_env=$TMP/resolver-release-images.env
printf 'BACKEND_IMAGE=sentinel\nAPI_INGRESS_IMAGE=sentinel\nFRONT_IMAGE=sentinel\n' > "$release_env"
cp "$release_env" "$release_env.before"
release_env_checksum_before=$(cksum "$release_env")
docker_log=$TMP/resolver-docker.log
: > "$docker_log"
set +e
output=$(DOCKER_LOG="$docker_log" run_resolver_with_git_shim 2>&1); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'Malformed release manifest JSON'
cmp -s "$release_env.before" "$release_env" || { printf 'resolver changed sentinel release environment\n' >&2; exit 1; }
[ ! -s "$docker_log" ] || { printf 'resolver malformed JSON reached Docker\n' >&2; exit 1; }
release_env_checksum_after=$(cksum "$release_env")
printf 'malformed JSON resolver rejection proof: exit=%s release_env_before=%s release_env_after=%s docker_log_bytes=0\n' "$status" "$release_env_checksum_before" "$release_env_checksum_after"

# Malformed pointers, missing image fields, missing immutable manifests, and mismatched bytes are red.
printf '{"sha":\n' > "$RELEASES/current.json"
assert_red
printf '{"sha":"%s"}\n' "$main_sha" > "$RELEASES/current.json"
assert_red
manifest "$main_sha" > "$RELEASES/current.json"
rm -f "$RELEASES/$main_sha.json"
assert_red
manifest "$main_sha" > "$RELEASES/$main_sha.json"
printf '\n' >> "$RELEASES/current.json"
assert_red

# Unknown or malformed explicit schemas fail closed even when pointer bytes match.
for invalid_schema in '"3"' '2' '"02"'; do
  printf '{"schema":%s,"sha":"%s","backend_image":"eldercare-backend:%s","backend_image_id":"sha256:backend","api_ingress_image":"eldercare-api-ingress:%s","api_ingress_image_id":"sha256:ingress"}\n' "$invalid_schema" "$main_sha" "$main_sha" "$main_sha" > "$RELEASES/$main_sha.json"
  cp "$RELEASES/$main_sha.json" "$RELEASES/current.json"
  assert_red
done

printf 'iwinv resolve release contract tests passed\n'
