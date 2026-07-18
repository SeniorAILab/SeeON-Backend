#!/usr/bin/env sh
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 1 ] || {
  printf '%s\n' 'Usage: validate-event-media-backup.sh <backup-bundle>' >&2
  exit 2
}

BUNDLE=$1
[ ! -L "$BUNDLE" ] || fail 'backup bundle must not be a symbolic link'
[ -d "$BUNDLE" ] || fail 'backup bundle must be a directory'
[ "$(stat -c '%a' "$BUNDLE" 2>/dev/null || stat -f '%Lp' "$BUNDLE")" = 700 ] || fail 'backup bundle permissions must be 700'

manifest=$BUNDLE/MANIFEST
database_archive=$BUNDLE/database.dump
clip_archive=$BUNDLE/clips.tar
for file in "$manifest" "$database_archive" "$clip_archive"; do
  [ ! -L "$file" ] || fail 'backup artifacts must not be symbolic links'
  [ -f "$file" ] || fail 'backup bundle is missing a required artifact'
  [ "$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file")" = 600 ] || fail 'backup artifact permissions must be 600'
done

entry_count=$(find "$BUNDLE" -mindepth 1 -maxdepth 1 -print | wc -l)
[ "$entry_count" -eq 3 ] || fail 'backup bundle must contain exactly three artifacts'
[ "$(wc -l < "$manifest")" -eq 6 ] || fail 'backup manifest must contain exactly six fields'

manifest_value() {
  key=$1
  value=$(awk -F= -v key="$key" '
    $1 == key {
      count += 1
      value = substr($0, length(key) + 2)
    }
    END {
      if (count != 1) exit 2
      print value
    }
  ' "$manifest") || fail "backup manifest field is missing or duplicated: $key"
  printf '%s\n' "$value"
}

format=$(manifest_value FORMAT)
created_at=$(manifest_value CREATED_AT)
database_name=$(manifest_value DATABASE_ARCHIVE)
database_sha=$(manifest_value DATABASE_SHA256)
clip_name=$(manifest_value CLIP_ARCHIVE)
clip_sha=$(manifest_value CLIP_SHA256)

[ "$format" = event-media-backup-v1 ] || fail 'backup manifest format is unsupported'
printf '%s\n' "$created_at" | grep -Eq '^[0-9]{8}T[0-9]{6}Z$' || fail 'backup manifest timestamp is invalid'
[ "$database_name" = database.dump ] || fail 'backup database archive name is invalid'
[ "$clip_name" = clips.tar ] || fail 'backup clip archive name is invalid'
printf '%s\n' "$database_sha" | grep -Eq '^[0-9a-f]{64}$' || fail 'backup database checksum is invalid'
printf '%s\n' "$clip_sha" | grep -Eq '^[0-9a-f]{64}$' || fail 'backup clip checksum is invalid'

actual_database_sha=$(sha256sum "$database_archive" | awk '{print $1}')
[ "$actual_database_sha" = "$database_sha" ] || fail 'database archive checksum mismatch'
actual_clip_sha=$(sha256sum "$clip_archive" | awk '{print $1}')
[ "$actual_clip_sha" = "$clip_sha" ] || fail 'clip archive checksum mismatch'

tar -tf "$clip_archive" | awk '
  BEGIN { count = 0 }
  {
    count += 1
    if ($0 !~ /^\.\// || $0 ~ /(^|\/)\.\.(\/|$)/) exit 1
  }
  END { if (count == 0) exit 1 }
' || fail 'clip archive contains an unsafe member path'
tar -tvf "$clip_archive" | awk '
  {
    type = substr($1, 1, 1)
    if (type != "-" && type != "d") exit 1
  }
' || fail 'clip archive contains a non-regular member'

printf '%s\n' 'event media backup validation passed'
