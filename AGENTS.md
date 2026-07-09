# PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-03
**Commit:** 6c57c8f
**Branch:** codex/agents-init-deep-refresh

## Overview

Eldercare fall-prevention monorepo: NestJS/PostgreSQL backend, FastAPI/worker ML edge runtime, and Vite React monitoring dashboard. Root scripts orchestrate packages; domain ownership lives in scoped `AGENTS.md` files.

## Structure

```text
.
├── backend/        # NestJS API, auth/RBAC, Event API, alert policy, Prisma DB
├── ml/             # uv Python ML API, worker, demo, contracts (training moved to eldercare-dataset-ops, ADR-0004)
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
| System topology | `docs/architecture.md` | Runtime split and edge/backend/frontend flow when explicitly authored. |
| Docs scaffold | `docs/research/`, `docs/exec-plan/`, `docs/decisions/`, `docs/rules/` | Init-owned scaffold only; ADRs are explicit-request only. |
| Backend API / DB | `backend/AGENTS.md`, `backend/src/AGENTS.md`, `backend/prisma/AGENTS.md` | Controllers/services/repositories, Prisma schema, migrations. |
| ML runtime | `ml/AGENTS.md`, `ml/worker/AGENTS.md`, `ml/api/AGENTS.md` | Import ladder, RTSP worker, relay API, model boundaries. |
| Nursing-home edge dashboard access | `docs/rules/nursing-home-edge-dashboard-access.md` | Direct tailnet `:5173` access, firewall check, fallback boundary, and no secrets/topology in docs or logs. |
| Frontend | `front/AGENTS.md`, `front/src/AGENTS.md` | API seam, mock mode boundary, UI state. |
| Scripts / guards | `scripts/AGENTS.md`, `scripts/backend-guard/README.md` | Hard gates and deploy/release automation. |
| CI / PR policy | `.github/AGENTS.md`, `.github/workflows/` | Size/base checks and package CI. |
| Product PRD | `<prd-path>` | Obsidian <vault> vault path; access the Markdown file directly. |

## Code Map

| Surface | Entry / Owner | Role |
| --- | --- | --- |
| Backend boot | `backend/src/main.ts`, `backend/src/app.module.ts` | Nest app bootstrap and module composition. |
| Event ingest | `backend/src/events/events.controller.ts`, `event-recorder.service.ts`, `event-alarm.service.ts` | ML facts enter backend and become persisted events/alerts. |
| Alert policy | `backend/src/alerts/` | Dashboard alert read model and email (SMTP) delivery policy. |
| Tenancy/auth | `backend/src/auth/`, `backend/src/facilities/`, `backend/src/spaces/` | Facility-scoped auth and topology. |
| Prisma | `backend/prisma/schema.prisma`, `backend/src/prisma/` | Data model and DB access boundary. |
| ML API | `ml/api/main.py`, `ml/api/routes/` | Gateway/status/relay API; no model loading. |
| ML worker | `ml/worker/__main__.py`, `edge_worker.py`, `camera_worker.py` | Long-running stream consumer and orchestration state. |
| Perception | `ml/worker/sources/`, `runners/`, `perception/`, `domains/` | Frame intake, model runners, observations, domain events. |
| Training | eldercare-dataset-ops (sibling repo) | Batch artifact creation/evaluation; moved out of this repo per ADR-0004. `ml/artifact_metadata/` keeps only the read-side schema for the live demo. |
| Front app | `front/src/main.tsx`, `router.tsx`, `pages/`, `components/` | Facility dashboard routes and views. |
| Front API seam | `front/src/services/`, `front/src/services/api/` | Backend DTO mapping; components must not fetch directly. |

## Commands

```bash
pnpm install
cd ml && uv sync
cp .env.local.example .env.local

pnpm dev:backend:fresh
pnpm dev:ml
pnpm dev:ml:worker
pnpm dev:front

pnpm typecheck
pnpm lint
pnpm --filter backend test
pnpm --filter front test
uv run --directory ml pytest
pnpm env:verify
pnpm --filter backend run dto:check
sh scripts/backend-guard/check-schema-migration.sh auto
```

## Conventions

- Use `pnpm` for Node packages and `uv` for `ml/`; do not add npm/yarn/pip lockfiles.
- Local/native/Prisma/Compose env comes from root `.env.local`; host prod from `.env.host.prod`; edge prod from `.env.edge.prod`. Do not create package-local `.env*`.
- Root `AGENTS.md` is a router. Put durable implementation rules in the owning scoped `AGENTS.md` or `docs/rules/**`, not here.
- ADRs or decision records belong in `docs/decisions/**` only when the user explicitly asks for them.
- Split backend, front, ml-api, and ml-worker work into separate PRs by default.
- Cross-surface work proceeds only through agreed API, DTO, event, or schema contracts.
- Run dependency-free backend/front/ML slices in parallel instead of serializing them.
- PRs targeting `main` should be feature-sized and MECE, without hidden dependencies on sibling PRs.
- When scope expands mid-implementation, record non-blocking additions as follow-up issues and finish the already-scoped deliverable first.
- Default verification is targeted: changed behavior first, then package lint/type/test gates that cover the touched surface.

## Anti-Patterns

- Do not reintroduce legacy backend machine-ingest routes, camera HMAC credentials, or `Camera.ingestMode`; Event API is the live ML ingress.
- Do not put model loading or prediction routes in `ml-api`; live ML belongs in `ml-worker`.
- Do not add RTSP publishers, MediaMTX, FFmpeg file-to-RTSP helpers, or synthetic camera servers inside this repo. `ml-worker` consumes configured streams.
- Do not let frontend components call backend APIs directly; use `front/src/services/**`.
- Do not call mock/stub/fake harnesses E2E. Real E2E claims must pass production code paths; use the owning scoped `AGENTS.md` for detail.
- Do not duplicate guard logic across CI, package scripts, or hooks. `scripts/**` owns reusable automation.
- Do not bury new standing rules in scratch notes or memory. Promote them to `docs/rules/**` or the scoped `AGENTS.md`; use `docs/decisions/**` only on explicit ADR requests.

## Notes

- Existing scoped `AGENTS.md` files are intentional for `backend`, `ml`, `front`, `scripts`, `.github`, and high-complexity subtrees. Read the nearest one before editing files under that directory.
- CI has separate backend, frontend, ML, and env-contract jobs plus an aggregate `ci-gate`. PR checks enforce base branch policy, same-repo `main` head rejection, and logic-churn size limits.
