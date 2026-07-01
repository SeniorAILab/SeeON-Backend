#!/usr/bin/env sh
# check-schema-migration.sh — Prisma 스키마↔마이그레이션 결합(coupling) 검사.
# 사용법·종료코드·근거(단일소스 호출, 되돌릴 수 있는 convention에는 warn-tier 훅 금지)는 scripts/backend-guard/README.md 참고.
set -eu

_bg_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/git-guard/lib.sh
. "$_bg_dir/../git-guard/lib.sh"

SCHEMA="backend/prisma/schema.prisma"
# 변경 경로 중 마이그레이션 SQL 을 가려내는 정규식(레포 루트 기준 경로).
MIG_RE='^backend/prisma/migrations/[^/]*/migration\.sql$'

mode="${1:-auto}"

# 선택된 모드에 따라 "변경된 파일 경로" 목록을 newline 으로 출력한다.
changed_paths() {
  case "$mode" in
    staged)
      git diff --cached --name-only --diff-filter=ACMR
      ;;
    base)
      _base="${2:-}"
      [ -n "$_base" ] || gg_die "backend-guard: base 모드에는 비교 ref가 필요합니다 (예: base origin/main)"
      git diff --name-only --diff-filter=ACMR "$_base...HEAD"
      ;;
    auto)
      if [ "${GITHUB_ACTIONS:-}" = "true" ] || [ -n "${CI:-}" ]; then
        _ref="${GITHUB_BASE_REF:-main}"
        _base="origin/$_ref"
        # base ref 가 로컬에 없으면 얕게 fetch 해서 확보한다(없어도 계속 시도).
        git rev-parse --verify --quiet "$_base" >/dev/null 2>&1 ||
          git fetch --no-tags --depth=1 origin "$_ref:refs/remotes/origin/$_ref" >/dev/null 2>&1 || true
        git diff --name-only --diff-filter=ACMR "$_base...HEAD"
      else
        git diff --cached --name-only --diff-filter=ACMR
      fi
      ;;
    *)
      gg_die "backend-guard: 알 수 없는 모드 '$mode' (staged | base <ref> | auto)"
      ;;
  esac
}

paths=$(changed_paths "$@")

# 1) 스키마가 변경되지 않았으면 통과.
echo "$paths" | grep -qx "$SCHEMA" || exit 0

# 2) 스키마가 변경됐으면 동반 migration.sql 변경이 반드시 있어야 한다.
if echo "$paths" | grep -qE "$MIG_RE"; then
  exit 0
fi

# 3) 스키마만 바뀌고 마이그레이션이 없음 → 거부.
gg_die "backend-guard: $SCHEMA 가 변경됐지만 동반 Prisma 마이그레이션(backend/prisma/migrations/*/migration.sql)이 없습니다.
  → 'pnpm backend:prisma:migrate' 로 마이그레이션을 생성·스테이지하거나, schema.prisma 변경을 되돌리세요.
  (마이그레이션만 단독 변경하는 것은 허용됩니다: 데이터 보정/수기 RLS 마이그레이션 등.)"
