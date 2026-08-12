#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)

fail() { printf '%s\n' "$1" >&2; exit 1; }

if [ "$#" -eq 0 ]; then
  set -- \
    "$REPO_ROOT/Jenkinsfile" \
    "$REPO_ROOT/scripts/deploy/iwinv-overlap-readiness.sh" \
    "$REPO_ROOT/scripts/deploy/iwinv-deploy.sh"
fi

for source_file do
  [ -f "$source_file" ] || fail "deploy source file is required: $source_file"
  if grep -Eiq \
    'docker[[:space:]]+(volume[[:space:]]+(rm|prune)|system[[:space:]]+prune|image[[:space:]]+prune)|docker[[:space:]]+compose([^[:alnum:]_]|.*[[:space:]])(down([^[:alnum:]_]|.*[[:space:]])[^#]*(--volumes|-v)([^[:alnum:]_]|$)|rm([^[:alnum:]_]|.*[[:space:]])[^#]*(--volumes|-v)([^[:alnum:]_]|$))' \
    "$source_file"; then
    fail "destructive Docker prune/remove command is forbidden: $source_file"
  fi
done

printf '%s\n' 'deploy sources preserve named volumes and protected image pruning'
