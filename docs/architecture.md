# Architecture Overview — eldercare-fall-ai

> PoC status (2026-06-07). Realtime transport, full feature implementation, and ML training pipeline are explicitly deferred. This document reflects the scaffolded skeleton only.

---

## Directory tree

```
eldercare-fall-ai/                  ← orchestration layer only (no app deps here)
├── package.json                    ← dev:*, build:*, lint, db:*, prisma:* scripts
├── pnpm-workspace.yaml             ← workspace: [front, backend]
├── pnpm-lock.yaml                  ← single lock for all TS packages
├── compose.yaml                    ← host stack: db+backend+front(nginx), gated by `full` profile; +compose.prod.yaml overlay; compose.edge.yaml = ML edge (ADR-062/063)
│
├── front/                          ← Vite 5 / React 18 / Tailwind v3 (product UI)
│   ├── src/
│   │   ├── main.tsx
│   │   ├── router.tsx
│   │   ├── pages/ components/ services/ store/
│   │   └── ...
│   └── package.json
│
├── backend/                        ← NestJS 11 / Prisma 6 / PostgreSQL (product logic)
│   ├── src/
│   │   ├── main.ts                 ← listens on PORT (default 3000)
│   │   ├── app.module.ts           ← ConfigModule + PrismaModule
│   │   └── prisma/
│   │       ├── prisma.module.ts
│   │       └── prisma.service.ts
│   ├── prisma/schema.prisma        ← provider=postgresql, url=env("DATABASE_URL")
│   ├── .env.local.example          ← local/native + Compose development contract
│   ├── .env.host.prod.example      ← host production contract
│   └── .env.edge.prod.example      ← edge ML production contract
│
├── ml/                             ← independent uv project (training + api + demo)
│   ├── pyproject.toml              ← uv project; dep groups: api (default), demo, training
│   ├── uv.lock
│   ├── contracts/                 ← L0 contracts, dataclasses, protocols
│   ├── features/                  ← L0 pure feature transforms
│   ├── sources/                   ← L1 frame intake, camera probe, source registry
│   ├── runners/                   ← L1 model/runtime adapters and warmup
│   ├── perception/                ← L2 observation building, tracking, bed detection
│   ├── domains/                   ← L3 fall/bed-exit/long-lie/risk domain logic
│   ├── worker/                    ← ml-worker process + worker-owned live orchestration/state
│   ├── events/                    ← L4 alert/event schemas, signing, publishing
│   ├── api/                   ← L5 FastAPI: /health, /status, /models, /debug/predict/*
│   ├── training/                  ← batch lifecycle; pipeline operational
│   ├── demo/                      ← Streamlit ML-demo (not the product UI)
│   ├── models/                     ← single model root (ADR-015; gitignored in entirety)
│   │   ├── pose/                   ← YOLO26-pose weight cache (re-downloadable)
│   │   │   └── yolo26{n,s,m,l,x}-pose.pt
│   │   └── fall/                   ← fall-detection models (trained + third-party)
│   │       ├── random-forest/      ← trained sklearn RF + metadata.json
│   │       ├── lstm/               ← trained PyTorch LSTM + metadata.json
│   │       ├── transformer/        ← trained PyTorch Transformer + metadata.json
│   │       └── pretrained/         ← curated comparison checkpoints (ADR-015/027)
│   └── data/                       ← ml/data gitignored as a whole (ADR-012 invariant)
│       ├── {domain}/               ← domain-first layout (ADR-012): nursing-home/, le2i/, …
│       │   ├── raw/                ← INPUT: source footage (raw is sacred)  ─┐ ADR-012
│       │   ├── processed/          ← INPUT: lossless processed clips          │ (domain-scoped)
│       │   ├── poses/              ← INPUT: extracted keypoint caches (.npz)  │
│       │   └── annotated/          ← OUTPUT: rendered overlay videos         ─┘
│       ├── uploads/                ← INPUT: demo-uploaded clips (session-scoped; ADR-012)
│       └── eval/                   ← OUTPUT: cross-domain comparison outputs (ADR-012)
│
└── docs/
    ├── architecture.md             ← this file
    ├── decisions/                  ← ADRs by MECE category: {ml,backend,frontend,common}/
    └── rules/                      ← standing conventions (e.g. streamlit-demo.md)
```

---

## Three top-level responsibilities

### 1. `front/` — Product UI

