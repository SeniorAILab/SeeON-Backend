#!/usr/bin/env sh
# check-migrations.sh — reject out-of-order Prisma migrations.
#
# `prisma migrate deploy` refuses a migration whose timestamp is older than the
# last one already applied. During fan-out work it's easy to author/extract a
# migration with a stale timestamp (this happened on #105: an ingest migration
# dated 20260613… landed after an alert-event migration dated 20260616…).
#
# Rule: every migration on HEAD that is NOT already on the base branch must have
# a timestamp strictly greater than the latest migration already on the base.
# Pure git — no database needed. Non-fatal on fetch failure (offline).
#
#   check-migrations.sh [base]      base defaults to main
set -eu

_gg_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/git-guard/lib.sh
. "$_gg_dir/lib.sh"

base="${1:-main}"
mig_dir="backend/prisma/migrations"

if ! git fetch --quiet origin "$base" 2>/dev/null; then
  gg_warn "check-migrations: could not fetch origin/$base — skipping"
  exit 0
fi

# 14-digit timestamp prefix of every migration directory on a ref.
list_ts() {
  git ls-tree -r --name-only "$1" -- "$mig_dir" 2>/dev/null \
    | sed -n "s#^$mig_dir/\([0-9]\{14\}\)_[^/]*/migration.sql\$#\1#p" \
    | sort -u
}

base_latest=$(list_ts "origin/$base" | tail -1)
if [ -z "$base_latest" ]; then
  exit 0  # base has no migrations yet — nothing to order against
fi

fail=0
for ts in $(list_ts HEAD); do
  # Already present on base? then it's not a new migration — skip.
  if list_ts "origin/$base" | grep -qx "$ts"; then
    continue
  fi
  # New migration: must be strictly newer than the latest already on base.
  if [ "$ts" -le "$base_latest" ]; then
    gg_warn "out-of-order migration: $ts is not after base latest $base_latest (origin/$base)"
    gg_warn "  -> rename backend/prisma/migrations/${ts}_* to a timestamp after $base_latest"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  gg_die "out-of-order Prisma migration(s) detected — would break 'prisma migrate deploy'"
fi
exit 0
