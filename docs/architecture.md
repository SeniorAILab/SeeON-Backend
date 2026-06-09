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
├── front/                          ← Next.js 16 / React 19 / Tailwind v4 (product UI)
│   ├── src/app/
│   │   ├── layout.tsx
│   │   └── page.tsx
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
│   ├── training/                   ← batch lifecycle placeholder (deferred)
│   ├── demo/
│   │   └── app.py                  ← Streamlit ML-demo (not the product UI)
│   ├── util/                       ← shared, demo-agnostic helpers (ADR-006)
│   │   └── frame_source.py         ← Frame / FrameSource / VideoFileSource (stream intake)
│   ├── artifacts/
│   │   └── fall-detector/0.1.0/
│   │       └── metadata.json       ← versioned artifact descriptor; model.pt gitignored
│   └── data/
│       ├── raw/                    ← source videos (gitignored; relocated from assets/)
│       └── processed/              ← cropped/renamed clips (gitignored)
│
└── docs/
    ├── architecture.md             ← this file
    ├── decisions/                  ← ADRs (see below)
    └── rules/                      ← standing conventions (e.g. streamlit-demo.md)
```

---

## Three top-level responsibilities

### 1. `front/` — Product UI

Next.js 16.2.7 (App Router), React 19, Tailwind CSS v4. Currently a `create-next-app` skeleton (`src/app/page.tsx`, `layout.tsx`). Future work: upload UI, caregiver dashboard, alert feed. Realtime transport strategy (SSE / WebSocket / polling) is not yet decided.

Runs via: `pnpm dev:front` → `pnpm --filter front dev`

### 2. `backend/` — Product logic, persistence, alert policy

NestJS 11, `@nestjs/config` (env-file per `NODE_ENV`), Prisma 6 (PostgreSQL). Listens on `PORT` (default 3000, configured in `.env.development`).

`AppModule` wires `ConfigModule` (global, reads `.env.${NODE_ENV}`) and `PrismaModule`. Domain models (`AnalysisJob`, `Prediction`, `Alert`) are scaffolded as schema comments and will be added when feature work starts.

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
| **Training** (batch) | `training/` (deferred) | minutes–hours | manual / scheduled job |
| **Demo** (dev tool) | `demo/app.py` (Streamlit) | interactive | developer |

Serving exposes `GET /health` and `POST /predict`. The `FallDetector` class in `serving/model.py` loads `ml/artifacts/fall-detector/<version>/metadata.json`; `model.pt` weights are gitignored and must be placed manually (or produced by training).

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

The PoC placeholder (`serving/model.py`) returns `min(1.0, len(window) / 100.0)` so the full path is exercisable without trained weights. Replace `FallDetector.predict` with real YOLO26-pose keypoint inference when weights are ready (framework choice per [ADR-005](decisions/ADR-005-yolo26-pose-and-module-seam.md)).

The Streamlit demo (`ml/demo/app.py`) exercises this same path locally (uploads video → constructs a dummy window → calls `model.predict` → displays probability) without going through the backend. It is a **developer tool**, not the product frontend.

---

## ML ↔ Backend responsibility boundary

| Concern | Owner | Rationale |
|---------|-------|-----------|
| Fall probability score | **ML** (`/predict`) | Model-level signal, stateless per window |
| Alert threshold policy | **Backend** | Product decision, tuneable without redeploying ML |
| Deduplication | **Backend** | Requires state (recent events in Postgres) |
| Webhook dispatch | **Backend** | Credential management, retry logic |
| Model versioning | **ML** (`artifacts/<name>/<version>/`) | Triton-inspired layout; backend passes version in request if needed |

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
- `dependencies` (default, always installed): `fastapi`, `uvicorn[standard]`, `pydantic>=2`, `numpy>=1.26`
- `[dependency-groups.demo]`: `streamlit>=1.38` — installed with `--group demo`
- `[dependency-groups.training]`: empty placeholder; add ultralytics/torch/etc. when training starts

Lock file locations:
| Lock file | Path | Ecosystem |
|-----------|------|-----------|
| pnpm | `pnpm-lock.yaml` (repo root) | Node / front + backend |
| uv | `ml/uv.lock` | Python / ml |

---

## Data persistence

PostgreSQL everywhere. The choice was made because Prisma bakes `provider` into the schema and migration files — unlike Hibernate, it does not support runtime dialect switching. Using SQLite in dev and PostgreSQL in prod would require maintaining two migration histories. See [docs/decisions/ADR-002-postgres-everywhere.md](decisions/ADR-002-postgres-everywhere.md) for the full trade-off analysis.

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

| ADR | Decision |
|-----|----------|
| [ADR-001 — Polyglot monorepo / per-ecosystem dependency management](decisions/ADR-001-polyglot-monorepo.md) | Node (pnpm workspace) and Python (uv) managed independently; root package.json is orchestration-only |
| [ADR-002 — PostgreSQL everywhere](decisions/ADR-002-postgres-everywhere.md) | Single DB engine (Postgres via Docker) in all envs; avoids Prisma's provider-lock problem with SQLite↔Postgres migration divergence |
| [ADR-003 — ML serving/training lifecycle split](decisions/ADR-003-ml-serving-training-split.md) | Serving (online, FastAPI) and training (batch, deferred) share one uv project but have distinct entry points and responsibility boundaries |
| [ADR-004 — Relocate video data from assets/ to ml/data/](decisions/ADR-004-relocate-video-data-to-ml-data.md) | Video assets moved from `assets/` to `ml/data/raw` and `ml/data/processed`; ML owns its training data |
| [ADR-005 — YOLO26-pose stack + two-seam module architecture](decisions/ADR-005-yolo26-pose-and-module-seam.md) | Framework moves MediaPipe→Ultralytics YOLO26-pose (domain-fit **partially verified** 2026-06-08: pose locks precisely where a person is detected, but bedridden ceiling top-down views are an out-of-distribution detection-miss → scale-up then domain fine-tuning); a `FrameSource` stream-seam unifies file + live stream and a `ModelModule.predict(frame)→DetectionResult` model-seam makes models pluggable. Complements ADR-003, does not supersede it |
| [ADR-006 — Frame-source intake in `ml/util/`](decisions/ADR-006-frame-source-intake-in-ml-util.md) | The stream-seam intake (`Frame`/`FrameSource`/`VideoFileSource`) moves to `ml/util/` so serving/realtime can reuse one frame-intake without depending on `demo/` (strict `demo → util` direction, guard-tested). Model-seam, playback/seek, and overlay stay in `demo/` (YAGNI). References ADR-005, complements ADR-003 |

> Rationale for each decision lives in the ADR files above, not repeated here.
