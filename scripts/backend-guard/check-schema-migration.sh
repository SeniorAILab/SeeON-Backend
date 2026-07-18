#!/usr/bin/env sh
# check-schema-migration.sh — Prisma 스키마↔마이그레이션 결합 + 스키마 컨벤션 검사.
# 검사 항목(모두 차단, exit 1 — 근거는 scripts/backend-guard/README.md):
#   1) append-only 테이블(UPDATE·DELETE 를 모두 REVOKE)은 이름이 *_history 여야 한다.
#   2) nullable *Id 필드는 바로 위(또는 같은 줄)에 /// 문서 주석이 있어야 한다.
#   3) schema.prisma 실질 변경(주석/공백 제외)에는 동반 migration.sql 이 있어야 한다.
# 사용법: check-schema-migration.sh [staged | base <ref> | auto]
set -eu

_bg_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/git-guard/lib.sh
. "$_bg_dir/../git-guard/lib.sh"

SCHEMA="backend/prisma/schema.prisma"
# 변경 경로 중 마이그레이션 SQL 을 가려내는 정규식(레포 루트 기준 경로).
MIG_RE='^backend/prisma/migrations/[^/]*/migration\.sql$'
# *_history 규약 이전에 만들어진 append-only 테이블(개명은 별도 마이그레이션 비용이라 유예).
HISTORY_GRANDFATHER="events media_access_logs"

mode="${1:-auto}"

# 모드 → diff 범위($range)와 파일 내용을 읽을 git ref 접두($content_ref)를 결정한다.
#   staged: index 를 커밋 예정 상태로 취급 / base·CI: HEAD 가 검사 대상 커밋.
case "$mode" in
  staged)
    range="--cached"
    content_ref=":"
    ;;
  base)
    _base="${2:-}"
    [ -n "$_base" ] || gg_die "backend-guard: base 모드에는 비교 ref가 필요합니다 (예: base origin/main)"
    range="$_base...HEAD"
    content_ref="HEAD:"
    ;;
  auto)
    if [ "${GITHUB_ACTIONS:-}" = "true" ] || [ -n "${CI:-}" ]; then
      _ref="${GITHUB_BASE_REF:-main}"
      _base="origin/$_ref"
      # base ref 가 로컬에 없으면 얕게 fetch 해서 확보한다(없어도 계속 시도).
      git rev-parse --verify --quiet "$_base" >/dev/null 2>&1 ||
        git fetch --no-tags --depth=1 origin "$_ref:refs/remotes/origin/$_ref" >/dev/null 2>&1 || true
      range="$_base...HEAD"
      content_ref="HEAD:"
    else
      range="--cached"
      content_ref=":"
    fi
    ;;
  *)
    gg_die "backend-guard: 알 수 없는 모드 '$mode' (staged | base <ref> | auto)"
    ;;
esac

# $range 는 단일 토큰('--cached' 또는 'ref...HEAD')이므로 무따옴표 전개가 안전하다.
paths=$(git diff $range --name-only --diff-filter=ACMR)

content_of() {
  git show "$content_ref$1"
}

