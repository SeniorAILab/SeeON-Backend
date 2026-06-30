# scripts/backend-guard

백엔드(NestJS) 구조 강제(enforcement)의 **단일 소스(SSOT)** 스크립트 모음입니다.
`scripts/git-guard/`(레포 전역 워크플로/자산 가드)의 형제 디렉터리이며, 같은
`scripts/git-guard/lib.sh` 헬퍼(`gg_warn`/`gg_die`)를 재사용합니다.

> 결정 근거: backend layering rule, DTO hard gate, single-source guard invocation,
> and the warn-tier boundary for reversible convention checks.
> 자세한 결정은 `docs/decisions/README.md`
> 와 `docs/rules/backend-architecture-lint-and-guard.md` 참고.

## 무엇을 어디서 검사하나 (경계)

| 검사 대상                                                          | 도구                                | 어디서 도나                                                   | 차단?            |
| ------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------- | ---------------- |
| 계층 import 경계(controller→service→repository, service→port)      | **ESLint**(`no-restricted-imports`) | 에디터 + CI `lint`                                            | warn (비차단)    |
| 인라인 DTO 금지(도메인 `dto/*.dto.ts` 강제)                        | **ESLint**(`no-restricted-syntax`)  | 에디터 + CI `lint`                                            | warn (비차단)    |
| DTO suffix + controller `@Body()` request DTO 강제                 | **check-dto-contracts.mjs**         | `pnpm --filter backend run dto:check` + CI/local backend gate | block (exit 1)   |
| 신규 typed 규칙(consistent-type-imports, no-unnecessary-condition) | **ESLint**                          | 에디터 + CI `lint`                                            | warn (비차단)    |
| **스키마↔마이그레이션 결합**                                       | **이 스크립트**                     | `.githooks/pre-commit` + CI                                   | **차단**(exit 1) |

ESLint로 잡는 계층/타입 규칙은 warn-first로 두고, **차단해야 하는 기계적 계약**은
이 디렉터리의 스크립트로 둡니다. 현재 block 대상은 스키마↔마이그레이션 결합과
DTO suffix/controller body boundary입니다.

## tenant(시설) 격리는 여기서 검사하지 않습니다

`Resident`/`Camera`/`Alert`/`Guardian`/`Floor`/`Space`/`Zone` 등 tenant 테이블의
시설 간 격리는 **구조적으로** 이미 보증됩니다 — 정적 lint가 지키는 것이 아닙니다:

- **Postgres RLS**: tenant 테이블은 `ENABLE + FORCE`, 앱 DB role 은 `NOBYPASSRLS`.
  `app.facility_id` GUC 없는 쿼리는 행 0개(default-deny).
- **PrismaService 런타임 가드**: `$allOperations` 가 컨텍스트 없는 tenant 모델 접근을
  `MissingTenantContextError`로 fail-closed. `withFacilityContext(facilityId, …)` 가
  `SET LOCAL app.facility_id` 로 트랜잭션을 묶는다.

→ 별도의 정적 tenant 검사 스크립트는 (중복·오탐이라) 의도적으로 두지 않습니다.
더 강한 구조적 강제(타입/API 레벨)는 별도 리팩터 follow-up.

## check-schema-migration.sh

`backend/prisma/schema.prisma` 가 변경됐는데 동반 마이그레이션
(`backend/prisma/migrations/*/migration.sql`)이 없으면 거부합니다.
마이그레이션만 단독 변경(데이터 보정·수기 RLS 등)은 허용합니다.

```sh
# 스테이지된 변경 검사 (.githooks/pre-commit 가 사용)
sh scripts/backend-guard/check-schema-migration.sh staged

# base...HEAD diff 검사 (CI 가 사용)
sh scripts/backend-guard/check-schema-migration.sh base "origin/${GITHUB_BASE_REF:-main}"

# 자동(모드 미지정): CI면 base, 아니면 staged
sh scripts/backend-guard/check-schema-migration.sh auto
```

종료코드: `0` 통과, `1` 위반(스키마 변경 + 마이그레이션 누락) 또는 도구 오류.

## check-dto-contracts.mjs

`backend/src/**/dto/*.dto.ts`의 exported `*Dto` 이름과 컨트롤러 `@Body()` 경계를 검사합니다.

```sh
pnpm --filter backend run dto:check
pnpm --filter backend run dto:check -- --fixture scripts/backend-guard/fixtures/invalid-dto-contracts
```

종료코드: `0` 통과, `1` DTO suffix 또는 controller body boundary 위반.

## 호출 지점 (단일소스 — 로직 재구현 금지)

- `.githooks/pre-commit` → `check-schema-migration.sh staged` (벤더 무관 1차 게이트 — Claude/Codex/GJC/사람 모두 커밋 시 동일 적용)
- `.github/workflows/ci.yml` (backend job) → `check-schema-migration.sh auto` + `pnpm --filter backend run lint`(non-blocking warn-first)
- 실행권한 부여: `scripts/git-guard/setup-hooks.sh` 가 `chmod +x` 처리

> 벤더 무관 보증은 git-native `.githooks/pre-commit` + CI 입니다. 스키마 가드는 에이전트
> pre-edit 훅(`.claude`/`.codex`)에 넣지 않습니다 — 스키마만 스테이지된 동안 모든 셸/편집을
> 막아 데드락을 유발할 수 있고, pre-commit 이 이미 전 벤더를 커밋 시점에 커버하기 때문입니다.
> ADR 에 따라 되돌릴 수 있는 아키텍처/DTO 경고도 git/에이전트 훅에 넣지 않습니다
> (ESLint 에디터 + CI lint 로만 노출).
