#!/usr/bin/env sh
# sync-main.sh — fast-forward the local default branch to origin before work.
#
# Wired into SessionStart so every session starts from a fresh main. Safe by
# construction:
#   - fetch + FAST-FORWARD only; never force, never rebase a feature branch.
#   - on the default branch: ff-merge in place, skipped if the tree is dirty or
#     the branch has diverged.
#   - on a feature branch / worktree: advance the local default ref via a local
#     ff-only fetch. git refuses to update a branch checked out in another
#     worktree, so the main checkout is never corrupted — it self-syncs on its
#     own session start.
#   - non-fatal everywhere (offline, diverged, checked-out-elsewhere). Always
#     exits 0 so it can never block a session.
set -eu

_gg_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/git-guard/lib.sh
. "$_gg_dir/lib.sh"

# Resolve the default branch from origin/HEAD, falling back to main.
default=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null \
  | sed 's@^refs/remotes/origin/@@')
[ -n "$default" ] || default=main

if ! git fetch --quiet origin "$default" 2>/dev/null; then
  gg_warn "sync-main: fetch failed (offline?) — skipped"
  exit 0
fi

remote_ref="refs/remotes/origin/$default"
git rev-parse --verify --quiet "$remote_ref" >/dev/null 2>&1 || exit 0

current=$(gg_current_branch)

if [ "$current" = "$default" ]; then
  # Default branch checked out here (e.g. the main checkout): ff in place.
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    gg_warn "sync-main: working tree dirty — skipped ff of $default"
    exit 0
  fi
  before=$(git rev-parse HEAD 2>/dev/null || true)
  if git merge --ff-only "$remote_ref" >/dev/null 2>&1; then
    after=$(git rev-parse HEAD 2>/dev/null || true)
    [ "$before" != "$after" ] && gg_warn "sync-main: fast-forwarded $default to origin/$default"
  else
    gg_warn "sync-main: $default diverged from origin/$default — not fast-forwarding (resolve manually)"
  fi
  exit 0
fi

# Feature branch / worktree: ff the local default ref without checkout.
# A local ff-only fetch refuses (harmlessly) if $default is checked out in
# another worktree or has diverged; origin/$default is fresh either way.
git fetch --quiet . "$remote_ref:refs/heads/$default" 2>/dev/null || true
exit 0
