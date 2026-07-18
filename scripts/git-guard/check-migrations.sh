#!/usr/bin/env sh
# check-migrations.sh — reject out-of-order or misnamed Prisma migrations.
#
# `prisma migrate deploy` refuses a migration whose timestamp is older than the
# last one already applied. During fan-out work it's easy to author/extract a
# migration with a stale timestamp (this happened on #105: an ingest migration
# dated 20260613… landed after an alert-event migration dated 20260616…).
#
# Rules (applied to migrations on HEAD that are NOT already on the base branch):
#   1. directory name must be <14-digit-timestamp>_<snake_case_suffix>
#      (a bare timestamp without suffix is invisible to ordering tools and to
#      humans scanning the history — reject it before it lands)
#   2. timestamp must be strictly greater than the latest migration on base
#
# Pure git — no database needed. Non-fatal on fetch failure (offline).
# Runs from .githooks/pre-push and CI (ci.yml backend job).
#
#   check-migrations.sh [base] [--fix]     base defaults to main
#
# --fix renumbers out-of-order migration directories in the working tree
# (git mv) to fresh timestamps that sort after everything on base and HEAD,
# preserving their relative order. After --fix: commit the rename and reset
# your local dev DB (pnpm backend:db:reset) so applied-migration history
# matches the new names.
set -eu

_gg_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/git-guard/lib.sh
. "$_gg_dir/lib.sh"

base="main"
fix=0
for arg in "$@"; do
  case "$arg" in
    --fix) fix=1 ;;
    *) base="$arg" ;;
  esac
done
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

# Top-level entries (directory names) under the migrations dir on a ref.
# The trailing slash is required: without it ls-tree returns the directory
# entry itself instead of its children.
list_dirs() {
  git ls-tree --name-only "$1" -- "$mig_dir/" 2>/dev/null \
    | sed -n "s#^$mig_dir/##p" \
    | grep -v '^migration_lock\.toml$' || true
}

fail=0

# Rule 1: new migration directories must be <14-digit-timestamp>_<suffix>.
base_dirs=$(list_dirs "origin/$base")
for dir in $(list_dirs HEAD); do
  if printf '%s\n' "$base_dirs" | grep -qx "$dir"; then
    continue  # already on base — grandfathered
  fi
  if ! printf '%s' "$dir" | grep -Eq '^[0-9]{14}_[a-z0-9_]+$'; then
    gg_warn "misnamed migration: $mig_dir/$dir"
    gg_warn "  -> use <14-digit-timestamp>_<snake_case_description> (e.g. 20260718120000_add_alert_index)"
    fail=1
  fi
done

# Rule 2: new migrations must be strictly newer than the latest already on base.
base_latest=$(list_ts "origin/$base" | tail -1)
if [ -n "$base_latest" ]; then
  # Highest timestamp anywhere (base or HEAD) — --fix renames must sort after it.
  max_ts=$base_latest
  for ts in $(list_ts HEAD); do
    [ "$ts" -gt "$max_ts" ] && max_ts=$ts
  done
  next_ts=$(date -u +%Y%m%d%H%M%S)
  [ "$next_ts" -le "$max_ts" ] && next_ts=$((max_ts + 1))

  for ts in $(list_ts HEAD); do
    if list_ts "origin/$base" | grep -qx "$ts"; then
      continue
    fi
    if [ "$ts" -le "$base_latest" ]; then
      if [ "$fix" = 1 ]; then
        renamed=0
        for old_path in "$mig_dir/${ts}_"*; do
          [ -d "$old_path" ] || continue
          suffix=${old_path#"$mig_dir/${ts}"}
          new_path="$mig_dir/${next_ts}${suffix}"
          git mv "$old_path" "$new_path"
          gg_warn "renamed: $old_path -> $new_path"
          next_ts=$((next_ts + 1))
          renamed=1
        done
        if [ "$renamed" = 0 ]; then
          gg_warn "out-of-order migration $ts exists on HEAD but not in the working tree — commit or restore it, then re-run --fix"
          fail=1
        fi
      else
        gg_warn "out-of-order migration: $ts is not after base latest $base_latest (origin/$base)"
        gg_warn "  -> run: sh scripts/git-guard/check-migrations.sh $base --fix   (renumbers, then commit + 'pnpm backend:db:reset')"
        fail=1
      fi
    fi
  done
fi

if [ "$fail" -ne 0 ]; then
  gg_die "Prisma migration naming/ordering violation(s) detected — would break 'prisma migrate deploy'"
fi
if [ "$fix" = 1 ]; then
  gg_warn "check-migrations --fix: done. Commit the rename(s) and run 'pnpm backend:db:reset' to realign local migration history."
fi
exit 0
