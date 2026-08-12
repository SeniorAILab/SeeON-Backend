#!/usr/bin/env sh
set -eu

GIT_REMOTE=${GIT_REMOTE:-origin}
RELEASES_DIR=${RELEASES_DIR:-/opt/eldercare-fall-ai/releases}

fail() { printf '%s\n' "$*" >&2; exit 1; }
valid_sha() { [ "${#1}" -eq 40 ] && printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }
json_line_value() { printf '%s\n' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }
validate_manifest() {
  manifest=$1
  [ -f "$manifest" ] || fail "Release manifest not found: $manifest"
  manifest_snapshot=$(mktemp "${TMPDIR:-/tmp}/iwinv-manifest.XXXXXX") || fail "Unable to create release manifest snapshot: $manifest"
  trap 'rm -f "$manifest_snapshot"' 0 HUP INT TERM
  cat "$manifest" > "$manifest_snapshot" || fail "Unable to capture release manifest: $manifest"
  manifest_size=$(wc -c < "$manifest_snapshot" | awk '{print $1}')
  case "$manifest_size" in ''|*[!0-9]*) fail "Unable to determine release manifest size: $manifest" ;; esac
  [ "$manifest_size" -le 4096 ] || fail "Release manifest exceeds 4096 bytes: $manifest"
  [ "$manifest_size" -gt 0 ] || fail "Invalid release manifest canonical form: $manifest"
  allowed_size=$(LC_ALL=C tr -cd '\40-\176\n' < "$manifest_snapshot" | wc -c | awk '{print $1}')
  [ "$allowed_size" = "$manifest_size" ] || fail "Invalid release manifest byte alphabet: $manifest"
  newline_count=$(LC_ALL=C tr -cd '\n' < "$manifest_snapshot" | wc -c | awk '{print $1}')
  [ "$newline_count" = 1 ] || fail "Invalid release manifest newline contract: $manifest"
  final_newline_count=$(tail -c 1 "$manifest_snapshot" | LC_ALL=C tr -cd '\n' | wc -c | awk '{print $1}')
  [ "$final_newline_count" = 1 ] || fail "Invalid release manifest newline contract: $manifest"

  RELEASE_MANIFEST_LINE=$(cat "$manifest_snapshot")
  [ "$((${#RELEASE_MANIFEST_LINE} + 1))" -eq "$manifest_size" ] || fail "Invalid release manifest captured bytes: $manifest"
  rm -f "$manifest_snapshot"
  trap - 0 HUP INT TERM

  hex40='[0-9a-f]{40}'
  hex64='[0-9a-f]{64}'
  timestamp='20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z'
  dump='normal-[A-Za-z0-9._-]{1,200}\.dump'
  schema_one="^\\{\"sha\":\"$hex40\",\"backend_image\":\"eldercare-backend:$hex40\",\"backend_image_id\":\"sha256:$hex64\",\"front_image\":\"eldercare-front:$hex40\",\"front_image_id\":\"sha256:$hex64\",\"compose_sha256\":\"$hex64\",\"env_sha256\":\"$hex64\",\"pre_migration_dump\":\"$dump\",\"timestamp\":\"$timestamp\"\\}$"
  schema_two="^\\{\"schema\":\"2\",\"sha\":\"$hex40\",\"backend_image\":\"eldercare-backend:$hex40\",\"backend_image_id\":\"sha256:$hex64\",\"api_ingress_image\":\"eldercare-api-ingress:$hex40\",\"api_ingress_image_id\":\"sha256:$hex64\",\"compose_sha256\":\"$hex64\",\"env_sha256\":\"$hex64\",\"pre_migration_dump\":\"$dump\",\"timestamp\":\"$timestamp\"\\}$"
  schema_two_transitional="^\\{\"schema\":\"2\",\"sha\":\"$hex40\",\"backend_image\":\"eldercare-backend:$hex40\",\"backend_image_id\":\"sha256:$hex64\",\"api_ingress_image\":\"eldercare-api-ingress:$hex40\",\"api_ingress_image_id\":\"sha256:$hex64\",\"embedded_front_image\":\"eldercare-front:$hex40\",\"embedded_front_image_id\":\"sha256:$hex64\",\"compose_sha256\":\"$hex64\",\"env_sha256\":\"$hex64\",\"pre_migration_dump\":\"$dump\",\"timestamp\":\"$timestamp\"\\}$"

  if printf '%s\n' "$RELEASE_MANIFEST_LINE" | LC_ALL=C grep -Eq "$schema_one"; then
    MANIFEST_SCHEMA=1
  elif printf '%s\n' "$RELEASE_MANIFEST_LINE" | LC_ALL=C grep -Eq "$schema_two"; then
    MANIFEST_SCHEMA=2
  elif printf '%s\n' "$RELEASE_MANIFEST_LINE" | LC_ALL=C grep -Eq "$schema_two_transitional"; then
    MANIFEST_SCHEMA=2
  else
    fail "Invalid release manifest canonical form: $manifest"
  fi
  manifest_dump=$(json_line_value "$RELEASE_MANIFEST_LINE" pre_migration_dump)
  case "$manifest_dump" in *..*|*/*|'') fail "Invalid release manifest dump field: $manifest" ;; esac
}

validate_current_manifest() {
  current_manifest=$RELEASES_DIR/current.json
  [ -f "$current_manifest" ] || fail "Release pointer is not a regular file: $current_manifest"

  validate_manifest "$current_manifest"
  schema=$MANIFEST_SCHEMA

  current_sha=$(json_line_value "$RELEASE_MANIFEST_LINE" sha)
  backend_image=$(json_line_value "$RELEASE_MANIFEST_LINE" backend_image)
  backend_id=$(json_line_value "$RELEASE_MANIFEST_LINE" backend_image_id)
  valid_sha "$current_sha" || fail "Invalid SHA in manifest: $current_manifest"
  [ "$backend_image" = "eldercare-backend:$current_sha" ] || fail "Invalid image tags in manifest: $current_manifest"
  [ -n "$backend_id" ] || fail "Missing image IDs in manifest: $current_manifest"

  if [ "$schema" = 1 ]; then
    front_image=$(json_line_value "$RELEASE_MANIFEST_LINE" front_image)
    front_id=$(json_line_value "$RELEASE_MANIFEST_LINE" front_image_id)
    [ "$front_image" = "eldercare-front:$current_sha" ] || fail "Invalid image tags in manifest: $current_manifest"
    [ -n "$front_id" ] || fail "Missing image IDs in manifest: $current_manifest"
  else
    api_ingress_image=$(json_line_value "$RELEASE_MANIFEST_LINE" api_ingress_image)
    api_ingress_id=$(json_line_value "$RELEASE_MANIFEST_LINE" api_ingress_image_id)
    front_image=$(json_line_value "$RELEASE_MANIFEST_LINE" embedded_front_image)
    front_id=$(json_line_value "$RELEASE_MANIFEST_LINE" embedded_front_image_id)
    [ "$api_ingress_image" = "eldercare-api-ingress:$current_sha" ] || fail "Invalid image tags in manifest: $current_manifest"
    [ -n "$api_ingress_id" ] || fail "Missing image IDs in manifest: $current_manifest"
    if [ -n "$front_image" ] || [ -n "$front_id" ]; then
      [ "$front_image" = "eldercare-front:$current_sha" ] || fail "Invalid image tags in manifest: $current_manifest"
      [ -n "$front_id" ] || fail "Missing image IDs in manifest: $current_manifest"
    fi
  fi

  immutable_manifest=$RELEASES_DIR/$current_sha.json
  [ -f "$immutable_manifest" ] || fail "Release pointer immutable manifest not found: $immutable_manifest"
  printf '%s\n' "$RELEASE_MANIFEST_LINE" | cmp -s - "$immutable_manifest" || fail "Release pointer does not match immutable manifest: $current_manifest"
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