Vite 5 + React 18 + Tailwind CSS v3, React Router for routing. The frontend defaults to real backend mode (`VITE_USE_MOCK` unset or `false`) through the apiClient seam. Login/session/facility onboarding is backend-direct in dev/prod via email/password `POST /auth/login`, Kakao OAuth for existing Kakao-linked local accounts, `/auth/session`, and `POST /api/v1/facilities`; explicit `VITE_USE_MOCK=true` keeps the mock runtime available only for tests/demo-only surfaces while remaining dashboard/admin service wiring is replaced incrementally. Realtime transport strategy (SSE / WebSocket / polling) is not yet finalized.

Runs via: `pnpm dev:front` → `pnpm --filter front dev`

### 2. `backend/` — Product logic, persistence, alert policy

NestJS 11, `@nestjs/config`, Prisma 6 (PostgreSQL). Listens on `PORT` (local default 8080 from `.env.local`).

`AppModule` wires `ConfigModule` (global, reads root `.env.local` for native/local runs) and `PrismaModule`. The domain model (facility tenant root, auth/session, floor, space, zone, resident, residentAssignment, guardian, camera, alert, residentStatus) is defined in the Prisma schema with facility-scoped row-level security on the `app.facility_id` GUC ([ADR-031](decisions/backend/ADR-031-prisma-domain-model.md), superseded for the facility rename + placement domain by [ADR-058](decisions/backend/ADR-058-facility-placement-domain-model.md)/[ADR-059](decisions/backend/ADR-059-facility-rls-guc-rename.md)). Placement/resident CRUD is implemented; space-status and resident-risk read models are guarded 501 skeletons pending the ML read-model, while the alert-rule and detection-event skeleton routes have been removed.

Key responsibilities (all deferred, ownership defined now):

- Call ML API (`ML_SERVING_URL=http://localhost:8000`) with a video window — dormant ADR-048 pull seam; the live path is edge-push (`ml-worker` → `ml-api` `/api/v1/relay/*` → backend `POST /api/v1/events`, ADR-029/067)
- Apply alert policy (threshold, dedup, rate-limit)
- Dispatch webhooks (Kakao alert, etc.)
- Persist all events to PostgreSQL via Prisma

Runs via: `pnpm dev:backend` → `pnpm --filter backend start:dev`

### 3. `ml/` — Training pipeline and prediction api

Independent uv project. Two distinct lifecycles share one project:

| Lifecycle            | Entry                                          | Runtime       | Trigger                   |
| -------------------- | ---------------------------------------------- | ------------- | ------------------------- |
| **Serving** (online) | `api/main.py` (FastAPI)                        | milliseconds  | edge relay + debug HTTP (backend pull dormant, ADR-048) |
| **Training** (batch) | `training/` (scaffolded; pipeline operational) | minutes–hours | manual / scheduled job    |
| **Demo** (dev tool)  | `demo/app.py` (Streamlit)                      | interactive   | developer                 |

Serving exposes `GET /health`, `GET /status`, `GET /models`, `POST /debug/predict/window`, and `POST /debug/predict/source`. The temporary `POST /predict` alias is removed. `ml-api` boots as a thin gateway (config → device/model warmup → debug pipeline → backend-ingest gateway → heartbeat store → bounded debug source registry → readiness); it does not assemble camera loops or worker runtime (ADR-067). `/status` is derived from the relay-heartbeat store; production camera loops run in `ml-worker`. The fall runner loads `ml/models/fall/<model_type>/metadata.json`; model weights are gitignored and must be placed manually (or produced by training). See ADR-015 for the `ml/models/` single-root layout.

Dependency ladder: `contracts/features` (L0) → `sources/runners` (L1) →
`perception` (L2) → `domains` (L3) → `events` (L4) → `api/demo` (L5). Lower
layers never import higher layers. `ml-worker` owns the live orchestration/state
(there is no `runtime` package; ADR-067); `ml/core/` and `ml/util/` are removed.

Runs via: `pnpm dev:ml-api` → `uv run --directory ml uvicorn api.main:app --reload --host 127.0.0.1 --port 8000`

---

## PoC end-to-end data path

```text
[video/camera/source window]
     │
     ▼  sources → runners → perception (FrameObservation)
[POST /debug/predict/{window,source}] ──► ml/api/main.py
     │                                      │
     │                                      ▼
     │                                  FallDetector.predict(features)
     │                                  PredictResponse { model, version, fall_probability }
     │
     ▼  backend receives ML signal
[backend policy layer] ──► threshold, dedup, rate-limit, persistence, dispatch
     │
     ▼
[PostgreSQL]  +  [outbound webhook / Kakao alert]
```

