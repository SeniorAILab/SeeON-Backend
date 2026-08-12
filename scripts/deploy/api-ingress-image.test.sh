#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
DOCKERFILE=$REPO_ROOT/infra/api-ingress/Dockerfile
SHA=0123456789abcdef0123456789abcdef01234567
IMAGE=seeon-api-ingress-contract-$$:$SHA
BUILT=0
cleanup() {
  status=$?
  if [ "$BUILT" -eq 1 ]; then docker image rm -f "$IMAGE" >/dev/null 2>&1 || [ "$status" -ne 0 ] || status=1; fi
  trap - EXIT HUP INT TERM
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

expect_build_failure() {
  value=$1
  if docker build --file "$DOCKERFILE" --build-arg "DEPLOY_SHA=$value" "$REPO_ROOT" >/dev/null 2>&1; then
    printf 'API ingress image accepted invalid DEPLOY_SHA: %s\n' "$value" >&2
    exit 1
  fi
}

expect_build_failure ''
expect_build_failure 0123456789ABCDEF0123456789abcdef01234567
docker build --file "$DOCKERFILE" --build-arg "DEPLOY_SHA=$SHA" --tag "$IMAGE" "$REPO_ROOT" >/dev/null
BUILT=1
[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")" = "$SHA" ]
docker run --rm --entrypoint nginx "$IMAGE" -t >/dev/null

printf '%s\n' 'API ingress exact-SHA image contract tests passed'
