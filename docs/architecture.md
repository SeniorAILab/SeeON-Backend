# Architecture Overview — eldercare-fall-ai

> PoC status (2026-06-07). Realtime transport, full feature implementation, and ML training pipeline are explicitly deferred. This document reflects the scaffolded skeleton only.

---

## Directory tree

```
eldercare-fall-ai/                  ← orchestration layer only (no app deps here)
├── package.json                    ← dev:*, build:*, lint, db:*, prisma:* scripts
├── pnpm-workspace.yaml             ← workspace: [front, backend]
├── pnpm-lock.yaml                  ← single lock for all TS packages
├── docker-compose.yml              ← postgres:17-alpine service (db)
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
│   ├── .env.development            ← DATABASE_URL + ML_SERVING_URL (localhost)
│   ├── .env.production
│   └── .env.example
│
├── ml/                             ← independent uv project (training + serving + demo)
│   ├── pyproject.toml              ← uv project; dep groups: serving (default), demo, training
│   ├── uv.lock
│   ├── serving/
│   │   ├── main.py                 ← FastAPI app: GET /health, POST /predict
│   │   └── model.py                ← FallDetector loader (placeholder → real weights later)
│   ├── training/                   ← batch lifecycle; scaffolded; pipeline operational
│   ├── demo/
│   │   └── app.py                  ← Streamlit ML-demo (not the product UI)
│   ├── util/                       ← shared, demo-agnostic helpers (ADR-006)
│   │   └── frame_source.py         ← Frame / FrameSource / VideoFileSource / CameraSource (stream intake)
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

Vite 5 + React 18 + Tailwind CSS v3, React Router for routing. Dashboard UI (monitoring, alerts, residents, admin) currently driven by mock services (`USE_MOCK=true`) behind an apiClient seam; Phase 2 wires these to the backend. Realtime transport strategy (SSE / WebSocket / polling) is not yet finalized.

Runs via: `pnpm dev:front` → `pnpm --filter front dev`

### 2. `backend/` — Product logic, persistence, alert policy

NestJS 11, `@nestjs/config` (env-file per `NODE_ENV`), Prisma 6 (PostgreSQL). Listens on `PORT` (default 3000, configured in `.env.development`).

`AppModule` wires `ConfigModule` (global, reads `.env.${NODE_ENV}`) and `PrismaModule`. The domain model (organization, auth/session, resident, guardian, camera, alert, residentStatus) is defined in the Prisma schema with org-scoped row-level security ([ADR-031](decisions/backend/ADR-031-prisma-domain-model.md)). Product logic over these models is deferred to later #105 slices.

Key responsibilities (all deferred, ownership defined now):
- Call ML serving (`ML_SERVING_URL=http://localhost:8000`) with a video window
- Apply alert policy (threshold, dedup, rate-limit)
- Dispatch webhooks (Kakao alert, etc.)
- Persist all events to PostgreSQL via Prisma

Runs via: `pnpm dev:backend` → `pnpm --filter backend start:dev`

### 3. `ml/` — Training pipeline and prediction serving

Independent uv project. Two distinct lifecycles share one project:

| Lifecycle | Entry | Runtime | Trigger |
|-----------|-------|---------|---------|
| **Serving** (online) | `serving/main.py` (FastAPI) | milliseconds | HTTP request from backend |
| **Training** (batch) | `training/` (scaffolded; pipeline operational) | minutes–hours | manual / scheduled job |
| **Demo** (dev tool) | `demo/app.py` (Streamlit) | interactive | developer |

Serving exposes `GET /health` and `POST /predict`. The `FallDetector` class in `serving/model.py` loads `ml/models/fall/<model_type>/metadata.json`; model weights are gitignored and must be placed manually (or produced by training). See ADR-015 for the `ml/models/` single-root layout.

Runs via: `pnpm dev:ml` → `uv run --directory ml uvicorn serving.main:app --reload --host 0.0.0.0 --port 8000`

---

## PoC end-to-end data path

```
[video file]
     │
     ▼  windowing (per-frame feature vectors, e.g. pose keypoints)
[POST /predict]  ──►  ml/serving/main.py
     │                   │
     │                   ▼  FallDetector.predict(window) → fall_probability ∈ [0, 1]
     │               PredictResponse { model, version, fall_probability }
     │
     ▼  backend receives response
[backend webhook handler]  ──►  alert policy (threshold, dedup)
     │
     ▼
[PostgreSQL]  +  [outbound webhook / Kakao alert]
```

The PoC placeholder (`serving/model.py`) returns `min(1.0, len(window) / 100.0)` so the full path is exercisable without trained weights. Replace `FallDetector.predict` with real YOLO26-pose keypoint inference when weights are ready (framework choice per [ADR-025](decisions/ml/ADR-025-yolo26-pose-framework-adoption.md)).

