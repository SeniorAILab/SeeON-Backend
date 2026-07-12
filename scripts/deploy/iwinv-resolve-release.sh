#!/usr/bin/env sh
set -eu

GIT_REMOTE=${GIT_REMOTE:-origin}
RELEASES_DIR=${RELEASES_DIR:-/opt/eldercare-fall-ai/releases}

fail() { printf '%s\n' "$*" >&2; exit 1; }
valid_sha() { [ "${#1}" -eq 40 ] && printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }
json_value() { sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1"; }

validate_current_manifest() {
  current_manifest=$RELEASES_DIR/current.json
  [ -f "$current_manifest" ] || fail "Release pointer is not a regular file: $current_manifest"

  current_sha=$(json_value "$current_manifest" sha)
  backend_image=$(json_value "$current_manifest" backend_image)
  front_image=$(json_value "$current_manifest" front_image)
  backend_id=$(json_value "$current_manifest" backend_image_id)
  front_id=$(json_value "$current_manifest" front_image_id)

  valid_sha "$current_sha" || fail "Invalid SHA in manifest: $current_manifest"
  [ "$backend_image" = "eldercare-backend:$current_sha" ] && [ "$front_image" = "eldercare-front:$current_sha" ] || fail "Invalid image tags in manifest: $current_manifest"
  [ -n "$backend_id" ] && [ -n "$front_id" ] || fail "Missing image IDs in manifest: $current_manifest"

  immutable_manifest=$RELEASES_DIR/$current_sha.json
  [ -f "$immutable_manifest" ] || fail "Release pointer immutable manifest not found: $immutable_manifest"
  cmp -s "$current_manifest" "$immutable_manifest" || fail "Release pointer does not match immutable manifest: $current_manifest"
}

git fetch --no-tags "$GIT_REMOTE" +refs/heads/main:refs/remotes/origin/main
remote_tags=$(git ls-remote --tags "$GIT_REMOTE") || fail "Unable to list release tags from $GIT_REMOTE"
candidate=$(printf '%s\n' "$remote_tags" | awk '
  $2 ~ /^refs\/tags\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/ {
    tag = $2
    sub(/^refs\/tags\//, "", tag)
    direct[tag] = $1
  }
  $2 ~ /^refs\/tags\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\^\{\}$/ {
    tag = $2
    sub(/^refs\/tags\//, "", tag)
    sub(/\^\{\}$/, "", tag)
    peeled[tag] = $1
  }
  END {
    for (tag in direct) {
      print tag "\t" (tag in peeled ? peeled[tag] : direct[tag])
    }
  }
' | sort -V | awk 'END { print }')
[ -n "$candidate" ] || fail 'No stable semantic version release tag found.'

release_tag=${candidate%%	*}
release_sha=${candidate#*	}
valid_sha "$release_sha" || fail "Release tag $release_tag did not resolve to a 40-character lowercase hexadecimal SHA."
git cat-file -e "$release_sha^{commit}" || fail "Release tag $release_tag does not resolve to a commit."
git merge-base --is-ancestor "$release_sha" refs/remotes/origin/main || fail "Release tag $release_tag is not reachable from origin/main."

if [ ! -e "$RELEASES_DIR/current.json" ]; then
  no_op=0
else
  validate_current_manifest
  if [ "$current_sha" = "$release_sha" ]; then
    no_op=1
  else
    no_op=0
  fi
fi

printf 'RELEASE_TAG=%s\nRELEASE_SHA=%s\nNO_OP=%s\n' "$release_tag" "$release_sha" "$no_op"
