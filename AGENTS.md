# PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-31
**Commit:** 6c91273
**Branch:** main

## Overview

Eldercare fall-prevention host repository: NestJS/PostgreSQL backend and Vite React monitoring dashboard. ML runtime is separated → `SeniorAILab/eldercare-fall-ml` (Python 3.11+/uv; no `ml/` directory here, enforced by `scripts/repo-residue-check.mjs`).

## Structure

```text
.
├── backend/        # NestJS API, auth/RBAC, Event API, alert policy, media clips, Prisma DB
├── front/          # Vite React facility dashboard and operator UI
├── docs/           # architecture, design, ADRs (2), rules, research
├── scripts/        # git/backend/env/release/deploy guards and automation
├── .github/        # CI, PR gates, release→Jenkins signal
├── .githooks/      # pre-commit / pre-push entry points into scripts/git-guard
├── .agents/ .claude/ .codex/  # tracked agent skills; each root file is a pointer to this file
├── Jenkinsfile     # production build+deploy pipeline (Jenkins, not Actions)
└── compose*.yaml   # host Compose (local / prod)
```

Untracked scratch: `assets/`, `output/`, `secondbrain/`, `.omc`, `.omo`, `.omx`, `.oms`, `.gjc`, `.playwright-cli`. Nothing in routing or CI may depend on their layout.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| System topology | `docs/architecture.md`, `docs/design.md` | Host backend/frontend flow. |
| CD decisions | `docs/decisions/ADR-001-iwinv-jenkins-cd.md`, `ADR-002-release-based-cd.md` | Only committed ADRs; new ones are explicit-request only. |
| Standing rules | `docs/rules/` | Currently one rule (edge dashboard access → ML repo). |
| Backend API / DB | `backend/AGENTS.md`, `backend/src/AGENTS.md`, `backend/prisma/AGENTS.md` | Modules, Prisma schema, migrations. |
| Alert domain | `backend/src/alerts/AGENTS.md` | Policy, write path, outbox, email channel port. |
| Media clips | `backend/src/media/AGENTS.md` | Largest backend module (42 files); clip lifecycle + access audit. |
| Backend tests | `backend/test/AGENTS.md` | Integration/e2e placement, real-Postgres harnesses. |
| Frontend | `front/AGENTS.md`, `front/src/AGENTS.md`, `front/src/services/AGENTS.md` | API seam, feature barrels, UI state. |
| Monitor kiosk | `front/src/features/monitor/AGENTS.md` | SSE-driven floor board + TTS queue. |
| Event evidence UI | `front/src/features/admin-events/AGENTS.md` | Admin-only clip playback boundary. |
| Scripts / guards | `scripts/AGENTS.md`, `scripts/deploy/AGENTS.md` | Hard gates and deploy/release automation. |
| CI / PR policy | `.github/AGENTS.md`, `.github/workflows/` | CI gates, PR policy, release signal. |

## Code Map

| Surface | Entry / Owner | Role |
| --- | --- | --- |
| Backend boot | `backend/src/main.ts`, `app.module.ts` | Registers Config, Prisma, Auth, Cameras, Alerts, Dashboard, Facilities, Floors, Spaces, Events, MlConfig, Users, EventMedia, AlertMedia. |
| DB boundary | `backend/src/prisma/prisma.service.ts` | Highest-centrality symbol (80+ refs); owns facility context + `TENANT_MODELS` RLS set. |
| Event ingest | `backend/src/events/` | `EventsController` → `EventRecorderService` (persist/dedupe) + `EventAlarmService` (derive alert); `EdgeIngestTokenGuard` on all three edge routes. |
| Alert write/read | `backend/src/alerts/` | `AlertWriterService` serializes inserts for `alertSeq` SSE order; `AlertsService` is the read model. |
| Media clips | `backend/src/media/` | Edge clip upload → immutable READY clip → authenticated Range playback + access audit. |
| Tenancy/auth | `backend/src/auth/`, `facilities/`, `floors/`, `spaces/`, `cameras/` | Cookie session, capability RBAC, room-centric topology. |
| Front entry | `front/src/main.tsx`, `router.tsx` | Routes are facility-scoped: `/facilities/:facilityId/{dashboard,floor/:floorId,alerts,admin/*}`; old `/dashboard/*` and `/admin/*` are redirect-only. |
| Front API seam | `front/src/services/apiClient.ts`, `services/api/` | Only fetch/SSE/401 seam; components must not fetch. |

## Commands

