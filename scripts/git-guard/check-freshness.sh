#!/usr/bin/env sh
# Check whether the current branch is behind its upstream.
#   check-freshness.sh block   -> exit non-zero when behind (used by pre-push)
#   check-freshness.sh warn     -> warn only, never blocks (used by pre-commit / SessionStart)
# A branch with no upstream (brand new) passes with a warning.
set -eu

_gg_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/git-guard/lib.sh
. "$_gg_dir/lib.sh"

mode="${1:-warn}"

upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)
if [ -z "$upstream" ]; then
  gg_warn "current branch has no upstream — skipping freshness check"
  exit 0
fi

git fetch --quiet 2>/dev/null || gg_warn "git fetch failed (offline?) — freshness may be out of date"

behind=$(git rev-list --count "HEAD..$upstream" 2>/dev/null || printf '0')
if [ "${behind:-0}" -gt 0 ]; then
  msg="branch is $behind commit(s) behind $upstream — sync before continuing (git pull --rebase)"
  if [ "$mode" = "block" ]; then
    gg_die "$msg"
  fi
  gg_warn "$msg"
fi
exit 0
