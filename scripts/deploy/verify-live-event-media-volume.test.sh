#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/verify-live-event-media-volume.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/bin"
: > "$TMP/host.env"

cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env sh
printf 'docker %s\n' "$*" >> "${DOCKER_LOG:?}"
case "$1 $2" in
  'volume inspect')
    [ "${MOCK_VOLUME_STATE:-ok}" != missing ] || exit 1
    [ "${MOCK_VOLUME_STATE:-ok}" != wrong-name ] || { printf '%s\n' other_clips; exit 0; }
    printf '%s\n' repo_clips
    ;;
  'compose --env-file')
    [ "${EVENT_CLIPS_ENABLED+x}" != x ] || exit 91
    case " $* " in
      *' ps -q --status running backend '*)
        [ "${MOCK_BACKEND_STATE:-ok}" != missing ] || exit 0
        printf '%s\n' backend-container
        [ "${MOCK_BACKEND_STATE:-ok}" != duplicate ] || printf '%s\n' second-backend
        ;;
      *) exit 1 ;;
    esac
    ;;
  'inspect --format')
    if [ "${MOCK_MOUNT_STATE:-ok}" = wrong-source ]; then
      printf '%s\n' 'volume|other_clips|/app/backend/clips'
    elif [ "${MOCK_MOUNT_STATE:-ok}" = wrong-target ]; then
      printf '%s\n' 'volume|repo_clips|/app/backend/other'
    elif [ "${MOCK_MOUNT_STATE:-ok}" = bind ]; then
      printf '%s\n' 'bind||/app/backend/clips'
    else
      printf '%s\n' 'volume|repo_clips|/app/backend/clips'
    fi
    ;;
  'exec backend-container')
    [ "${MOCK_READABLE_STATE:-ok}" = ok ]
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$TMP/bin/docker"

run_check() {
  PATH="$TMP/bin:$PATH" APP_DIR="$REPO_ROOT" ENV_FILE="$TMP/host.env" DOCKER_LOG="$TMP/docker.log" \
    MOCK_VOLUME_STATE="${TEST_VOLUME_STATE:-ok}" MOCK_BACKEND_STATE="${TEST_BACKEND_STATE:-ok}" \
    MOCK_MOUNT_STATE="${TEST_MOUNT_STATE:-ok}" MOCK_READABLE_STATE="${TEST_READABLE_STATE:-ok}" \
    sh "$SCRIPT" 2>&1
}
assert_failure() { [ "$1" -ne 0 ] || { printf '%s\n' 'live volume check unexpectedly passed' >&2; exit 1; }; }
assert_contains() { case "$1" in *"$2"*) ;; *) printf 'missing expected output: %s\n%s\n' "$2" "$1" >&2; exit 1;; esac; }

: > "$TMP/docker.log"
output=$(EVENT_CLIPS_ENABLED=true run_check)
assert_contains "$output" 'live event-media volume verified: repo_clips'
grep -F 'volume inspect --format {{.Name}} repo_clips' "$TMP/docker.log" >/dev/null
grep -F 'exec backend-container sh -c test -d /app/backend/clips && test -r /app/backend/clips' "$TMP/docker.log" >/dev/null

for state in missing wrong-name; do
  : > "$TMP/docker.log"
  set +e
  output=$(TEST_VOLUME_STATE=$state run_check); status=$?
  set -e
  assert_failure "$status"
  assert_contains "$output" 'exact named volume repo_clips is required'
done

for state in wrong-source wrong-target bind; do
  : > "$TMP/docker.log"
  set +e
  output=$(TEST_MOUNT_STATE=$state run_check); status=$?
  set -e
  assert_failure "$status"
  assert_contains "$output" 'backend clips mount must be volume repo_clips at /app/backend/clips'
done

set +e
output=$(TEST_BACKEND_STATE=missing run_check); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'exactly one running backend is required for live media verification'

set +e
output=$(TEST_READABLE_STATE=fail run_check); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'backend cannot read the repo_clips mount'

case "$(cat "$TMP/docker.log")" in
  *' volume rm '*|*' volume prune '*|*' system prune '*)
    printf '%s\n' 'live volume verification attempted destructive pruning' >&2
    exit 1
    ;;
esac

printf '%s\n' 'live event-media volume contract tests passed'
