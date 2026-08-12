# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-12
**Branch:** main

## Overview

`SeniorAILab/SeeON-Backend`: the backend repository of the SeeON eldercare
fall-prevention platform. NestJS/PostgreSQL API, nginx API ingress, and
backend-only Jenkins deploy tooling. Extracted from `SeniorAILab/SeeON`
(see `docs/provenance/README.md`).

External repositories, not owned here:
- `SeniorAILab/SeeON-Front`, the web dashboard. It consumes this API as an
  external client over CORS (`FRONT_ORIGINS`) and deploys on Vercel. No
  frontend package, build, image, or service exists in this repo; the
  `repo-residue` CI job (`scripts/repo-residue-check.mjs --repo-role backend`)
  blocks embedded frontend and Vercel ownership paths.
- ML runtime and edge operations live in their own repository; no `ml/`
  directory or ML image/CD logic is allowed here (same residue gate).

## Structure

```text
.
├── backend/        # NestJS API, auth/RBAC, Event API, alert policy, media clips, Prisma DB
├── infra/          # api-ingress: nginx image, config, and config tests
├── docs/           # decisions (2 ADRs), rules, provenance, openapi
├── scripts/        # git/backend/env/release/deploy guards and automation
├── .github/        # CI, PR gates, release→Jenkins signal
├── .githooks/      # pre-commit / pre-push entry points into scripts/git-guard
├── .agents/ .codex/  # pointer files that autoload this file
├── Jenkinsfile     # production build+deploy pipeline (Jenkins, not Actions)
└── compose*.yaml   # Compose (local / prod): db, backend, api-ingress
```

Untracked scratch (`.omo`, `assets/`, `output/`, etc.) must never be depended
on by routing or CI.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| CD decisions | `docs/decisions/ADR-001-iwinv-jenkins-cd.md`, `ADR-002-release-based-cd.md` | Only committed ADRs; new ones are explicit-request only. |
| Standing rules | `docs/rules/` | Pilot launch runbook. |
| Extraction provenance | `docs/provenance/README.md` | Source repo, commit map, source PRs #675 through #678. |
| Backend API / DB | `backend/AGENTS.md`, `backend/src/AGENTS.md`, `backend/prisma/AGENTS.md` | Modules, Prisma schema, migrations. |
| Alert domain | `backend/src/alerts/AGENTS.md` | Policy, write path, outbox, email channel port. |
| Media clips | `backend/src/media/AGENTS.md` | Largest backend module; clip lifecycle + access audit. |
| Backend tests | `backend/test/AGENTS.md` | Integration/e2e placement, real-Postgres harnesses. |
| API ingress | `infra/api-ingress/` | nginx config + `nginx-config.test.sh`. |
| Scripts / guards | `scripts/AGENTS.md`, `scripts/deploy/AGENTS.md` | Hard gates and deploy/release automation. |
| CI / PR policy | `.github/AGENTS.md`, `.github/workflows/` | CI gates, PR policy, release signal. |

## Code Map

| Surface | Entry / Owner | Role |
| --- | --- | --- |
| Backend boot | `backend/src/main.ts`, `app.module.ts` | Registers Config, Prisma, Auth, Cameras, Alerts, Dashboard, Facilities, Floors, Spaces, Events, EdgeCredentials, EdgeTopology, MlConfig, Users, EventMedia, AlertMedia. |
| DB boundary | `backend/src/prisma/prisma.service.ts` | Highest-centrality symbol; owns facility context + `TENANT_MODELS` RLS set. |
| Event ingest | `backend/src/events/` | `EventsController` → `EventRecorderService` (persist/dedupe) + `EventAlarmService` (derive alert); `EdgeIngestTokenGuard` on all three edge routes. |
| Alert write/read | `backend/src/alerts/` | `AlertWriterService` serializes inserts for `alertSeq` SSE order; `AlertsService` is the read model. |
| Media clips | `backend/src/media/` | Edge clip upload → immutable READY clip → authenticated Range playback + access audit. |
| Tenancy/auth | `backend/src/auth/`, `facilities/`, `floors/`, `spaces/`, `cameras/` | Cookie session, capability RBAC, room-centric topology. |
| CORS/CSRF seam | `backend/src/config/env-validation.ts`, `backend/src/security/` | `FRONT_ORIGINS` allowlist for the external SeeON-Front client; origin CSRF guard; temporary cross-site cookie bridge mode is validated here. |

