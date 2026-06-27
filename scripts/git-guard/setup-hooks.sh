#!/usr/bin/env sh
# Idempotent post-clone setup:
#   - sets core.hooksPath to .githooks  (enables git-native enforcement)
#   - chmod +x all hooks and guard scripts
#
# Safe to re-run — git config is idempotent, chmod on already-executable files is a no-op.
set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"

# 1. Point git at the committed hooks directory.
git config core.hooksPath .githooks

# 2. Ensure all hook + guard scripts are executable.
chmod +x .githooks/pre-commit \
         .githooks/pre-push \
         scripts/git-guard/lib.sh \
         scripts/git-guard/assert-not-main.sh \
         scripts/git-guard/check-freshness.sh \
         scripts/git-guard/sync-main.sh \
         scripts/git-guard/check-migrations.sh \
         scripts/git-guard/setup-hooks.sh \
         scripts/backend-guard/check-schema-migration.sh

# 3. Confirmation summary.
printf '[git-guard] core.hooksPath  = %s\n' "$(git config core.hooksPath)"
printf '[git-guard] hooks active    : .githooks/pre-commit  .githooks/pre-push\n'
printf '[git-guard] session start   : sync-main (ff main) + check-freshness (warn)\n'
printf '[git-guard] guard scripts   : scripts/git-guard/\n'
printf '[git-guard] backend guard   : scripts/backend-guard/ (schema↔migration coupling)\n'
printf '[git-guard] setup complete  — open an idle lane and branch with `git switch -c <type>/<issue#>-<slug> origin/main` (see docs/rules/worktree-workflow.md).\n'
