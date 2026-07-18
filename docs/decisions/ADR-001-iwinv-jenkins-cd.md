---
slug: ADR-001-iwinv-jenkins-cd
date: 2026-07-10
author: gjc (deep-interview with 고범수)
status: Superseded by ADR-002
references: []
refines: []
---

# ADR-001: iwinv 서버의 Jenkins 기반 CD 파이프라인 (front + backend)

## Status

Superseded by [ADR-002: Release-based CD](ADR-002-release-based-cd.md).

## Date

2026-07-10

## Context

- 기존 CD(`deploy-ncloud.yml`)는 GitHub Actions에서 4개 이미지를 빌드해 ghcr에 push하고 ncloud VM에 SSH 배포하는 구조였다. ncloud VM은 2026-07-10 폐기되어 이 워크플로는 orphan 상태다.
- 새 배포 대상은 iwinv VM(`<iwinv-host>`, Ubuntu 26.04, 6 vCPU / 6 GB RAM / 50 GB SSD). 현재 키 전용 SSH만 열려 있고 미프로비저닝 상태다.
- 도메인이 없어 TLS 인증서를 발급할 수 없다 (IP만 존재).
- `ci.yml`의 path-filtered `ci-gate`가 이미 단일 required check로 동작한다.
- ML(ml-api/ml-worker)은 엣지 노드(happy-nursing-home)에서 구동하며 이번 결정 범위 밖이다 — 기존 `edge-images.yml` release 플로우 유지.
- 1인 운영이므로 파이프라인 유지비용과 서버 리소스가 실질 제약이다.

## Decision

GitHub Actions는 검사만, 빌드와 배포는 iwinv의 Jenkins가 수행하는 webhook 기반 true-CD로 전환한다.

1. **트리거**: main 머지가 `ci-gate`를 통과하면 GHA가 Jenkins generic-webhook-trigger 엔드포인트로 커밋 SHA를 담아 hook을 쏜다 (토큰 인증, GitHub secret 보관). 사람 개입 없는 auto-deploy.
2. **노출 모델**: 포트 80 plain HTTP. 리버스 프록시가 front + `/api/v1` + `/generic-webhook-trigger/invoke` 경로만 공개하고, Jenkins UI는 Tailscale 전용. TLS는 도메인 확보 시 즉시 전환 (수용 리스크는 issue #587에 기록).
3. **빌드**: Jenkins가 해당 SHA를 checkout해 backend/front 이미지를 iwinv 로컬에서 빌드한다. 레지스트리 왕복 없음 (ghcr push 제거). compose.prod의 `pull_policy: always`는 로컬 이미지에 맞게 조정 필요.
4. **DB**: 배포마다 pg_dump 백업(`pg_restore --list` 검증, 최근 5개 rotate) 후 `prisma migrate deploy` 자동 실행. 기존 `ncloud-deploy.sh`의 backup/lock/assert-prisma-managed 로직을 재사용·개작한다.
5. **성공 기준**: `compose up -d --wait` 후 backend health + front HTTP 200이 타임아웃 내 확인되면 성공. 실패 시 빌드 red + 이전 SHA 이미지 보존으로 원커맨드 수동 롤백 (auto-rollback 없음). 기존 스크립트의 prune은 직전 SHA 이미지를 보존하도록 조정한다.
6. **알림**: 실패 시에만 운영용 Gmail 발신 계정(앱 비밀번호, 2FA 필요)에서 운영자 수신 주소(`DEPLOY_ALERT_EMAIL`)로 메일. GitHub commit status 연동 없음.
7. **실행 계정**: 전용 Linux 계정 `seniorsailab` (엣지 서버 convention 일치), SSH 키 전용, docker 그룹. Jenkins/compose 모두 이 계정으로 구동.

## Alternatives considered

### GHA-side 빌드 + SSH 배포 유지 (기존 구조, 호스트만 교체)

- Pros: 검증된 기존 워크플로 재사용, 서버에 Jenkins 불필요, 6GB RAM 부담 없음
- Cons: ghcr 왕복 필요, Actions 분 소모, 서버측 빌드라는 요구와 불일치
- **Rejected:** 운영 주체가 서버측 CD(Jenkins)를 명시적으로 선택했고, 로컬 빌드로 레지스트리 의존을 제거하기로 함

### Release-gated 배포 (기존 트리거 정책 유지)

- Pros: 배포 시점 통제, 실수 머지가 프로덕션에 바로 안 감
- Cons: 릴리즈 수동 발행 부담, 빠른 반복에 마찰
- **Rejected:** true CD를 명시 선택 — DB 백업 자동화가 리스크를 보상

### Jenkins polling (inbound 노출 zero)

- Pros: 방화벽을 전혀 열지 않음
- Cons: 배포 지연, 상시 폴링 부하, ci-gate 통과 여부 확인이 번거로움
- **Rejected:** webhook + 경로 제한 프록시가 지연 없이 노출면을 충분히 좁힘

### TLS 즉시 도입 (sslip.io + Let's Encrypt)

- Pros: 세션 쿠키/webhook 토큰 평문 노출 제거
- Cons: 지금 결정 범위 밖의 URL 변경, 도메인 구매 전 임시 호스트명
- **Deferred (not rejected):** 도메인 확보 시 1순위 전환 항목 — issue #587에서 추적

## Consequences

### Enables

- main 머지 → 수 분 내 자동 프로덕션 반영 (사람 개입 zero)
- 레지스트리/Actions 빌드 의존 제거 — 배포 경로가 서버 안에서 닫힘
- 배포마다 검증된 DB 백업 확보

### Costs / trade-offs

- 6 GB RAM에서 Jenkins(JVM) + 이미지 빌드 + Postgres + backend/front 동시 구동 — 메모리 압박 시 swap 또는 빌드 직렬화 필요
- HTTP 평문 운영: 세션 쿠키·webhook 토큰 노출 리스크 수용 (#587)
- Jenkins 자체가 관리 대상 인프라로 추가됨 (플러그인/업데이트)

### New constraints

- 머지된 Prisma 마이그레이션은 사람 확인 없이 프로덕션 DB에 적용된다 — 파괴적 마이그레이션은 PR 리뷰 단계에서 걸러야 함
- webhook 토큰은 고엔트로피 + 회전 가능해야 하며 GitHub secret 외 어디에도 저장하지 않는다
- 이전 SHA 이미지 최소 1세대는 prune에서 보존되어야 롤백 계약이 성립한다

## Changelog

- 2026-07-10: initial decision (deep-interview 스펙 인터뷰 결과)

## References

- SeniorAILab/eldercare-fall-ai#587 — 수용/유예 보안 항목
- `scripts/deploy/ncloud-deploy.sh` — 재사용 대상 배포 로직
- `.github/workflows/deploy-ncloud.yml` — 폐기 대상 기존 CD