# ── 1) append-only 테이블 *_history 이름 규약 (변경된 migration.sql 대상) ──────────
# 판별식: 명시적 UPDATE·DELETE 권한을 PUBLIC 이외 role 에서 REVOKE 하면 append-only.
# (REVOKE ALL … FROM PUBLIC 은 전 테이블 공통 하드닝 보일러플레이트라 제외,
#  DELETE 단독 REVOKE(media_clips 류)는 immutable 이 아니라 제외.)
changed_migs=$(printf '%s\n' "$paths" | grep -E "$MIG_RE" || true)
if [ -n "$changed_migs" ]; then
  offenders=$(
    for f in $changed_migs; do content_of "$f"; done \
      | grep -v '^[[:space:]]*--' \
      | awk -v grandfather="$HISTORY_GRANDFATHER" '
        BEGIN {
          RS = ";"
          n = split(grandfather, g, " ")
          for (i = 1; i <= n; i++) ok[g[i]] = 1
        }
        {
          stmt = $0
          upper = toupper(stmt)
          if (upper !~ /REVOKE/) next
          on_pos = index(upper, " ON ")
          from_pos = index(upper, " FROM ")
          if (on_pos == 0 || from_pos <= on_pos) next
          privs = substr(upper, 1, on_pos)
          sub(/.*REVOKE/, "", privs)
          has_upd = (privs ~ /(^|[^A-Z])UPDATE([^A-Z]|$)/)
          has_del = (privs ~ /(^|[^A-Z])DELETE([^A-Z]|$)/)
          if (!has_upd && !has_del) next
          roles = substr(upper, from_pos + 6)
          gsub(/[[:space:]"]/, "", roles)
          nr = split(roles, r, ",")
          nonpublic = 0
          for (i = 1; i <= nr; i++) if (r[i] != "" && r[i] != "PUBLIC") nonpublic = 1
          if (!nonpublic) next
          tables = substr(stmt, on_pos + 4, from_pos - (on_pos + 4))
          if (toupper(tables) ~ /^[[:space:]]*(SEQUENCE|FUNCTION|ALL)[[:space:]]/) next
          sub(/^[[:space:]]*[Tt][Aa][Bb][Ll][Ee][[:space:]]/, "", tables)
          m = split(tables, t, ",")
          for (i = 1; i <= m; i++) {
            name = t[i]
            gsub(/["`[:space:]]/, "", name)
            sub(/^public\./, "", name)
            if (name == "") continue
            if (has_upd) upd[name] = 1
            if (has_del) del[name] = 1
          }
        }
        END {
          for (name in upd)
            if (del[name] && !ok[name] && name !~ /_history$/) print "  " name
        }
      ' | sort -u
  )
  if [ -n "$offenders" ]; then
    gg_die "backend-guard: append-only 테이블(UPDATE·DELETE REVOKE)은 이름이 *_history 여야 합니다:
$offenders
  → 테이블 이름을 *_history 로 바꾸거나(권장), 진짜 append-only 가 아니면 REVOKE 를 조정하세요."
  fi
fi

# ── 스키마가 변경되지 않았으면 여기서 통과 ──────────────────────────────────────
printf '%s\n' "$paths" | grep -qx "$SCHEMA" || exit 0

# ── 2) nullable *Id 필드 /// 문서 주석 (스키마 전체 검사) ───────────────────────
# null 이 가능한 FK/참조 필드는 "왜 null 인지"(수명주기·SetNull·비FK 감사값 등)를
# 필드 바로 위 /// 한 줄로 남겨야 한다.
undocumented=$(
  content_of "$SCHEMA" | awk -v schema="$SCHEMA" '
    {
      line = $0
      if (line ~ /^[[:space:]]*[A-Za-z0-9_]*Id[[:space:]]+[A-Za-z][A-Za-z0-9]*\?/) {
        if (!prev_doc && line !~ /\/\/\//) {
          field = line
          sub(/^[[:space:]]*/, "", field)
          sub(/[[:space:]].*$/, "", field)
          printf "  %s:%d: %s\n", schema, NR, field
        }
      }
      prev_doc = (line ~ /^[[:space:]]*\/\/\//) ? 1 : 0
    }
  '
)
if [ -n "$undocumented" ]; then
  gg_die "backend-guard: nullable *Id 필드에 /// 문서 주석이 없습니다:
$undocumented
  → 필드 바로 위에 null 사유(온보딩 전/SetNull/시스템 생성 등) /// 주석을 추가하세요."
fi

# ── 3) 스키마↔마이그레이션 결합 ────────────────────────────────────────────────
if printf '%s\n' "$paths" | grep -qE "$MIG_RE"; then
  exit 0
fi

# 주석(///·//)·공백만 바뀐 스키마 diff 는 SQL 에 영향이 없으므로 마이그레이션을 요구하지 않는다.
substantive=$(
  git diff $range -- "$SCHEMA" \
    | grep -E '^[+-]' \
    | grep -vE '^(\+\+\+|---)' \
    | sed -E 's/^[+-][[:space:]]*//' \
    | grep -vE '^(//.*)?$' || true
)
if [ -z "$substantive" ]; then
  gg_warn "backend-guard: schema.prisma 변경이 주석/공백뿐 — 동반 마이그레이션 불요, 통과"
  exit 0
fi

gg_die "backend-guard: $SCHEMA 가 변경됐지만 동반 Prisma 마이그레이션(backend/prisma/migrations/*/migration.sql)이 없습니다.
  → 'pnpm backend:prisma:migrate' 로 마이그레이션을 생성·스테이지하거나, schema.prisma 변경을 되돌리세요.
  (마이그레이션만 단독 변경하는 것은 허용됩니다: 데이터 보정/수기 RLS 마이그레이션 등.)"
