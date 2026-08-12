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
NO_NODE_BIN=$TMP/no-node-bin
mkdir -p "$NO_NODE_BIN"
for tool in sh grep sed cmp awk sort wc tr cat tail mktemp rm; do
  tool_path=$(command -v "$tool") || { printf 'test prerequisite missing: %s\n' "$tool" >&2; exit 1; }
  ln -s "$tool_path" "$NO_NODE_BIN/$tool"
done
ln -s "$GIT_SHIM/git" "$NO_NODE_BIN/git"
ln -s "$GIT_SHIM/docker" "$NO_NODE_BIN/docker"

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
run_resolver_without_node() {
  (
    cd "$WORK"
    PATH="$NO_NODE_BIN" REAL_GIT="$REAL_GIT" DOCKER_LOG="${DOCKER_LOG:-$TMP/docker.log}" GIT_REMOTE=origin RELEASES_DIR="$RELEASES" "$NO_NODE_BIN/sh" "$SCRIPT"
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

FIXTURE_BACKEND_ID=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
FIXTURE_INGRESS_ID=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
FIXTURE_FRONT_ID=sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
FIXTURE_COMPOSE_HASH=0000000000000000000000000000000000000000000000000000000000000000
FIXTURE_ENV_HASH=1111111111111111111111111111111111111111111111111111111111111111
manifest() {
  printf '{"sha":"%s","backend_image":"eldercare-backend:%s","backend_image_id":"%s","front_image":"eldercare-front:%s","front_image_id":"%s","compose_sha256":"%s","env_sha256":"%s","pre_migration_dump":"normal-test.dump","timestamp":"2026-07-12T00:00:00Z"}\n' "$1" "$1" "$FIXTURE_BACKEND_ID" "$1" "$FIXTURE_FRONT_ID" "$FIXTURE_COMPOSE_HASH" "$FIXTURE_ENV_HASH"
}

schema_two_manifest() {
  printf '{"schema":"2","sha":"%s","backend_image":"eldercare-backend:%s","backend_image_id":"%s","api_ingress_image":"eldercare-api-ingress:%s","api_ingress_image_id":"%s","embedded_front_image":"eldercare-front:%s","embedded_front_image_id":"%s","compose_sha256":"%s","env_sha256":"%s","pre_migration_dump":"normal-test.dump","timestamp":"2026-08-12T00:00:00Z"}\n' "$1" "$1" "$FIXTURE_BACKEND_ID" "$1" "$FIXTURE_INGRESS_ID" "$1" "$FIXTURE_FRONT_ID" "$FIXTURE_COMPOSE_HASH" "$FIXTURE_ENV_HASH"
}

schema_two_backend_ingress_manifest() {
  printf '{"schema":"2","sha":"%s","backend_image":"eldercare-backend:%s","backend_image_id":"%s","api_ingress_image":"eldercare-api-ingress:%s","api_ingress_image_id":"%s","compose_sha256":"%s","env_sha256":"%s","pre_migration_dump":"normal-test.dump","timestamp":"2026-08-12T00:00:00Z"}\n' "$1" "$1" "$FIXTURE_BACKEND_ID" "$1" "$FIXTURE_INGRESS_ID" "$FIXTURE_COMPOSE_HASH" "$FIXTURE_ENV_HASH"
}

pretty_manifest() {
  printf '{\n  "sha" : "%s",\n  "backend_image" : "eldercare-backend:%s",\n  "backend_image_id" : "%s",\n  "front_image" : "eldercare-front:%s",\n  "front_image_id" : "%s",\n  "compose_sha256" : "%s",\n  "env_sha256" : "%s",\n  "pre_migration_dump" : "normal-test.dump",\n  "timestamp" : "2026-07-12T00:00:00Z"\n}\n' "$1" "$1" "$FIXTURE_BACKEND_ID" "$1" "$FIXTURE_FRONT_ID" "$FIXTURE_COMPOSE_HASH" "$FIXTURE_ENV_HASH"
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

# Non-canonical whitespace is rejected even when pointer and immutable bytes match.
pretty_manifest "$main_sha" > "$RELEASES/$main_sha.json"
cp "$RELEASES/$main_sha.json" "$RELEASES/current.json"
assert_red

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
assert_contains "$output" 'Invalid release manifest canonical form'
cmp -s "$release_env.before" "$release_env" || { printf 'resolver changed sentinel release environment\n' >&2; exit 1; }
[ ! -s "$docker_log" ] || { printf 'resolver malformed JSON reached Docker\n' >&2; exit 1; }
release_env_checksum_after=$(cksum "$release_env")
printf 'malformed JSON resolver rejection proof: exit=%s release_env_before=%s release_env_after=%s docker_log_bytes=0\n' "$status" "$release_env_checksum_before" "$release_env_checksum_after"

assert_resolver_manifest_rejected_without_side_effects() {
  label=$1
  expected=$2
  runner=${3:-run_resolver_with_git_shim}
  cp "$RELEASES/current.json" "$RELEASES/$main_sha.json"
  printf 'BACKEND_IMAGE=sentinel\nAPI_INGRESS_IMAGE=sentinel\nFRONT_IMAGE=sentinel\n' > "$release_env"
  before=$(cksum "$release_env")
  : > "$docker_log"
  set +e
  output=$(DOCKER_LOG="$docker_log" $runner 2>&1); status=$?
  set -e
  assert_failure "$status"
  assert_contains "$output" "$expected"
  after=$(cksum "$release_env")
  [ "$before" = "$after" ] || { printf '%s changed resolver sentinel env\n' "$label" >&2; exit 1; }
  [ ! -s "$docker_log" ] || { printf '%s resolver path reached Docker\n' "$label" >&2; exit 1; }
  printf '%s resolver rejection proof: exit=%s release_env_before=%s release_env_after=%s docker_log_bytes=0\n' "$label" "$status" "$before" "$after"
}

manifest "$main_sha" | sed 's/}$/,"timestamp":"2026-08-13T00:00:00Z"}/' > "$RELEASES/current.json"
assert_resolver_manifest_rejected_without_side_effects duplicate-key 'Invalid release manifest canonical form'

manifest "$main_sha" | sed 's/2026-07-12T00:00:00Z/2026-07-12T00:00:00Z\\nINJECTED/' > "$RELEASES/current.json"
assert_resolver_manifest_rejected_without_side_effects decoded-newline 'Invalid release manifest canonical form'

write_sized_spaces() {
  total_bytes=$1
  target=$2
  { head -c "$((total_bytes - 1))" /dev/zero | tr '\000' ' '; printf '\n'; } > "$target"
}
write_sized_spaces 5242880 "$RELEASES/current.json"
assert_resolver_manifest_rejected_without_side_effects oversized 'Release manifest exceeds 4096 bytes'

write_invalid_resolver_manifest() {
  case_name=$1
  target=$2
  case "$case_name" in
    duplicate-identical) manifest "$main_sha" | sed 's/}$/,"timestamp":"2026-07-12T00:00:00Z"}/' > "$target" ;;
    duplicate-differing) manifest "$main_sha" | sed 's/}$/,"timestamp":"2026-08-13T00:00:00Z"}/' > "$target" ;;
    unknown-key) manifest "$main_sha" | sed 's/}$/,"unknown":"value"}/' > "$target" ;;
    reordered) manifest "$main_sha" | sed 's/{"sha":"\([^"]*\)","backend_image":"\([^"]*\)"/{"backend_image":"\2","sha":"\1"/' > "$target" ;;
    whitespace) manifest "$main_sha" | sed 's/":"/": "/' > "$target" ;;
    leading-space) { printf ' '; manifest "$main_sha"; } > "$target" ;;
    trailing-space) manifest "$main_sha" | sed 's/$/ /' > "$target" ;;
    crlf) manifest "$main_sha" | perl -pe 's/\n/\r\n/' > "$target" ;;
    embedded-newline) manifest "$main_sha" | perl -pe 's/T00:00:00Z/T00:00:\n00Z/' > "$target" ;;
    literal-tab) { printf '\t'; manifest "$main_sha"; } > "$target" ;;
    nul) { manifest "$main_sha" | tr -d '\n'; printf '\000\n'; } > "$target" ;;
    del) { manifest "$main_sha" | tr -d '\n'; printf '\177\n'; } > "$target" ;;
    utf8) { manifest "$main_sha" | tr -d '\n'; printf '\303\251\n'; } > "$target" ;;
    unicode-escape) manifest "$main_sha" | sed 's/"sha":"\([0-9a-f]\)/"sha":"\\u00\1/' > "$target" ;;
    quoted-dump) manifest "$main_sha" | sed 's/normal-test.dump/normal-\\"test.dump/' > "$target" ;;
    backslash-dump) manifest "$main_sha" | sed 's/normal-test.dump/normal-\\\\test.dump/' > "$target" ;;
    zero-byte) : > "$target" ;;
    at-cap) write_sized_spaces 4096 "$target" ;;
    cap-plus-one) write_sized_spaces 4097 "$target" ;;
    five-mib) write_sized_spaces 5242880 "$target" ;;
    missing-newline) manifest "$main_sha" | tr -d '\n' > "$target" ;;
    two-newlines) { manifest "$main_sha"; printf '\n'; } > "$target" ;;
    sha-39) manifest "$main_sha" | sed 's/"sha":"[0-9a-f]\{40\}"/"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/' > "$target" ;;
    sha-41) manifest "$main_sha" | sed 's/"sha":"[0-9a-f]\{40\}"/"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/' > "$target" ;;
    uppercase-sha) manifest "$main_sha" | sed 's/"sha":"[0-9a-f]/"sha":"A/' > "$target" ;;
    image-id-63) manifest "$main_sha" | sed "s/$FIXTURE_BACKEND_ID/sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/" > "$target" ;;
    image-id-65) manifest "$main_sha" | sed "s/$FIXTURE_BACKEND_ID/sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/" > "$target" ;;
    image-sha-mismatch) manifest "$main_sha" | sed 's/eldercare-backend:[0-9a-f]\{40\}/eldercare-backend:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' > "$target" ;;
    compose-hash-63) manifest "$main_sha" | sed "s/$FIXTURE_COMPOSE_HASH/000000000000000000000000000000000000000000000000000000000000000/" > "$target" ;;
    env-hash-65) manifest "$main_sha" | sed "s/$FIXTURE_ENV_HASH/11111111111111111111111111111111111111111111111111111111111111111/" > "$target" ;;
    uppercase-hash) manifest "$main_sha" | sed "s/$FIXTURE_COMPOSE_HASH/A000000000000000000000000000000000000000000000000000000000000000/" > "$target" ;;
    dump-slash) manifest "$main_sha" | sed 's/normal-test.dump/normal-dir\/test.dump/' > "$target" ;;
    dump-dotdot) manifest "$main_sha" | sed 's/normal-test.dump/normal-..dump/' > "$target" ;;
    dump-empty) manifest "$main_sha" | sed 's/normal-test.dump//' > "$target" ;;
    dump-overlength) manifest "$main_sha" | awk '{ value=sprintf("%*s", 221, ""); gsub(/ /, "a", value); sub(/normal-test.dump/, "normal-" value ".dump"); print }' > "$target" ;;
    bare-number) manifest "$main_sha" | sed 's/"timestamp":"2026-07-12T00:00:00Z"/"timestamp":20260712/' > "$target" ;;
    timestamp-offset) manifest "$main_sha" | sed 's/2026-07-12T00:00:00Z/2026-07-12T00:00:00+09:00/' > "$target" ;;
    timestamp-year) manifest "$main_sha" | sed 's/2026-07-12T00:00:00Z/1999-07-12T00:00:00Z/' > "$target" ;;
    timestamp-month) manifest "$main_sha" | sed 's/2026-07-12T00:00:00Z/2026-13-12T00:00:00Z/' > "$target" ;;
    timestamp-clock) manifest "$main_sha" | sed 's/2026-07-12T00:00:00Z/2026-07-12T24:00:60Z/' > "$target" ;;
    schema-unquoted) schema_two_manifest "$main_sha" | sed 's/"schema":"2"/"schema":2/' > "$target" ;;
    schema-one) schema_two_manifest "$main_sha" | sed 's/"schema":"2"/"schema":"1"/' > "$target" ;;
    schema-three) schema_two_manifest "$main_sha" | sed 's/"schema":"2"/"schema":"3"/' > "$target" ;;
    schema-wrong-position) schema_two_manifest "$main_sha" | sed 's/{"schema":"2","sha":"\([^"]*\)"/{"sha":"\1","schema":"2"/' > "$target" ;;
    front-ref-only) schema_two_manifest "$main_sha" | sed '/./s/,"embedded_front_image_id":"[^"]*"//' > "$target" ;;
    front-id-only) schema_two_manifest "$main_sha" | sed '/./s/,"embedded_front_image":"[^"]*"//' > "$target" ;;
    *) printf 'unknown invalid resolver manifest case: %s\n' "$case_name" >&2; exit 1 ;;
  esac
}

