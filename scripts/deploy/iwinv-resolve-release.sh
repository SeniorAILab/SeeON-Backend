#!/usr/bin/env sh
# Resolve the release to deploy: RELEASE_TAG if given (rollback = re-run with an
# older tag), otherwise the highest stable vX.Y.Z tag. The tagged commit must be
# reachable from origin/main. Prints RELEASE_TAG= and RELEASE_SHA=.
set -eu

GIT_REMOTE=${GIT_REMOTE:-origin}
REQUESTED_TAG=${RELEASE_TAG:-}

fail() { printf '%s\n' "$*" >&2; exit 1; }
valid_sha() { [ "${#1}" -eq 40 ] && printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }
semver_tag='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

if [ -n "$REQUESTED_TAG" ]; then
  printf '%s\n' "$REQUESTED_TAG" | grep -Eq "$semver_tag" || fail "RELEASE_TAG must be a stable vX.Y.Z tag: $REQUESTED_TAG"
fi

git fetch --no-tags "$GIT_REMOTE" +refs/heads/main:refs/remotes/origin/main
remote_tags=$(git ls-remote --tags "$GIT_REMOTE") || fail "Unable to list release tags from $GIT_REMOTE"
# One "tag<TAB>commit" line per stable tag; annotated tags use their peeled commit.
candidates=$(printf '%s\n' "$remote_tags" | awk '
  $2 ~ /^refs\/tags\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/ {
    tag = $2; sub(/^refs\/tags\//, "", tag); direct[tag] = $1
  }
  $2 ~ /^refs\/tags\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\^\{\}$/ {
    tag = $2; sub(/^refs\/tags\//, "", tag); sub(/\^\{\}$/, "", tag); peeled[tag] = $1
  }
  END { for (tag in direct) print tag "\t" (tag in peeled ? peeled[tag] : direct[tag]) }
' | sort -V)

if [ -n "$REQUESTED_TAG" ]; then
  candidate=$(printf '%s\n' "$candidates" | awk -F '\t' -v tag="$REQUESTED_TAG" '$1 == tag')
  [ -n "$candidate" ] || fail "Release tag not found: $REQUESTED_TAG"
else
  candidate=$(printf '%s\n' "$candidates" | awk 'NF { last = $0 } END { print last }')
  [ -n "$candidate" ] || fail 'No stable semantic version release tag found.'
fi

release_tag=${candidate%%	*}
release_sha=${candidate#*	}
valid_sha "$release_sha" || fail "Release tag $release_tag did not resolve to a 40-character lowercase hexadecimal SHA."
git cat-file -e "$release_sha^{commit}" || fail "Release tag $release_tag does not resolve to a commit."
git merge-base --is-ancestor "$release_sha" refs/remotes/origin/main || fail "Release tag $release_tag is not reachable from origin/main."

printf 'RELEASE_TAG=%s\nRELEASE_SHA=%s\n' "$release_tag" "$release_sha"