```bash
# Prereqs: Node >=24, pnpm 10.32.1, Docker running, ports free (front 3000 strictPort, backend 8080, POSTGRES_PORT)
pnpm install                       # CI uses --frozen-lockfile
cp .env.local.example .env.local

pnpm dev:backend:fresh             # db up + migrate + seed + backend watch
pnpm dev:front

# Gates (blocking in CI unless noted)
pnpm typecheck                     # front tsc -b + backend tsc
pnpm lint                          # backend lint is warn-first/non-blocking per ADR
pnpm --filter backend test         # jest; DB-backed specs need DATABASE_URL + DIRECT_URL
pnpm --filter front test           # vitest/jsdom
pnpm --filter backend run dto:check
pnpm env:verify
sh scripts/backend-guard/check-schema-migration.sh auto
sh scripts/git-guard/check-migrations.sh main
node scripts/repo-residue-check.mjs --repo-role host

# Production: publishing a qualifying vX.Y.Z release signals Jenkins, which builds and deploys
pnpm release:prod -- vX.Y.Z
```

## Conventions

- `pnpm` only (workspace: `front`, `backend`); never add an npm/yarn lockfile.
- Local/native/Prisma/Compose env comes from root `.env.local`; local prod Compose from `.env.host.prod`. Real VM prod env is host-only at `/opt/eldercare-fall-ai/shared/.env`. Do not create package-local `.env*`.
- Root `AGENTS.md` is a router. Durable implementation rules go in the owning scoped `AGENTS.md` or `docs/rules/**`, not here.
- ADRs belong in `docs/decisions/**` only when the user explicitly asks.
- Split backend and front work into separate PRs by default. ML runtime work belongs in `SeniorAILab/eldercare-fall-ml`.
- Cross-surface work proceeds only through agreed API, DTO, event, or schema contracts.
- Run dependency-free backend/front slices in parallel instead of serializing them.
- PRs targeting `main` should be feature-sized and MECE, without hidden dependencies on sibling PRs.
- When scope expands mid-implementation, file follow-up issues and finish the already-scoped deliverable first.
- Default verification is targeted: changed behavior first, then the package gates covering the touched surface.

## Anti-Patterns

- Do not reintroduce legacy backend machine-ingest routes, camera HMAC credentials, or `Camera.ingestMode`. Enforced by tests (`backend/test/route-versioning.spec.ts`), not by a static scanner — historical migration SQL still contains the identifiers.
- Do not add ML runtime code, `ml/`, `compose.edge.yaml`, or ML image/CD logic here. Hard-blocked by `scripts/repo-residue-check.mjs` in CI.
- Do not let frontend components call backend APIs directly; use `front/src/services/**`. ESLint enforces this except for an explicit legacy allowlist in `front/eslint.config.js` — do not extend that allowlist.
- Do not reintroduce runtime frontend mock/fixture islands. Blocked by `front/src/mockRetirement.scan.test.ts`.
- Do not call mock/stub/fake harnesses E2E. Documentation-only rule with no automated check, so the claim is on you: real E2E must pass production code paths.
- Do not duplicate guard logic across CI, package scripts, or hooks. `scripts/**` owns reusable automation; no detector enforces this.
- Do not bury new standing rules in scratch notes or memory. Promote them to `docs/rules/**` or the scoped `AGENTS.md`.

## Notes

- Read the nearest scoped `AGENTS.md` before editing under `backend/`, `front/`, `scripts/`, or `.github/`. Deep subtrees with their own files: `backend/src/{alerts,auth,media}`, `backend/{prisma,test}`, `front/src/{services,features/monitor,features/admin-events}`, `scripts/deploy`.
- CI jobs: `changes`, `backend`, `frontend`, `env-contract`, `repo-residue` (display name "Host repository residue"), aggregate `ci-gate`. PR checks allow bases `main`/`release/*`/`hotfix/*`, reject same-repo `main` heads, and hard-fail logic churn over 1000 lines unless the PR carries `size/override`.
- Publishing a release does not itself deploy: `deploy-iwinv.yml` sends Jenkins an empty signal, Jenkins resolves the tag→SHA once and may legitimately no-op when the SHA is already live.
- `docs/` was deliberately reset in `8d9d9f7` (docs: reset craft docs scaffold), which removed 22 `docs/rules/**` files and the whole `docs/exec-plan/**` body. `docs/exec-plan/{active,archive}` and `docs/research/` are now `.gitkeep`-only scaffolds — do not resurrect deleted plans or build a parallel plan tree elsewhere.
- Side effect of that reset: `backend/eslint.config.mjs` still cites `docs/rules/backend-architecture-lint-and-guard.md` and `docs/rules/code-stability.md` as convention SoT, but both files were deleted. The lint config itself is the live contract; recover a rule doc from git history only if the user asks.
