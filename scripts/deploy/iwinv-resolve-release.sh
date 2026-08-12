#!/usr/bin/env sh
set -eu

GIT_REMOTE=${GIT_REMOTE:-origin}
RELEASES_DIR=${RELEASES_DIR:-/opt/eldercare-fall-ai/releases}

fail() { printf '%s\n' "$*" >&2; exit 1; }
valid_sha() { [ "${#1}" -eq 40 ] && printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }
json_value() { sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1"; }
validate_manifest_json() {
  command -v node >/dev/null 2>&1 || fail 'Missing required command: node'
  node - "$1" <<'NODE'
const fs = require('node:fs');
const manifestPath = process.argv[2];
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch {
  console.error(`Malformed release manifest JSON: ${manifestPath}`);
  process.exit(1);
}
if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
  console.error(`Invalid release manifest shape: ${manifestPath}`);
  process.exit(1);
}
const hasSchema = Object.hasOwn(manifest, 'schema');
const schema = hasSchema ? manifest.schema : '1';
if (hasSchema && schema !== '2') {
  console.error(`Unsupported release manifest schema: ${manifestPath}`);
  process.exit(1);
}
const schemaOneKeys = [
  'sha', 'backend_image', 'backend_image_id', 'front_image', 'front_image_id',
  'compose_sha256', 'env_sha256', 'pre_migration_dump', 'timestamp',
];
const schemaTwoKeys = [
  'schema', 'sha', 'backend_image', 'backend_image_id', 'api_ingress_image',
  'api_ingress_image_id', 'compose_sha256', 'env_sha256',
  'pre_migration_dump', 'timestamp',
];
const transitionalKeys = [
  ...schemaTwoKeys, 'embedded_front_image', 'embedded_front_image_id',
];
const actualKeys = Object.keys(manifest).sort();
const expectedLayouts = schema === '1'
  ? [schemaOneKeys]
  : [schemaTwoKeys, transitionalKeys];
const exactLayout = expectedLayouts.some((keys) => {
  const expected = [...keys].sort();
  return expected.length === actualKeys.length &&
    expected.every((key, index) => key === actualKeys[index]);
});
if (!exactLayout || Object.values(manifest).some((value) => typeof value !== 'string')) {
  console.error(`Invalid release manifest shape: ${manifestPath}`);
  process.exit(1);
}
process.stdout.write(schema);
NODE
}

validate_current_manifest() {
  current_manifest=$RELEASES_DIR/current.json
  [ -f "$current_manifest" ] || fail "Release pointer is not a regular file: $current_manifest"

  schema=$(validate_manifest_json "$current_manifest")

  current_sha=$(json_value "$current_manifest" sha)
  backend_image=$(json_value "$current_manifest" backend_image)
  backend_id=$(json_value "$current_manifest" backend_image_id)
  valid_sha "$current_sha" || fail "Invalid SHA in manifest: $current_manifest"
  [ "$backend_image" = "eldercare-backend:$current_sha" ] || fail "Invalid image tags in manifest: $current_manifest"
  [ -n "$backend_id" ] || fail "Missing image IDs in manifest: $current_manifest"

  if [ "$schema" = 1 ]; then
    front_image=$(json_value "$current_manifest" front_image)
    front_id=$(json_value "$current_manifest" front_image_id)
    [ "$front_image" = "eldercare-front:$current_sha" ] || fail "Invalid image tags in manifest: $current_manifest"
    [ -n "$front_id" ] || fail "Missing image IDs in manifest: $current_manifest"
  else
    api_ingress_image=$(json_value "$current_manifest" api_ingress_image)
    api_ingress_id=$(json_value "$current_manifest" api_ingress_image_id)
    front_image=$(json_value "$current_manifest" embedded_front_image)
    front_id=$(json_value "$current_manifest" embedded_front_image_id)
    [ "$api_ingress_image" = "eldercare-api-ingress:$current_sha" ] || fail "Invalid image tags in manifest: $current_manifest"
    [ -n "$api_ingress_id" ] || fail "Missing image IDs in manifest: $current_manifest"
    if [ -n "$front_image" ] || [ -n "$front_id" ]; then
      [ "$front_image" = "eldercare-front:$current_sha" ] || fail "Invalid image tags in manifest: $current_manifest"
      [ -n "$front_id" ] || fail "Missing image IDs in manifest: $current_manifest"
    fi
  fi

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
