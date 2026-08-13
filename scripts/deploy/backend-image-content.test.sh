#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
DOCKERFILE=$REPO_ROOT/backend/Dockerfile
SHA=0123456789abcdef0123456789abcdef01234567
IMAGE=seeon-backend-content-contract-$$:$SHA
BUILT=0
cleanup() {
  status=$?
  if [ "$BUILT" -eq 1 ]; then
    docker image rm -f "$IMAGE" >/dev/null 2>&1 || [ "$status" -ne 0 ] || status=1
  fi
  trap - EXIT HUP INT TERM
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

docker build --file "$DOCKERFILE" --build-arg "DEPLOY_SHA=$SHA" --tag "$IMAGE" "$REPO_ROOT" >/dev/null
BUILT=1

[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")" = "$SHA" ]
residue=$(docker run --rm --entrypoint sh "$IMAGE" -c \
  "find dist -type f \( -name '*.spec.js' -o -name '*.spec.js.map' -o -name '*.spec.d.ts' \) -print")
if [ -n "$residue" ]; then
  printf '%s\n' 'production backend image contains compiled spec files:' >&2
  printf '%s\n' "$residue" >&2
  exit 1
fi
if docker run --rm --entrypoint sh "$IMAGE" -c \
  "grep -R -n -F 'SYSTEM_TEST' dist >/dev/null"; then
  printf '%s\n' 'production backend dist contains retired SYSTEM_TEST tokens' >&2
  exit 1
fi

printf '%s\n' 'backend production image content contract tests passed'
