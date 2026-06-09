#!/usr/bin/env sh
# Refuse to proceed when HEAD is on a protected branch.
# Invoked by .githooks/pre-commit, .githooks/pre-push, and the agent hooks.
set -eu

_gg_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/git-guard/lib.sh
. "$_gg_dir/lib.sh"

branch=$(gg_current_branch)
if gg_is_protected "$branch"; then
  gg_die "You are on protected branch '$branch' — don't work here.
  -> Create an isolated worktree for an issue:   git wt <issue#>
  -> Why / how:                                  docs/rules/worktree-workflow.md
  -> Deliberate maintenance escape hatch:        GIT_GUARD_PROTECTED= git <cmd>"
fi
