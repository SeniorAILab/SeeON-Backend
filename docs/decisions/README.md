# ADR

This is the ADR home for the repo after reset.

The ADR name stays. The old `ADR-NNN-*.md` files were removed deliberately to reduce documentation drag, so the current ADR file count is zero. Use git history when old rationale is needed.

## Current State

- Current ADR files: none.
- ADR remains the term for architectural decision records.
- Do not introduce replacement terminology for ADR.
- Do not recreate numbered ADR files, retired stubs, or an ADR archive just to preserve history.

## How To Use ADR

- Research remains factual evidence; plans remain work-scoped execution detail.
- Keep stable conventions in the owning rule, API, domain, onboarding, or script document.
- Add ADR-level material here only when a choice is expensive to reverse and future unrelated work needs to know why it exists.
- Keep ADR-level notes short: current rule, why it exists, rejected alternatives, and where it is enforced.

## Where To Write ADR-Level Decisions

Do not put every choice in ADR. Write the durable rule where future work will naturally look for it:

| Decision shape | Write it in |
| --- | --- |
| Repeatable workflow, code, review, testing, or deployment convention | `docs/rules/` |
| Request/response shape, route ownership, webhook, external integration contract | `docs/api/` |
| Business meaning, lifecycle state, data dictionary, alert semantics | `docs/domain/` |
| Runtime topology, service ownership, deployment boundary | `docs/architecture.md` or onboarding docs |
| Rare cross-cutting ADR summary that points to the owning surface | `docs/decisions/README.md` |
| One-off implementation sequence | `docs/exec-plan/active/{slug}/plan.md` |
| Evidence, comparison, source notes before choosing | `docs/research/{slug}.md` |

When an ADR-level rule needs rationale, keep it compact. Use git history for old rationale instead of rebuilding the deleted ADR archive.

## Repo And Workflow

- The repo is a polyglot monorepo: Node services use the pnpm workspace, while ML uses `uv` under `ml/`.
- Root `package.json` is orchestration-only. Per-ecosystem dependencies stay in the owning package or Python project.
- Work is issue-driven and worktree-backed: branch from `origin/main` inside a persistent lane, using the issue `type:` label as the branch type.
- Plan/spec artifacts live under `docs/exec-plan/active/{slug}/` while active and move as whole folders to `docs/exec-plan/archive/{slug}/` when complete, discarded, or superseded.
- Hooks and guards should enforce the narrow invariant they own. Prefer warn-first checks until a contract is stable enough to hard-fail.

## Runtime Topology

- Daily local development runs native hot reload for backend, ML, and frontend. Compose is used for the database, local full-stack smoke runs, and production host or edge stacks.
- The host stack is `db` + `backend` + `front`; ML runs on the edge stack.
- Production deploy is release-gated and image-pinned. Manual local production deploy scripts are the current path.
- Production database migrations require explicit backup, migration, and verification steps before destructive or schema-changing work proceeds.

## Backend

- Backend is NestJS with Prisma and PostgreSQL as the only database engine.
- Backend code follows controller -> service -> repository layering. Controllers own transport DTOs; services own application policy; repositories own persistence.
- Schema changes must travel with migrations. The backend guard is the shared pre-commit and CI enforcement surface.
- Facility tenancy is structural: facility-scoped access uses database/session context and backend runtime guards.
- Realtime updates use SSE with cookie auth and sequence replay.
- Fall and status events enter backend through the canonical ingest/events path.
- Kakao delivery is backend-orchestrated. Registered-recipient fan-out and rich Korean alert text live behind backend ports/adapters.
- Resident and zone admin APIs use explicit namespacing under the backend API.
- OAuth/login is operationally gated until the deployment environment is ready.

## ML And Edge

- ML owns perception, model loading, frame observation, and edge worker runtime. Backend owns alert policy, persistence, deduplication, and side effects.
- ML data is domain-first under `ml/data/{domain}/...`; generated and private data stays gitignored.
- ML model artifacts live under `ml/models/` with metadata that explains source, version, and reacquisition.
- Training and evaluation contracts live under `ml/training/` and the ML rules.
- Pose extraction uses the chosen YOLO pose stack; fall classification is a learned temporal model over keypoint sequences.
- The edge runtime is split into `ml-api` and `ml-worker`. The worker consumes real RTSP or an external publisher, calls the local API, and pushes signal-only events to backend.
- RTSP publishing is externalized; the repo does not host a fake E2E publisher.
- Edge config and heartbeat/state surfaces are centralized in the ML API.

## Frontend

- `front/` is the product UI: Vite + React SPA served by nginx in deployed stacks.
- The frontend consumes backend APIs and SSE; it does not own ML policy.
- Admin CRUD surfaces live under `front/src/pages/admin/` and use the frontend services layer.

## Interfaces

- ML-to-backend integration is signal-only. Backend decides whether a signal becomes an alert, status update, or side effect.
- The ML window prediction contract stays separate from backend product policy.
- API contracts live in `docs/api/`; domain semantics live in `docs/domain/`.

## Operational Documents

- Version-control rules: `docs/rules/version-control.md` and its facet docs.
- Backend layering and guards: `docs/rules/backend-architecture-lint-and-guard.md`.
- ML filesystem, model, training, and dataset rules: `docs/rules/ml-*.md`.
- Frontend onboarding: `docs/onboarding/frontend.md`.
- Edge onboarding: `docs/onboarding/edge-device.md` and `docs/onboarding/edge-worker-streaming.md`.
