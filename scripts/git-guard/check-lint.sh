#!/usr/bin/env sh
# Pre-push lint + typecheck gate, scoped to the packages changed vs origin/main.
#
# Why client-side: this repo is private on a free plan, so GitHub branch protection /
# required status checks are unavailable — `ci.yml` runs on PRs but CANNOT gate a merge
# (it is advisory). This hook enforces the same checks before code leaves the machine,
# which is the only real gate available on this plan.
#
# Mirrors `ci.yml` semantics exactly so local == CI:
#   frontend (front/** or shared TS manifests): `tsc --noEmit` (BLOCK) + `lint` (BLOCK)
#   backend  (backend/**, backend guard scripts, or shared TS manifests): `dto:check` (BLOCK) + `tsc --noEmit` (BLOCK) + `lint` (WARN-first, ADR-064)
#   ml       (ml/**): `ruff check` (BLOCK)
#
# Scoped to changed packages so a frontend-only push never needs uv, and vice versa.
# When a changed package's toolchain is missing, it warns and skips (cannot verify) —
# never a false block. Real lint/type failures block the push.
#
# Escape hatch (intentional only): GIT_GUARD_SKIP_LINT=1 git push
set -eu

_gg_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/git-guard/lib.sh
. "$_gg_dir/lib.sh"

[ "${GIT_GUARD_SKIP_LINT:-}" = "1" ] && exit 0

root=$(git rev-parse --show-toplevel)
cd "$root"

# Diff against origin/main (freshness check already fetched it in pre-push).
base="origin/main"
if ! git rev-parse --verify --quiet "$base" >/dev/null 2>&1; then
  gg_warn "no $base ref — skipping lint/typecheck gate (cannot scope changes)"
  exit 0
fi

changed=$(git diff --name-only "$base"...HEAD 2>/dev/null || true)
[ -z "$changed" ] && exit 0

# Map changed files -> packages (mirrors ci.yml dorny/paths-filter).
fe=0; be=0; mlc=0; envc=0
if printf '%s\n' "$changed" | grep -Eq '^front/';   then fe=1; fi
if printf '%s\n' "$changed" | grep -Eq '^(backend/|scripts/backend-guard/)'; then be=1; fi
if printf '%s\n' "$changed" | grep -Eq '^ml/';      then mlc=1; fi
if printf '%s\n' "$changed" | grep -Eq '^(compose(\..*)?\.ya?ml|\.env.*\.example|scripts/env/|\.github/workflows/ci\.yml|package\.json)$'; then envc=1; fi
# Shared TS manifests/lockfiles affect both front and backend.
if printf '%s\n' "$changed" | grep -Eq '^(pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json)$'; then fe=1; be=1; fi

[ "$fe" = 0 ] && [ "$be" = 0 ] && [ "$mlc" = 0 ] && [ "$envc" = 0 ] && exit 0

if [ "$fe" = 1 ] || [ "$be" = 1 ] || [ "$envc" = 1 ]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    gg_warn "pnpm not found — skipping JS lint/typecheck gate (run 'pnpm install' to enable)"
    fe=0; be=0; envc=0
  elif [ ! -d node_modules ]; then
    gg_warn "node_modules missing — run 'pnpm install' to enable the JS lint/typecheck gate; skipping"
    fe=0; be=0; envc=0
  fi
fi

fail=0

if [ "$fe" = 1 ]; then
  gg_warn "frontend changed -> tsc --noEmit + lint"
  pnpm --filter front exec tsc --noEmit || fail=1
  pnpm --filter front lint || fail=1
fi

if [ "$be" = 1 ]; then
  gg_warn "backend changed -> dto:check + tsc --noEmit (block) + lint (warn-first, ADR-064)"
  pnpm --filter backend run dto:check || fail=1
  pnpm --filter backend exec tsc --noEmit || fail=1
  pnpm --filter backend run lint || gg_warn "backend lint reported issues (warn-first per ADR-064 — not blocking)"
fi

if [ "$envc" = 1 ]; then
  gg_warn "env/compose contract changed -> pnpm env:verify"
  pnpm env:verify || fail=1
fi

if [ "$mlc" = 1 ]; then
  if command -v uv >/dev/null 2>&1; then
    gg_warn "ml changed -> ruff check"
    ( cd ml && uv run ruff check . ) || fail=1
  elif command -v ruff >/dev/null 2>&1; then
    gg_warn "ml changed -> ruff check"
    ( cd ml && ruff check . ) || fail=1
  else
    gg_warn "uv/ruff not found — skipping ml lint gate (install uv to enable)"
  fi
fi

if [ "$fail" != 0 ]; then
  gg_die "lint/typecheck failed for changed packages — fix before pushing.
CI is advisory on this plan (no branch protection), so this client-side gate is the real check.
-> Bypass intentionally: GIT_GUARD_SKIP_LINT=1 git push"
fi

exit 0
