#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/event-media-backup.sh
TMP=$(mktemp -d)
OFF_HOST_ROOT=/dev/shm/event-media-backup-inputs-$$

cleanup() {
  status=$?
  rm -rf "$TMP" "$OFF_HOST_ROOT"
  trap - 0 HUP INT TERM
  exit "$status"
}
trap cleanup 0 HUP INT TERM

mkdir -p "$TMP/app/repo" "$OFF_HOST_ROOT"
chmod 700 "$OFF_HOST_ROOT"
printf '%s\n' 'eldercare-event-media-backup-v1' > "$OFF_HOST_ROOT/.eldercare-event-media-backup"
chmod 600 "$OFF_HOST_ROOT/.eldercare-event-media-backup"
printf '%s\n' 'services: {}' > "$TMP/app/repo/compose.yaml"
printf '%s\n' 'services: {}' > "$TMP/app/repo/compose.prod.yaml"
printf '%s\n' 'SYNTHETIC_SECRET=must-not-leak' > "$TMP/app/env"
chmod 600 "$TMP/app/env"

run_check() {
  APP_ROOT=$TMP/app \
  APP_DIR=$TMP/app/repo \
  ENV_FILE=$TMP/app/env \
  BACKUP_DESTINATION=$1 \
  CLIP_VOLUME_NAME=$2 \
    sh "$SCRIPT" --check-inputs-only 2>&1
}

assert_failure() {
  [ "$1" -ne 0 ] || {
    printf '%s\n' 'backup input check unexpectedly passed' >&2
    exit 1
  }
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) printf 'missing expected output: %s\n' "$2" >&2; exit 1 ;;
  esac
}

assert_redacted() {
  case "$1" in
    *must-not-leak*) printf '%s\n' 'backup input check leaked env content' >&2; exit 1 ;;
    *) ;;
  esac
}

# Given an owner-only destination on a separate filesystem, when checked, then
# the backup inputs are accepted without exposing environment values.
output=$(run_check "$OFF_HOST_ROOT" event_media_fixture)
assert_contains "$output" 'event media backup inputs verified'
assert_redacted "$output"

# Given a destination on the application filesystem, when checked, then the
# off-host contract fails before Docker can be touched.
same_filesystem=$TMP/same-filesystem
mkdir -p "$same_filesystem"
chmod 700 "$same_filesystem"
printf '%s\n' 'eldercare-event-media-backup-v1' > "$same_filesystem/.eldercare-event-media-backup"
chmod 600 "$same_filesystem/.eldercare-event-media-backup"
set +e
output=$(run_check "$same_filesystem" event_media_fixture); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'backup destination must be on a separate mounted filesystem'
assert_redacted "$output"

# Given a distinct synthetic mount target backed by the same device as the
# application, when checked, then a bind-mount-shaped path cannot satisfy the
# off-host failure-domain contract.
same_device_distinct=$TMP/distinct-target
mock_bin=$TMP/mock-bin
real_findmnt=$(command -v findmnt)
mkdir -p "$same_device_distinct" "$mock_bin"
chmod 700 "$same_device_distinct"
printf '%s\n' 'eldercare-event-media-backup-v1' > "$same_device_distinct/.eldercare-event-media-backup"
chmod 600 "$same_device_distinct/.eldercare-event-media-backup"
printf '%s\n' \
  '#!/usr/bin/env sh' \
  'target=' \
  'previous=' \
  'for argument do' \
  '  if [ "$previous" = -T ]; then target=$argument; break; fi' \
  '  previous=$argument' \
  'done' \
  'case "$target" in' \
  '  */distinct-target) printf "%s\\n" /synthetic/off-host ;;' \
  "  *) exec '$real_findmnt' \"\$@\" ;;" \
  'esac' > "$mock_bin/findmnt"
chmod 700 "$mock_bin/findmnt"
set +e
output=$(PATH="$mock_bin:$PATH" run_check "$same_device_distinct" event_media_fixture); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'backup destination must be on a separate mounted filesystem'
assert_redacted "$output"

# Given an unmarked destination, when checked, then accidental local storage is
# rejected.
rm -f "$OFF_HOST_ROOT/.eldercare-event-media-backup"
set +e
output=$(run_check "$OFF_HOST_ROOT" event_media_fixture); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'backup destination marker is required'
assert_redacted "$output"
printf '%s\n' 'eldercare-event-media-backup-v1' > "$OFF_HOST_ROOT/.eldercare-event-media-backup"
chmod 600 "$OFF_HOST_ROOT/.eldercare-event-media-backup"

# Given a group-readable environment file, when checked, then secrets cannot be
# consumed from the weak file.
chmod 640 "$TMP/app/env"
set +e
output=$(run_check "$OFF_HOST_ROOT" event_media_fixture); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'environment file permissions must be 400 or 600'
assert_redacted "$output"
chmod 600 "$TMP/app/env"

# Given an unsafe Docker volume token, when checked, then it cannot reach a
# command boundary.
set +e
output=$(run_check "$OFF_HOST_ROOT" 'clips;unexpected'); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'clip volume name contains unsupported characters'
assert_redacted "$output"

# Given an uppercase Compose project token, when checked, then it is rejected
# before Compose can normalize it to a different project.
set +e
output=$(APP_ROOT=$TMP/app APP_DIR=$TMP/app/repo ENV_FILE=$TMP/app/env \
  BACKUP_DESTINATION=$OFF_HOST_ROOT CLIP_VOLUME_NAME=event_media_fixture \
  COMPOSE_PROJECT_NAME=UnsafeProject sh "$SCRIPT" --check-inputs-only 2>&1); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'compose project name contains unsupported characters'
assert_redacted "$output"

# Given a symlinked release environment file, when checked, then image metadata
# cannot be substituted through an untrusted path.
mkdir -p "$TMP/app/shared"
printf '%s\n' 'BACKEND_IMAGE=synthetic' > "$TMP/app/shared/release-images.real"
chmod 600 "$TMP/app/shared/release-images.real"
ln -s "$TMP/app/shared/release-images.real" "$TMP/app/shared/release-images.env"
set +e
output=$(run_check "$OFF_HOST_ROOT" event_media_fixture); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'release environment file must not be a symbolic link'
assert_redacted "$output"
rm "$TMP/app/shared/release-images.env"

# Given a symlinked environment input, when checked, then path substitution is
# rejected.
mv "$TMP/app/env" "$TMP/app/env.real"
ln -s "$TMP/app/env.real" "$TMP/app/env"
set +e
output=$(run_check "$OFF_HOST_ROOT" event_media_fixture); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'environment file must not be a symbolic link'
assert_redacted "$output"

printf '%s\n' 'event media backup input tests passed'