The Streamlit demo (`ml/demo/app.py`) exercises this same path locally (uploads video → constructs a dummy window → calls `model.predict` → displays probability) without going through the backend. It is a **developer tool**, not the product frontend.

---

## ML ↔ Backend responsibility boundary

| Concern | Owner | Rationale |
|---------|-------|-----------|
| Fall probability score | **ML** (`/predict`) | Model-level signal, stateless per window |
| Alert threshold policy | **Backend** | Product decision, tuneable without redeploying ML |
| Deduplication | **Backend** | Requires state (recent events in Postgres) |
| Webhook dispatch | **Backend** | Credential management, retry logic |
| Model versioning | **ML** (`models/fall/<model_type>/`) | Single-root layout (ADR-015); backend passes model_type in request if needed |

ML is intentionally thin: it predicts, backend decides. This boundary is explicit in `ml/serving/main.py`'s module docstring and `ml/demo/app.py`'s info callout.

---

## Dependency-management topology

```
Root package.json            ← orchestration scripts only; NO app dependencies
│
├── pnpm-workspace.yaml      ← declares [front, backend] as workspace packages
├── pnpm-lock.yaml           ← single lock covering front + backend
│
├── front/package.json       ← next@16.2.7, react@19, tailwindcss@4
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
- `[tool.uv] default-groups = ["demo","test","training"]` — bare `uv sync` installs all groups; slim serving image uses `--no-default-groups`

Lock file locations:
| Lock file | Path | Ecosystem |
|-----------|------|-----------|
| pnpm | `pnpm-lock.yaml` (repo root) | Node / front + backend |
| uv | `ml/uv.lock` | Python / ml |

---

## Data persistence

PostgreSQL everywhere. The choice was made because Prisma bakes `provider` into the schema and migration files — unlike Hibernate, it does not support runtime dialect switching. Using SQLite in dev and PostgreSQL in prod would require maintaining two migration histories. See [ADR-002](decisions/backend/ADR-002-postgres-everywhere.md) for the full trade-off analysis.

| Layer | Technology | Config |
|-------|-----------|--------|
| Database engine | PostgreSQL 17-alpine (Docker) | `docker-compose.yml` |
| ORM / migrations | Prisma 6 | `backend/prisma/schema.prisma` |
| Dev connection | `postgresql://fall:fall@localhost:5432/fall_dev` | `backend/.env.development` |
| Prod connection | `postgresql://<user>:<pass>@<host>:5432/<db>` | `backend/.env.production` |

Start the database:

```bash
pnpm db:up                    # docker compose up -d db
pnpm prisma:migrate           # prisma migrate dev (reads .env.development via dotenv-cli)
pnpm prisma:generate          # regenerate Prisma client after schema changes
```

The `docker-compose.yml` mounts a named volume (`pgdata`) so data survives container restarts. Default credentials (`fall`/`fall`) match `.env.development`; override via environment variables before `docker compose up`.

---

## Lint and type-check

| Tool | Scope | Command |
|------|-------|---------|
| ESLint | front, backend | `pnpm -r lint` |
| Prettier | backend only (front formatting not wired) | `pnpm format` |
| `tsc --noEmit` | front, backend | `pnpm typecheck` |
| ruff (check + format) | ml | `uv run --directory ml ruff check .` |

Lint philosophy: basics only — ESLint defaults for TS, ruff rule sets E/F/I/UP for Python, Prettier formatting, and TypeScript strict type-check. No exhaustive rule sets at PoC stage. (`pnpm format` runs Prettier for `backend/` and `ruff format` for `ml/`; `front/` formatting is not yet wired.)

---

## Key ADRs

ADRs are organized by active MECE category under `docs/decisions/{ml,backend,frontend,common}/`. The exhaustive index, coverage matrix, supersession checks, and no-omission audit live in [`docs/decisions/README.md`](decisions/README.md); this section keeps only architecture-level cross-links.