The api path keeps ML thin and edge-local: source decoding, pose inference,
window feature extraction, and fall probability happen in `ml/`; product policy
and side effects happen in the backend.

The Streamlit demo (`ml/demo/app.py`) exercises the same api decision seam for
temporal classifiers through `api.client.ServingFallClassifier` and
`/debug/predict/window`. It is a **developer tool**, not the product frontend.

---

## ML ↔ Backend responsibility boundary

| Concern                | Owner                                                     | Rationale                                                                    |
| ---------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Fall probability score | **ML** (`/debug/predict/window`, `/debug/predict/source`) | Model-level signal, stateless per window/source request                      |
| Alert threshold policy | **Backend**                                               | Product decision, tuneable without redeploying ML                            |
| Deduplication          | **Backend**                                               | Requires state (recent events in Postgres)                                   |
| Webhook dispatch       | **Backend**                                               | Credential management, retry logic                                           |
| Model versioning       | **ML** (`models/fall/<model_type>/`)                      | Single-root layout (ADR-015); backend passes model_type in request if needed |

ML is intentionally thin: it predicts and emits signed event/alert payloads through the `events` seam when configured; backend decides product policy, persistence, deduplication, rate limits, and user-facing side effects.

---

## Dependency-management topology

```
Root package.json            ← orchestration scripts only; NO app dependencies
│
├── pnpm-workspace.yaml      ← declares [front, backend] as workspace packages
├── pnpm-lock.yaml           ← single lock covering front + backend
│
├── front/package.json       ← vite@5, react@18, react-router-dom@6, tailwindcss@3 (ADR-055)
└── backend/package.json     ← @nestjs/core@11, @prisma/client@6, @nestjs/config@4
                                dotenv-cli (used by prisma:migrate script)

ml/pyproject.toml            ← INDEPENDENT uv project; NOT a pnpm workspace member
ml/uv.lock                   ← uv lock; resolved separately from pnpm
```

**Why the split?** Node and Python have incompatible package managers. The root `package.json` intentionally carries no `dependencies` or `devDependencies` — it is a script hub only. Running `pnpm install` at root installs only TS workspace packages. Python deps are managed exclusively via `uv sync` inside `ml/`. The two lock files never interact.

**uv dependency groups** (`pyproject.toml`):

- `dependencies` (always installed): `fastapi`, `uvicorn[standard]`, `pydantic>=2`, `numpy>=1.26`
- `[dependency-groups.demo]`: `streamlit>=1.38`, `opencv-python-headless>=4.10`, `ultralytics>=8.3`
- `[dependency-groups.training]`: `torch>=2.3`, `scikit-learn>=1.5`, `joblib>=1.4`, `tqdm>=4.66`, `ultralytics>=8.3`, `opencv-python-headless>=4.10`
- `[tool.uv] default-groups = ["demo","test","training"]` — bare `uv sync` installs all groups; slim api image uses `--no-default-groups`

Lock file locations:
| Lock file | Path | Ecosystem |
|-----------|------|-----------|
| pnpm | `pnpm-lock.yaml` (repo root) | Node / front + backend |
| uv | `ml/uv.lock` | Python / ml |

---

## Data persistence

PostgreSQL everywhere. The choice was made because Prisma bakes `provider` into the schema and migration files — unlike Hibernate, it does not support runtime dialect switching. Using SQLite in dev and PostgreSQL in prod would require maintaining two migration histories. See [ADR-002](decisions/backend/ADR-002-postgres-everywhere.md) for the full trade-off analysis.

| Layer            | Technology                                       | Config                         |
| ---------------- | ------------------------------------------------ | ------------------------------ |
| Database engine  | PostgreSQL 17-alpine (Docker)                    | `docker-compose.yml`           |
| ORM / migrations | Prisma 6                                         | `backend/prisma/schema.prisma` |
| Dev connection   | `postgresql://fall:fall@localhost:5432/fall_dev` | `.env.local`                   |
| Prod connection  | `postgresql://<user>:<pass>@<host>:5432/<db>`    | `.env.host.prod`               |

Start the database:

```bash
pnpm db:up                    # docker compose up -d db
pnpm prisma:migrate           # prisma migrate dev (reads .env.local via dotenv-cli)
pnpm prisma:generate          # regenerate Prisma client after schema changes
```

The Compose stack mounts a named volume (`pgdata`) so data survives container restarts. Default local credentials (`fall`/`fall`) match `.env.local`; production overlays require `.env.host.prod`.