for invalid_case in duplicate-identical duplicate-differing unknown-key reordered whitespace leading-space trailing-space crlf embedded-newline literal-tab nul del utf8 unicode-escape quoted-dump backslash-dump zero-byte at-cap cap-plus-one five-mib missing-newline two-newlines sha-39 sha-41 uppercase-sha image-id-63 image-id-65 image-sha-mismatch compose-hash-63 env-hash-65 uppercase-hash dump-slash dump-dotdot dump-empty dump-overlength bare-number timestamp-offset timestamp-year timestamp-month timestamp-clock schema-unquoted schema-one schema-three schema-wrong-position front-ref-only front-id-only; do
  write_invalid_resolver_manifest "$invalid_case" "$RELEASES/current.json"
  assert_resolver_manifest_rejected_without_side_effects "$invalid_case" 'manifest'
done

# The dependency-free validator works with both Node and jq absent.
manifest "$main_sha" > "$RELEASES/$main_sha.json"
cp "$RELEASES/$main_sha.json" "$RELEASES/current.json"
printf 'BACKEND_IMAGE=sentinel\nAPI_INGRESS_IMAGE=sentinel\nFRONT_IMAGE=sentinel\n' > "$release_env"
before=$(cksum "$release_env")
: > "$docker_log"
output=$(DOCKER_LOG="$docker_log" run_resolver_without_node)
assert_contains "$output" 'NO_OP=1'
after=$(cksum "$release_env")
[ "$before" = "$after" ] && [ ! -s "$docker_log" ] || { printf 'dependency-free resolver validator caused side effects\n' >&2; exit 1; }
printf 'dependency-free resolver validator proof: exit=0 release_env_before=%s release_env_after=%s docker_log_bytes=0\n' "$before" "$after"

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
