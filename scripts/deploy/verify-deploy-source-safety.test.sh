#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/verify-deploy-source-safety.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
SAFE=$TMP/safe.sh
printf '%s\n' '#!/bin/sh' 'docker volume inspect repo_clips' 'docker image rm eldercare-backend:stale' > "$SAFE"

sh "$SCRIPT" "$SAFE" >/dev/null

assert_rejected() {
  command=$1
  printf '%s\n' '#!/bin/sh' "$command" > "$TMP/unsafe.sh"
  set +e
  output=$(sh "$SCRIPT" "$TMP/unsafe.sh" 2>&1); status=$?
  set -e
  [ "$status" -ne 0 ] || { printf 'unsafe deploy command passed: %s\n' "$command" >&2; exit 1; }
  case "$output" in *'destructive Docker prune/remove command is forbidden'*) ;; *) printf '%s\n' "$output" >&2; exit 1;; esac
}

assert_rejected 'docker volume rm repo_clips'
assert_rejected 'docker volume prune -f'
assert_rejected 'docker system prune --volumes -f'
assert_rejected 'docker image prune -a -f'
assert_rejected 'docker compose down -v'
assert_rejected 'docker compose rm -v backend'

# The checked-in deployment path must satisfy the same no-volume-prune contract.
sh "$SCRIPT"

printf '%s\n' 'deploy source destructive-prune contract tests passed'