## Commands

```bash
# Prereqs: Node >=24, pnpm 10.32.1, Docker running, ports free (backend 8080, POSTGRES_PORT)
pnpm install                       # CI uses --frozen-lockfile
cp .env.local.example .env.local

pnpm dev:backend:fresh             # db up + migrate + seed + backend watch

# Gates (blocking in CI unless noted)
pnpm typecheck                     # backend tsc --noEmit
pnpm lint                          # blocking convention gate for backend
pnpm --filter backend test         # jest; DB-backed specs need DATABASE_URL + DIRECT_URL
pnpm --filter backend run dto:check
pnpm env:verify
sh scripts/backend-guard/check-schema-migration.sh auto
sh scripts/git-guard/check-migrations.sh main
node scripts/repo-residue-check.mjs --repo-role backend

# Production: publishing a qualifying vX.Y.Z release signals Jenkins, which builds and deploys
pnpm release:prod -- vX.Y.Z
```

## Conventions

- `pnpm` only (single workspace package: `backend`); never add an npm/yarn lockfile.
- Local/native/Prisma/Compose env comes from root `.env.local`; local prod Compose from `.env.host.prod`. Real VM prod env is host-only at `/opt/eldercare-fall-ai/shared/.env` (legacy host path retained on the server). Do not create package-local `.env*`.
- Root `AGENTS.md` is a router. Durable implementation rules go in the owning scoped `AGENTS.md` or `docs/rules/**`, not here.
- ADRs belong in `docs/decisions/**` only when the user explicitly asks.
- Frontend work belongs in `SeniorAILab/SeeON-Front`; the only coupling allowed here is the API/DTO/SSE contract and the `FRONT_ORIGINS` CORS allowlist.
- Cross-repo work proceeds only through agreed API, DTO, event, or schema contracts.
- PRs targeting `main` should be feature-sized and MECE, without hidden dependencies on sibling PRs.
- When scope expands mid-implementation, file follow-up issues and finish the already-scoped deliverable first.
- Default verification is targeted: changed behavior first, then the package gates covering the touched surface.

## Anti-Patterns

- Do not reintroduce legacy backend machine-ingest routes, camera HMAC credentials, or `Camera.ingestMode`. Enforced by tests (`backend/test/route-versioning.spec.ts`), not by a static scanner; historical migration SQL still contains the identifiers.
- Do not add an embedded frontend (`front/`), Vercel config, ML runtime code, `ml/`, `compose.edge.yaml`, or ML image/CD logic here. Hard-blocked by `scripts/repo-residue-check.mjs --repo-role backend` in CI.
- Do not call mock/stub/fake harnesses E2E. Documentation-only rule with no automated check, so the claim is on you: real E2E must pass production code paths.
- Do not duplicate guard logic across CI, package scripts, or hooks. `scripts/**` owns reusable automation; no detector enforces this.
- Do not bury new standing rules in scratch notes or memory. Promote them to `docs/rules/**` or the scoped `AGENTS.md`.

## Notes

- Read the nearest scoped `AGENTS.md` before editing under `backend/`, `scripts/`, or `.github/`. Deep subtrees with their own files: `backend/src/{alerts,auth,media}`, `backend/{prisma,test}`, `scripts/deploy`.
- CI jobs: `changes`, `backend`, `env-contract`, `deploy-contract`, `repo-residue` (display name "Backend repository residue"), aggregate `ci-gate`. PR checks allow bases `main`/`release/*`/`hotfix/*`, reject same-repo `main` heads, and hard-fail logic churn over 1000 lines unless the PR carries `size/override`.
- Publishing a release does not itself deploy: `deploy-iwinv.yml` sends Jenkins an empty signal, Jenkins resolves the tag→SHA once and may legitimately no-op when the SHA is already live.
- `backend/eslint.config.mjs` cites `docs/rules/backend-architecture-lint-and-guard.md` and `docs/rules/code-stability.md` as convention SoT, but those docs do not exist in this tree (they were removed in a pre-extraction docs reset). The lint config itself is the live contract; recover a rule doc from source-repo history only if the user asks.
- Release manifests are dual-read for READ compatibility only: schema 1 and transitional schema 2 manifests (which name an embedded frontend image) remain parseable so old pointers stay restorable, but writers publish backend-only schema 2. See `scripts/deploy/AGENTS.md`.
