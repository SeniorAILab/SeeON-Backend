# PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-03
**Commit:** 6c57c8f
**Branch:** codex/agents-init-deep-refresh

## Overview

Eldercare fall-prevention host repository: NestJS/PostgreSQL backend and Vite React monitoring dashboard. ML runtime is separated → `SeniorAILab/eldercare-fall-ml`.

## Structure

```text
.
├── backend/        # NestJS API, auth/RBAC, Event API, alert policy, Prisma DB
├── front/          # Vite React facility dashboard and operator UI
├── docs/           # architecture, rules, research, exec plans
├── scripts/        # git/backend/env/release/deploy guards and automation
├── .github/        # CI and PR gates
└── AGENTS.md       # root router only; scoped rules override below their dirs
```

`.omc`, `.omo`, `.omx`, and `.gjc` are non-canonical scratch areas. Do not make root routing depend on their internal layout.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| System topology | `docs/architecture.md` | Host backend/frontend flow. ML runtime: separated → `SeniorAILab/eldercare-fall-ml`. |
| Docs scaffold | `docs/research/`, `docs/exec-plan/`, `docs/decisions/`, `docs/rules/` | Init-owned scaffold only; ADRs are explicit-request only. |
| Backend API / DB | `backend/AGENTS.md`, `backend/src/AGENTS.md`, `backend/prisma/AGENTS.md` | Controllers/services/repositories, Prisma schema, migrations. |
| ML runtime / edge dashboard | `SeniorAILab/eldercare-fall-ml` | Separated repository. |
| Frontend | `front/AGENTS.md`, `front/src/AGENTS.md` | API seam, mock mode boundary, UI state. |
| Scripts / guards | `scripts/AGENTS.md`, `scripts/backend-guard/README.md` | Hard gates and deploy/release automation. |
| CI / PR policy | `.github/AGENTS.md`, `.github/workflows/` | Size/base checks and package CI. |

## Code Map

| Surface | Entry / Owner | Role |
| --- | --- | --- |
| Backend boot | `backend/src/main.ts`, `backend/src/app.module.ts` | Nest app bootstrap and module composition. |
| Event ingest | `backend/src/events/events.controller.ts`, `event-recorder.service.ts`, `event-alarm.service.ts` | Remote event facts become persisted events/alerts. |
| Alert policy | `backend/src/alerts/` | Dashboard alert read model and email (SMTP) delivery policy. |
| Tenancy/auth | `backend/src/auth/`, `backend/src/facilities/`, `backend/src/spaces/` | Facility-scoped auth and topology. |
| Prisma | `backend/prisma/schema.prisma`, `backend/src/prisma/` | Data model and DB access boundary. |
| ML runtime | `SeniorAILab/eldercare-fall-ml` | Separated repository. |
| Front app | `front/src/main.tsx`, `router.tsx`, `pages/`, `components/` | Facility dashboard routes and views. |
| Front API seam | `front/src/services/`, `front/src/services/api/` | Backend DTO mapping; components must not fetch directly. |

## Commands

```bash
# Init prerequisites: Docker daemon running; ports from .env.local must be free
# (front 3000 strictPort · backend 8080 · db POSTGRES_PORT). Run in this order.
pnpm install
cp .env.local.example .env.local

pnpm dev:backend:fresh   # db up + migrate + seed + backend watch
pnpm dev:front

pnpm typecheck
pnpm lint
pnpm --filter backend test
pnpm --filter front test
pnpm env:verify
pnpm --filter backend run dto:check
sh scripts/backend-guard/check-schema-migration.sh auto

# Production deployment: publishing a release IS the deploy (merge alone never deploys)
pnpm release:prod -- vX.Y.Z
```
## Conventions

- Use `pnpm` for Node packages; do not add npm/yarn lockfiles.
- Local/native/Prisma/Compose env comes from root `.env.local`; host prod from `.env.host.prod`. Do not create package-local `.env*`.
- Root `AGENTS.md` is a router. Put durable implementation rules in the owning scoped `AGENTS.md` or `docs/rules/**`, not here.
- ADRs or decision records belong in `docs/decisions/**` only when the user explicitly asks for them.
- Split backend and front work into separate PRs by default. ML runtime work belongs in `SeniorAILab/eldercare-fall-ml`.
- Cross-surface work proceeds only through agreed API, DTO, event, or schema contracts.
- Run dependency-free backend/front slices in parallel instead of serializing them.
- PRs targeting `main` should be feature-sized and MECE, without hidden dependencies on sibling PRs.
- When scope expands mid-implementation, record non-blocking additions as follow-up issues and finish the already-scoped deliverable first.
- Default verification is targeted: changed behavior first, then package lint/type/test gates that cover the touched surface.

## Anti-Patterns

- Do not reintroduce legacy backend machine-ingest routes, camera HMAC credentials, or `Camera.ingestMode`; Event API is the remote event ingress.
- ML runtime implementation belongs in `SeniorAILab/eldercare-fall-ml`.
- Do not let frontend components call backend APIs directly; use `front/src/services/**`.
- Do not call mock/stub/fake harnesses E2E. Real E2E claims must pass production code paths; use the owning scoped `AGENTS.md` for detail.
- Do not duplicate guard logic across CI, package scripts, or hooks. `scripts/**` owns reusable automation.
- Do not bury new standing rules in scratch notes or memory. Promote them to `docs/rules/**` or the scoped `AGENTS.md`; use `docs/decisions/**` only on explicit ADR requests.

## Notes

- Existing scoped `AGENTS.md` files are intentional for `backend`, `front`, `scripts`, `.github`, and high-complexity subtrees. Read the nearest one before editing files under that directory.
- CI has separate backend, frontend, env-contract, and host-residue jobs plus an aggregate `ci-gate`. PR checks enforce base branch policy, same-repo `main` head rejection, and logic-churn size limits.
