#!/usr/bin/env sh
set -eu

# Git hooks export repo-scoping vars to child processes; clear them so the
# fixture repositories stay confined to $TMP when this runs under a hook.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR GIT_PREFIX

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/iwinv-resolve-release.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

fail() { printf '%s\n' "$*" >&2; exit 1; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "missing expected output: $2
$1";; esac; }

WORK=$TMP/work
REMOTE=$TMP/remote.git
git init -q --bare "$REMOTE"
git init -q "$WORK"
git -C "$WORK" checkout -q -b main
git -C "$WORK" config user.email release-test@example.com
git -C "$WORK" config user.name 'Release Test'
commit() { printf '%s\n' "$1" > "$WORK/release.txt"; git -C "$WORK" add release.txt; git -C "$WORK" commit -qm "$1"; git -C "$WORK" rev-parse HEAD; }
git -C "$WORK" remote add origin "$REMOTE"

resolve() { (cd "$WORK" && GIT_REMOTE=origin RELEASE_TAG="${1:-}" sh "$SCRIPT"); }
expect_failure() {
  set +e
  output=$(resolve "$1" 2>&1); status=$?
  set -e
  [ "$status" -ne 0 ] || fail "resolver unexpectedly accepted: $1"
  assert_contains "$output" "$2"
}

v1=$(commit one)
git -C "$WORK" tag v0.1.9 "$v1"
v2=$(commit two)
git -C "$WORK" tag -a v0.1.10 -m annotated "$v2"
v3=$(commit three)
git -C "$WORK" tag v1.0.0-rc.1 "$v3"
git -C "$WORK" push -q origin main --tags

# Latest stable: semantic (not lexical) order, annotated tags peel to the commit, prereleases ignored.
[ "$(resolve)" = "RELEASE_TAG=v0.1.10
RELEASE_SHA=$v2" ] || fail 'latest stable tag was not resolved'

# RELEASE_TAG selects an older release: the rollback path.
[ "$(resolve v0.1.9)" = "RELEASE_TAG=v0.1.9
RELEASE_SHA=$v1" ] || fail 'requested RELEASE_TAG was not resolved'

expect_failure v9.9.9 'Release tag not found: v9.9.9'
expect_failure 'v0.1.9;id' 'RELEASE_TAG must be a stable vX.Y.Z tag'
expect_failure v1.0.0-rc.1 'RELEASE_TAG must be a stable vX.Y.Z tag'
expect_failure 0.1.9 'RELEASE_TAG must be a stable vX.Y.Z tag'

# A tag whose commit is not on main is refused, whether latest or requested.
git -C "$WORK" checkout -q -b side "$v1"
side=$(commit side)
git -C "$WORK" tag v2.0.0 "$side"
git -C "$WORK" push -q origin v2.0.0
git -C "$WORK" checkout -q main
expect_failure '' 'Release tag v2.0.0 is not reachable from origin/main.'
expect_failure v2.0.0 'Release tag v2.0.0 is not reachable from origin/main.'
[ "$(resolve v0.1.10)" = "RELEASE_TAG=v0.1.10
RELEASE_SHA=$v2" ] || fail 'requested on-main tag failed alongside an off-main tag'
git -C "$WORK" push -q origin :refs/tags/v2.0.0

# No stable tags at all.
git -C "$WORK" push -q origin :refs/tags/v0.1.9 :refs/tags/v0.1.10
expect_failure '' 'No stable semantic version release tag found.'

# Leftover release-state files are irrelevant to resolution.
grep -q 'current.json\|pending.json\|RELEASES_DIR' "$SCRIPT" && fail 'resolver must not read server release-state files'

printf '%s\n' 'iwinv release resolver tests passed'