**Compose topology (ADR-062, ADR-063).** The host stack is `db` + `backend` + `front`, all in `compose.yaml` with `backend`/`front` behind the `full` profile, plus `compose.prod.yaml` as the prod overlay. `pnpm db:up` is db-only with `.env.local` (daily dev is native hot reload via `pnpm dev:*`); `pnpm compose:local:up` brings up the whole local host stack with `.env.local`, and `pnpm compose:prod:up` brings up the same full host stack with `.env.host.prod`. There is no `compose.override.yaml` (the container-dev overlay was removed in ADR-063). `front` is a Vite SPA served by `nginx` that reverse-proxies `/api` and `/auth` to `backend:8080` (same-origin). ML is **not** in the host stack — it runs on the external edge device defined by `compose.edge.yaml` and `.env.edge.prod`, then pushes no-HMAC events to backend `POST /api/v1/events` through the single `API_BACKEND_EVENTS_URL` setting (ADR-029); the backend `ML_SERVING_URL` pull seam stays dormant (ADR-048). DB backups: `scripts/db-backup.sh` (backup + restore procedure documented in its header).

---

## Lint and type-check

| Tool                  | Scope                                     | Command                              |
| --------------------- | ----------------------------------------- | ------------------------------------ |
| ESLint                | front, backend                            | `pnpm -r lint`                       |
| Prettier              | backend only (front formatting not wired) | `pnpm format`                        |
| `tsc --noEmit`        | front, backend                            | `pnpm typecheck`                     |
| ruff (check + format) | ml                                        | `uv run --directory ml ruff check .` |

Lint philosophy: basics only — ESLint defaults for TS, ruff rule sets E/F/I/UP for Python, Prettier formatting, and TypeScript strict type-check. No exhaustive rule sets at PoC stage. (`pnpm format` runs Prettier for `backend/` and `ruff format` for `ml/`; `front/` formatting is not yet wired.)

---

## Key ADRs

ADRs are organized by active MECE category under `docs/decisions/{ml,backend,frontend,common}/`. The exhaustive index, coverage matrix, supersession checks, and no-omission audit live in [`docs/decisions/README.md`](decisions/README.md); this section keeps only architecture-level cross-links.