| Concern | Current authority | Architecture note |
|-----|----------|----------|
| Repo topology and dependency ownership | [ADR-001 — Polyglot monorepo / per-ecosystem dependency management](decisions/common/ADR-001-polyglot-monorepo.md) | Node (pnpm workspace) and Python (uv) are managed independently; root `package.json` is orchestration-only. |
| Backend persistence | [ADR-002 — PostgreSQL everywhere](decisions/backend/ADR-002-postgres-everywhere.md) | Single DB engine (Postgres via Docker) in all envs; avoids Prisma provider-lock and SQLite↔Postgres migration divergence. |
| ML serving/training lifecycle | [ADR-022 — ML serving and training lifecycle boundary](decisions/ml/ADR-022-ml-serving-training-lifecycle.md) | Active lifecycle authority extracted from retired source ADR-003. |
| ML ↔ backend prediction boundary | [ADR-023 — ML prediction boundary and backend product-policy ownership](decisions/common/ADR-023-ml-backend-prediction-boundary.md) | ML returns signals; backend owns alert policy, persistence, deduplication, rate limits, and side effects. |
| ML demo vs product frontend boundary | [ADR-024 — ML demo surface is not the product frontend](decisions/common/ADR-024-ml-demo-product-surface-boundary.md) | `ml/demo/` is an ML observation harness; `front/` is the product UI. |
| ML data layout and access | [ADR-012 — Domain-first two-tier layout for `ml/data/`](decisions/ml/ADR-012-ml-data-domain-first-layout.md), [ADR-028 — Demo access boundary](decisions/common/ADR-028-demo-access-boundary.md) (superseded), and [ADR-045 — Streamlit demo is local-only](decisions/common/ADR-045-streamlit-demo-local-only.md) | ADR-012 owns domain-first ML data layout. ADR-028's deploy-time demo-access boundary is superseded by ADR-045: the demo is local-only, so the `FALL_DEMO_MODE` public/operator branching is removed. Retired source ADR-004 is mapped in the README coverage matrix. |
| Pose framework | [ADR-025 — YOLO26-pose framework adoption](decisions/ml/ADR-025-yolo26-pose-framework-adoption.md) | Active framework authority extracted from retired source ADR-005. |
| Frame and model contracts | [ADR-050 — Frame and model contract architecture](decisions/ml/ADR-050-frame-model-contract-architecture.md), [ADR-026 — Frame and model seam architecture](decisions/ml/ADR-026-frame-model-seam-architecture.md) (terminology superseded), and [ADR-006 — Frame-source intake in `ml/util/`](decisions/ml/ADR-006-frame-source-intake-in-ml-util.md) | `FrameSource` intake is shared from `ml/util/`; stream/model contracts keep demo, serving, and models pluggable without reversing dependencies. |
| Inference output and baselines | [ADR-027 — Inference output axis and comparison baseline policy](decisions/ml/ADR-027-inference-output-baseline-policy.md) | Active output-axis, baseline-retention, and fake-adapter rejection authority extracted from retired source ADR-005. |
| ML local generated/model paths | [ADR-015 — `ml/models/` single root](decisions/ml/ADR-015-ml-models-single-root.md) and [ADR-012](decisions/ml/ADR-012-ml-data-domain-first-layout.md) | Current model and data roots supersede retired source ADR-007. |
| Issue/worktree enforcement | [ADR-008 — Issue-driven worktrees, enforced git-natively](decisions/common/ADR-008-issue-driven-worktree-enforcement.md) | One issue → one branch/worktree through `git wt`; guard scripts are shared enforcement source. |
| Fall-classification strategy | [ADR-009 — Fall-classification strategy](decisions/ml/ADR-009-fall-classification-strategy.md) | Classifier is learned temporal models over COCO-17 keypoint sequences; public datasets first. |
| Real-time demo mode | [ADR-010 — Real-time per-frame live inference demo mode](decisions/ml/ADR-010-realtime-live-inference-demo-mode.md) and [ADR-011 — Live camera intake as second `FrameSource`](decisions/ml/ADR-011-live-camera-intake-and-multipage-demo.md) | Recorded clip and camera demo modes share frame-source concepts while keeping pages separate. |
| Training and evaluation gates | [ADR-013 — Le2i training-pipeline decisions](decisions/ml/ADR-013-le2i-training-pipeline-decisions.md), [ADR-017 — Fall-model adoption criteria](decisions/ml/ADR-017-fall-model-adoption-criteria.md), and [ADR-019 — Nursing-home gold dataset construction methodology](decisions/ml/ADR-019-nh-gold-dataset-construction.md) | Training/evaluation choices remain ML-local; backend/frontend consume accepted model behavior rather than training internals. |
| Fail-fast and enforcement timing | [ADR-014 — Fail-fast error policy](decisions/common/ADR-014-fail-fast-error-policy.md) and [ADR-016 — Enforcement timing principle](decisions/common/ADR-016-enforcement-timing-principle.md) | Cross-runtime refusal policy and enforcement timing remain strict common decisions. |
| Dataset custody, autoresearch, and demo deployment | [ADR-018 — Cross-machine dataset custody and sync](decisions/ml/ADR-018-cross-machine-dataset-custody.md), [ADR-020 — Autoresearch loop method](decisions/ml/ADR-020-autoresearch-loop-method.md), and [ADR-021 — Demo cloud deployment deferred](decisions/ml/ADR-021-demo-cloud-deployment-deferred.md) | ML operational decisions stay ML-local unless they impose constraints on product backend/frontend surfaces. |

> Rationale for each decision lives in the ADR files. The coverage matrix is the authority for MECE placement and preservation checks.
