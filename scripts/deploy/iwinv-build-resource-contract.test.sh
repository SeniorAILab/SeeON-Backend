#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
jenkinsfile="$repo_root/Jenkinsfile"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

assert_count() {
  expected=$1
  needle=$2
  actual=$(grep -c -F -- "$needle" "$jenkinsfile" || :)
  [ "$actual" -eq "$expected" ] || fail "expected $expected occurrence(s) of '$needle', got $actual"
}

assert_count 1 'disableConcurrentBuilds()'
assert_count 1 "NODE_OPTIONS = '--max-old-space-size=1536'"
assert_count 1 'max-parallelism = 1'
assert_count 1 '--driver-opt memory=2560m,memory-swap=4096m'
assert_count 2 '--resource memory=2g --resource memory-swap=3g'

mutated=$(mktemp)
trap 'rm -f "$mutated"' EXIT HUP INT TERM
sed 's/memory=2560m,memory-swap=4096m/memory=4096m,memory-swap=4096m/' "$jenkinsfile" >"$mutated"
if grep -Fq -- '--driver-opt memory=2560m,memory-swap=4096m' "$mutated"; then
  fail 'mutation proof failed: builder memory limit survived mutation'
fi
sed 's/--resource memory=2g --resource memory-swap=3g/--resource memory=4g --resource memory-swap=4g/g' "$jenkinsfile" >"$mutated"
mutated_count=$(grep -c -F -- '--resource memory=2g --resource memory-swap=3g' "$mutated" || :)
[ "$mutated_count" -eq 0 ] || fail 'mutation proof failed: build memory limits survived mutation'

printf 'IWINV build resource contract verified.\n'