| Concern                                            | Current authority                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Architecture note                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo topology and dependency ownership             | [ADR-001 — Polyglot monorepo / per-ecosystem dependency management](decisions/common/ADR-001-polyglot-monorepo.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Node (pnpm workspace) and Python (uv) are managed independently; root `package.json` is orchestration-only.                                                                                                                                                          |
| Backend persistence                                | [ADR-002 — PostgreSQL everywhere](decisions/backend/ADR-002-postgres-everywhere.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Single DB engine (Postgres via Docker) in all envs; avoids Prisma provider-lock and SQLite↔Postgres migration divergence.                                                                                                                                            |
| ML API/training lifecycle                          | [ADR-022 — ML API and training lifecycle boundary](decisions/ml/ADR-022-ml-api-training-lifecycle.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Active lifecycle authority extracted from retired source ADR-003.                                                                                                                                                                                                    |
| ML ↔ backend prediction boundary                   | [ADR-023 — ML prediction boundary and backend product-policy ownership](decisions/common/ADR-023-ml-backend-prediction-boundary.md)                                                                                                                                                                                                                                                                                                                                                                                                                                | ML returns signals; backend owns alert policy, persistence, deduplication, rate limits, and side effects.                                                                                                                                                            |
| ML demo vs product frontend boundary               | [ADR-024 — ML demo surface is not the product frontend](decisions/common/ADR-024-ml-demo-product-surface-boundary.md)                                                                                                                                                                                                                                                                                                                                                                                                                                              | `ml/demo/` is an ML observation harness; `front/` is the product UI.                                                                                                                                                                                                 |
| ML data layout and access                          | [ADR-012 — Domain-first two-tier layout for `ml/data/`](decisions/ml/ADR-012-ml-data-domain-first-layout.md), [ADR-028 — Demo access boundary](decisions/common/ADR-028-demo-access-boundary.md) (superseded), and [ADR-045 — Streamlit demo is local-only](decisions/common/ADR-045-streamlit-demo-local-only.md)                                                                                                                                                                                                                                                 | ADR-012 owns domain-first ML data layout. ADR-028's deploy-time demo-access boundary is superseded by ADR-045: the demo is local-only, so the `FALL_DEMO_MODE` public/operator branching is removed. Retired source ADR-004 is mapped in the README coverage matrix. |
| Pose framework                                     | [ADR-025 — YOLO26-pose framework adoption](decisions/ml/ADR-025-yolo26-pose-framework-adoption.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Active framework authority extracted from retired source ADR-005.                                                                                                                                                                                                    |
| Frame, source, and model contracts                 | [ADR-056 — ML frame intake and source-package layout](decisions/ml/ADR-056-ml-frame-intake-and-source-package-layout.md) and [ADR-057 — FrameObservation, runner contracts, and edge-runtime architecture](decisions/ml/ADR-057-frame-observation-runner-contracts-and-edge-runtime-architecture.md) (current authorities), superseding [ADR-050](decisions/ml/ADR-050-frame-model-contract-architecture.md), [ADR-026](decisions/ml/ADR-026-frame-model-seam-architecture.md), and [ADR-006](decisions/ml/ADR-006-frame-source-intake-in-ml-util.md) (historical) | `FrameSource` intake lives under `ml/sources/` (ADR-056); `FrameObservation`, runner contracts, `ModelRegistry`, and the L0→api dependency ladder are defined by ADR-057. ADR-006/026/050 are retained only as historical references.                                |
| Inference output and baselines                     | [ADR-027 — Inference output axis and comparison baseline policy](decisions/ml/ADR-027-inference-output-baseline-policy.md)                                                                                                                                                                                                                                                                                                                                                                                                                                         | Active output-axis, baseline-retention, and fake-adapter rejection authority extracted from retired source ADR-005.                                                                                                                                                  |
| ML local generated/model paths                     | [ADR-015 — `ml/models/` single root](decisions/ml/ADR-015-ml-models-single-root.md) and [ADR-012](decisions/ml/ADR-012-ml-data-domain-first-layout.md)                                                                                                                                                                                                                                                                                                                                                                                                             | Current model and data roots supersede retired source ADR-007.                                                                                                                                                                                                       |
| Issue/worktree enforcement                         | [ADR-008 — Issue-driven worktrees, enforced git-natively](decisions/common/ADR-008-issue-driven-worktree-enforcement.md)                                                                                                                                                                                                                                                                                                                                                                                                                                           | One issue → one branch/worktree through `git wt`; guard scripts are shared enforcement source.                                                                                                                                                                       |
| Fall-classification strategy                       | [ADR-009 — Fall-classification strategy](decisions/ml/ADR-009-fall-classification-strategy.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Classifier is learned temporal models over COCO-17 keypoint sequences; public datasets first.                                                                                                                                                                        |
| Real-time demo mode                                | [ADR-010 — Real-time per-frame live inference demo mode](decisions/ml/ADR-010-realtime-live-inference-demo-mode.md) and [ADR-011 — Live camera intake as second `FrameSource`](decisions/ml/ADR-011-live-camera-intake-and-multipage-demo.md)                                                                                                                                                                                                                                                                                                                      | Recorded clip and camera demo modes share frame-source concepts while keeping pages separate.                                                                                                                                                                        |
| Training and evaluation gates                      | [ADR-013 — Le2i training-pipeline decisions](decisions/ml/ADR-013-le2i-training-pipeline-decisions.md), [ADR-017 — Fall-model adoption criteria](decisions/ml/ADR-017-fall-model-adoption-criteria.md), and [ADR-019 — Nursing-home gold dataset construction methodology](decisions/ml/ADR-019-nh-gold-dataset-construction.md)                                                                                                                                                                                                                                   | Training/evaluation choices remain ML-local; backend/frontend consume accepted model behavior rather than training internals.                                                                                                                                        |
| Fail-fast and enforcement timing                   | [ADR-014 — Fail-fast error policy](decisions/common/ADR-014-fail-fast-error-policy.md) and [ADR-016 — Enforcement timing principle](decisions/common/ADR-016-enforcement-timing-principle.md)                                                                                                                                                                                                                                                                                                                                                                      | Cross-runtime refusal policy and enforcement timing remain strict common decisions.                                                                                                                                                                                  |
| Dataset custody, autoresearch, and demo deployment | [ADR-018 — Cross-machine dataset custody and sync](decisions/ml/ADR-018-cross-machine-dataset-custody.md), [ADR-020 — Autoresearch loop method](decisions/ml/ADR-020-autoresearch-loop-method.md), and [ADR-021 — Demo cloud deployment deferred](decisions/ml/ADR-021-demo-cloud-deployment-deferred.md)                                                                                                                                                                                                                                                          | ML operational decisions stay ML-local unless they impose constraints on product backend/frontend surfaces.                                                                                                                                                          |

> Rationale for each decision lives in the ADR files. The coverage matrix is the authority for MECE placement and preservation checks.
