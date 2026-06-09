#!/usr/bin/env sh
# Idempotent post-clone setup:
#   - sets core.hooksPath to .githooks  (enables git-native enforcement)
#   - registers the `git wt` alias      (issue->worktree front door)
#   - chmod +x all hooks and guard scripts
#
# Safe to re-run — git config is idempotent, chmod on already-executable files is a no-op.
set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"

# 1. Point git at the committed hooks directory.
git config core.hooksPath .githooks

# 2. Register `git wt` as an alias that runs wt.sh from the repo root.
git config alias.wt '!sh "$(git rev-parse --show-toplevel)/scripts/git-guard/wt.sh"'

# 3. Ensure all hook + guard scripts are executable.
chmod +x .githooks/pre-commit \
         .githooks/pre-push \
         scripts/git-guard/lib.sh \
         scripts/git-guard/assert-not-main.sh \
         scripts/git-guard/check-freshness.sh \
         scripts/git-guard/wt.sh \
         scripts/git-guard/setup-hooks.sh

# 4. Confirmation summary.
printf '[git-guard] core.hooksPath  = %s\n' "$(git config core.hooksPath)"
printf '[git-guard] alias.wt        = %s\n' "$(git config alias.wt)"
printf '[git-guard] hooks active    : .githooks/pre-commit  .githooks/pre-push\n'
printf '[git-guard] guard scripts   : scripts/git-guard/\n'
printf '[git-guard] setup complete  — run `git wt <issue#>` to start work on an issue.\n'
