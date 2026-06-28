# Architecture Overview — eldercare-fall-ai

> Current status (2026-06-27). The live edge-push path is operating: `ml-worker` owns RTSP capture/inference/domain facts, `ml-api` relays them to backend Event API, backend persists policy-derived events/alerts, SSE pushes dashboard updates, and the ML training pipeline is operational.

---

## 시스템 토폴로지 (인스턴스 상호작용)

각 인스턴스가 어디에 배치되고 서로 어떻게 호출하는지의 한눈 지도다. 실선은 요청/egress, 점선은 backend가 되돌려주는 실시간 push와 휴면(dormant) seam이다. 단계별 데이터 흐름은 아래 "End-to-end live data path" 섹션을, 각 런타임 내부는 "상세 아키텍처(deep dives)"의 문서를 본다.

```mermaid
flowchart LR
  user["관리자 / 직원<br/>브라우저"]

  subgraph site["현장 Edge device — compose.edge.yaml"]
    cam["RTSP 카메라"]
    worker["ml-worker<br/>capture → pose → domain fact"]
    mlapi["ml-api :8000<br/>relay gateway"]
  end

  subgraph hoststack["Host stack — compose.yaml"]
    front["front :3000<br/>nginx + Vite SPA"]
    backend["backend :8080<br/>NestJS 정책/영속/SSE"]
    db[("PostgreSQL :5432<br/>RLS app.facility_id")]
  end

  kakao["Kakao API<br/>send-to-me"]

  cam -->|"RTSP stream"| worker
  worker -->|"POST /api/v1/relay/{alerts,heartbeat}<br/>X-Edge-Relay-Token"| mlapi
  mlapi -->|"POST /api/v1/events (+heartbeat)<br/>no-HMAC · camera_id"| backend
  backend -->|"Prisma · facility-scoped RLS"| db
  backend -->|"send-to-me (outbox/delivery)"| kakao
  user -->|"HTTPS /auth/*, /api/v1/*<br/>session cookie"| front
  front -->|"reverse proxy /api, /auth"| backend
  backend -.->|"SSE /api/v1/dashboard/stream<br/>alert · status frames"| user
  backend -.->|"ML_SERVING_URL pull seam<br/>dormant · ADR-048/062"| mlapi
```

> 라이브 ingress는 `ml-api → backend POST /api/v1/events` 하나뿐이다. `ml-worker`는 backend를 직접 호출하지 않고 local `ml-api` relay만 부른다. SSE는 같은 nginx same-origin 프록시를 통해 backend가 브라우저로 push한다.

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
│   │   ├── main.ts                 ← listens on PORT (default 8080)
│   │   ├── app.module.ts           ← ConfigModule + PrismaModule
│   │   └── prisma/
│   │       ├── prisma.module.ts
│   │       └── prisma.service.ts
│   ├── prisma/schema.prisma        ← provider=postgresql, url=env("DATABASE_URL")
├── .env.local.example              ← native/local + local Compose development contract
├── .env.host.prod.example          ← host production contract
├── .env.edge.prod.example          ← edge ML production contract
│
├── ml/                             ← independent uv project (training + api + demo)
│   ├── pyproject.toml              ← uv project; dep groups: api (default), demo, training
│   ├── uv.lock
│   ├── contracts/                 ← L0 contracts, dataclasses, protocols
│   ├── features/                  ← L0 pure feature transforms
│   ├── events/                    ← alert/event schemas, signing, publishing
│   ├── api/                       ← ML-free FastAPI gateway: /health/*, /api/v1/status, /api/v1/models, /api/v1/relay/*
│   ├── worker/                    ← ml-worker process + worker-owned live ML/orchestration/state
│   │   ├── sources/               ← frame intake, camera probe, source registry
│   │   ├── runners/               ← model/runtime adapters and warmup
│   │   ├── perception/            ← observation building, tracking, bed detection
│   │   └── domains/               ← fall/bed-exit/long-lie/risk domain logic
│   ├── training/                  ← batch lifecycle; self-contained pose extraction + model artifacts
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
    ├── onboarding/                 ← onboarding deep dives: edge, frontend, backend flows
    ├── decisions/                   ← ADRs by MECE category: {ml,backend,frontend,common}/
    └── rules/                       ← standing conventions (e.g. streamlit-demo.md)
```

---

## Three top-level responsibilities

### 1. `front/` — Product UI

Vite 5 + React 18 + Tailwind CSS v3, React Router for routing. The frontend defaults to real backend mode (`VITE_USE_MOCK` unset or `false`) through the apiClient seam. Login/session/facility onboarding is backend-direct in dev/prod via email/password `POST /auth/login`, Kakao OAuth for existing Kakao-linked local accounts, `/auth/session`, and `POST /api/v1/facilities`. Realtime dashboard updates arrive through backend SSE (`GET /api/v1/dashboard/stream`) with cookie auth and `alertSeq` replay.

**Demo vs runtime (canonical).** The front-only mock runtime (`VITE_USE_MOCK=true` with `realtimeEngine`, `mockData`, and `DemoMode`) is the front-alone "demo" path — it exists only to run the frontend by itself without a backend. dev and prod run on the real backend + real DB (demo content is seeded via `backend/prisma/demo-nokyang.fixture.ts`); there is no mock at runtime in dev/prod. The mock survives only for automated tests. The front-only mock ("demo") is therefore being retired; removing the mock-runtime code is a tracked follow-up.

**Frontend overview.** Three UI modes: staff (`StaffLayout`: `/now` `/rooms` `/alerts`), admin (`AppLayout` sidebar: `/admin/*`), monitor (fullscreen TV: `/monitor`). Service seam: components/pages call `src/services/*`; backend endpoint mappers live in `src/services/api/*`; UI never consumes backend DTOs directly. Key frontend domain entities (`front/src/types/index.ts`, the FE domain SSOT until Phase 2): Facility, Floor, Space, Zone, SpaceStatus, DetectionEvent, ActionLog, Resident, ResidentAssignment, ResidentRiskSummary, ResidentAction, VideoClip, VideoAccessLog, AlertRule, User, MonitorSettings, DemoMode. The frontend domain model is a UI/domain view and currently diverges from the backend DB model; alignment is tracked in a dedicated FE↔BE issue.

Runs via: `pnpm dev:front` → `pnpm --filter front dev`

### 2. `backend/` — Product logic, persistence, alert policy

NestJS 11, `@nestjs/config`, Prisma 6 (PostgreSQL). Listens on `PORT` (local default 8080 from `.env.local`).

`AppModule` wires `ConfigModule` (global, reads root `.env.local` for native/local runs) and `PrismaModule`. The domain model (facility tenant root, auth/session, floor, space, zone, resident, residentAssignment, guardian, camera, alert, residentStatus) is defined in the Prisma schema with facility-scoped row-level security on the `app.facility_id` GUC ([ADR-031](decisions/backend/ADR-031-prisma-domain-model.md), superseded for the facility rename + placement domain by [ADR-058](decisions/backend/ADR-058-facility-placement-domain-model.md)/[ADR-059](decisions/backend/ADR-059-facility-rls-guc-rename.md)). Placement/resident CRUD is implemented; space-status and resident-risk read models are guarded 501 skeletons pending the ML read-model, while the alert-rule and detection-event skeleton routes have been removed.

Key responsibilities:

- Own auth/session, facility-scoped RLS (`app.facility_id`), dashboard read models, and admin CRUD.
- Receive edge facts through backend Event API (`POST /api/v1/events` and `POST /api/v1/events/heartbeat`); the former `ML_SERVING_URL` backend-pull seam from ADR-048/062 was dormant and removed; it is not part of the live path.
- Apply alert policy (threshold, dedup key, rate-limit), persist immutable events and derived alerts, and publish SSE dashboard frames.
- Dispatch Kakao delivery through the outbox/delivery adapter layer.

Runs via: `pnpm dev:backend` → `pnpm --filter backend start:dev`

### 3. `ml/` — Training pipeline, live worker, and gateway api

Independent uv project. Two distinct lifecycles share one project:

| Lifecycle            | Entry                                          | Runtime       | Trigger                   |
| -------------------- | ---------------------------------------------- | ------------- | ------------------------- |
| **API gateway** (online) | `api/main.py` (FastAPI)                        | milliseconds  | edge relay/status HTTP (`backend` pull removed, ADR-048/062) |
| **Worker** (live ML) | `worker/edge_worker.py` | long-running | RTSP capture, model/domain evaluation, relay facts |
| **Training** (batch) | `training/` (self-contained pose extraction + artifacts) | minutes–hours | manual / scheduled job    |
| **Demo** (dev tool)  | `demo/app.py` (Streamlit)                      | interactive   | developer                 |

`ml-api` exposes unversioned probes `GET /health/live`, `GET /health/ready`, legacy `GET /health`, and versioned routes `GET /api/v1/status`, `GET /api/v1/models`, `POST /api/v1/relay/alerts`, and `POST /api/v1/relay/heartbeat`. Prediction routes, including `POST /predict` and `POST /api/v1/debug/predict/*`, are removed. `ml-api` boots as a thin gateway (config → backend Event API gateway → heartbeat store → readiness); it does not load models, choose devices, assemble camera loops, or run worker runtime (ADR-067). `/api/v1/status` is derived from the relay-heartbeat store; production camera loops and classification run in `ml-worker`. The fall runner loads `ml/models/fall/<model_type>/metadata.json` inside worker-owned runners; model weights are gitignored and must be placed manually (or produced by training). See ADR-015 for the `ml/models/` single-root layout.

Dependency boundaries are package-name based and enforced by `ml/tests/test_import_dependency_ladder.py`: `contracts`/`features` are shared pure foundations; live ML packages live under `worker/{sources,runners,perception,domains}`; `events` owns relay schemas/clients; `api` is an ML-free gateway; `training` imports only `contracts` and `features` from production packages. `ml-worker` owns live orchestration/state (there is no `runtime` package; ADR-067); `ml/core/` and `ml/util/` are removed.

Runs via: `pnpm dev:ml-api` → `uv run --directory ml uvicorn api.main:app --reload --host 127.0.0.1 --port 8000`

---

## End-to-end live data path

```text
[RTSP camera]
     │
     ▼
[ml-worker]
 capture → pose → window → classify → domain fact
     │  POST /api/v1/relay/{alerts,heartbeat} (X-Edge-Relay-Token)
     ▼
[ml-api :8000 on edge]
 validates relay + camera inventory
     │  POST /api/v1/events
     │  POST /api/v1/events/heartbeat
     ▼
[backend :8080]
 camera_id → facility/space ownership → policy → dedup sha256(cameraId|detectedAt|type)
     │
     ├──► [PostgreSQL] immutable Event SSOT + derived Alert
     ├──► [SSE GET /api/v1/dashboard/stream] dashboard push
     └──► [Kakao outbox/delivery]
```

The live path keeps ML edge-local: source decoding, pose inference, window feature extraction, domain evaluation, and heartbeat/alert fact creation happen in `ml-worker`; worker-produced probability is relayed through `ml-api` to the backend Event API as `confidence`. `ml-api` is the only edge process that calls the backend Event API and does not serve predictions. Product policy, facility ownership, persistence, deduplication, SSE, and Kakao side effects happen in the backend.

The Streamlit demo (`ml/demo/app.py`) is a **developer tool**, not the product frontend. It does not make `ml-api` a live prediction service.

---

## ML ↔ Backend responsibility boundary

| Concern | Owner | Rationale |
| --- | --- | --- |
| RTSP capture, pose, windowing, domain fact creation | **ML worker** (`ml/worker/`) | Edge device owns camera loops and raw video stays on-site |
| Relay gateway and backend Event API egress | **ML API** (`ml/api/`, `ml/events/`) | Single backend-facing edge process; worker talks only to local `/api/v1/relay/*` |
| Fall probability score | **ML worker** (`ml/worker/`) | Worker-owned model/domain evaluation emits probability relayed as Event API `confidence` |
| Facility/space ownership resolution | **Backend** | `camera_id` is resolved server-side; client-provided facility is ignored |
| Alert threshold, deduplication, persistence, SSE, Kakao | **Backend** | Product policy, state, credentials, retry logic, and user-facing side effects |
| Model versioning | **ML** (`models/fall/<model_type>/`) | Single-root layout (ADR-015); backend does not own model artifacts |

ML is intentionally edge-local and signal-only: `ml-worker` predicts and emits relay facts through `ml-api`; backend decides product policy, persistence, deduplication, rate limits, tenant ownership, and user-facing side effects. The legacy backend-pull `ML_SERVING_URL` window-predict seam is dormant/removed from live topology by ADR-062/048 and must not be described as the operating path.

---
## 상세 아키텍처 (deep dives)

신규 개발자는 이 overview로 전체 흐름을 잡은 뒤, 아래 deep-dive 문서에서 각 런타임의 책임과 실제 파일 위치를 확인한다.

| 문서 | 읽는 이유 |
| --- | --- |
| [`onboarding/README.md`](onboarding/README.md) | 온보딩 읽기 순서와 문서 컬렉션 역할 |
| [`onboarding/edge-device.md`](onboarding/edge-device.md) | edge device(`ml-api` + `ml-worker`) 구성과 배포/연결 |
| [`onboarding/edge-worker-streaming.md`](onboarding/edge-worker-streaming.md) | `ml-worker` 내부 RTSP→pose→domain fact 스트리밍 절차 |
| [`onboarding/frontend.md`](onboarding/frontend.md) | frontend SSE 수신, 서비스 seam, 컴포넌트 재사용성 |
| [`onboarding/backend.md`](onboarding/backend.md) | backend layered 책임, RLS, Event API→SSE/Kakao 흐름 |

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
| Database engine  | PostgreSQL 17-alpine (Docker)                    | `compose.yaml`                  |
| ORM / migrations | Prisma 6                                         | `backend/prisma/schema.prisma` |
| Dev connection   | `postgresql://fall_app:fall_app@localhost:5432/fall_dev` | `.env.local.example`            |
| Prod connection  | `DATABASE_URL` / `DIRECT_URL` with production roles | `.env.host.prod.example`        |

Start the database:

```bash
pnpm db:up                    # docker compose up -d db
pnpm prisma:migrate           # prisma migrate dev (reads .env.local via dotenv-cli)
pnpm prisma:generate          # regenerate Prisma client after schema changes
```

The Compose stack mounts a named volume (`pgdata`) so data survives container restarts. Default local credentials (`fall`/`fall`) match `.env.local`; production overlays require `.env.host.prod`.

**Compose topology (ADR-062, ADR-063).** The host stack is `db` + `backend` + `front`, all in `compose.yaml` with `backend`/`front` behind the `full` profile, plus `compose.prod.yaml` as the prod overlay. `pnpm db:up` is db-only with `.env.local` (daily dev is native hot reload via `pnpm dev:*`); `pnpm compose:local:up` brings up the whole local host stack with `.env.local`, and `pnpm compose:prod:up` brings up the same full host stack with `.env.host.prod`. There is no `compose.override.yaml` (the container-dev overlay was removed in ADR-063). `front` is a Vite SPA served by `nginx` that reverse-proxies `/api` and `/auth` to `backend:8080` (same-origin). ML is **not** in the host stack — it runs on the external edge device defined by `compose.edge.yaml` and `.env.edge.prod`: `ml-api` publishes `127.0.0.1:${ML_SERVING_PORT:-8000}:8000`, `ml-worker` reaches it over the Compose network at `RELAY_URL=http://ml-api:8000` with `API_EDGE_RELAY_TOKEN`, and `ml-api` pushes no-HMAC events to backend `POST /api/v1/events` through `API_BACKEND_EVENTS_URL` (ADR-029/067). The backend `ML_SERVING_URL` pull seam stays dormant (ADR-048/062). DB backups: `scripts/db-backup.sh` (backup + restore procedure documented in its header).

---

## Lint and type-check

| Tool                  | Scope                                     | Command                              |
| --------------------- | ----------------------------------------- | ------------------------------------ |
| ESLint                | front, backend                            | `pnpm -r lint`                       |
| Prettier              | backend only (front formatting not wired) | `pnpm format`                        |
| `tsc --noEmit`        | front, backend                            | `pnpm typecheck`                     |
| ruff (check + format) | ml                                        | `uv run --directory ml ruff check .` |

Lint philosophy: basics only — ESLint defaults for TS, ruff rule sets E/F/I/UP for Python, Prettier formatting, and TypeScript strict type-check. (`pnpm format` runs Prettier for `backend/` and `ruff format` for `ml/`; `front/` formatting is not yet wired.)

---

## Key ADRs

ADRs are organized by active MECE category under `docs/decisions/{ml,backend,frontend,common}/`. The exhaustive index, coverage matrix, supersession checks, and no-omission audit live in [`docs/decisions/README.md`](decisions/README.md); this section keeps only architecture-level cross-links.

| Concern                                            | Current authority                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Architecture note                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo topology and dependency ownership             | [ADR-001 — Polyglot monorepo / per-ecosystem dependency management](decisions/common/ADR-001-polyglot-monorepo.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Node (pnpm workspace) and Python (uv) are managed independently; root `package.json` is orchestration-only.                                                                                                                                                          |
| Backend persistence                                | [ADR-002 — PostgreSQL everywhere](decisions/backend/ADR-002-postgres-everywhere.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Single DB engine (Postgres via Docker) in all envs; avoids Prisma provider-lock and SQLite↔Postgres migration divergence.                                                                                                                                            |
| ML API/training lifecycle                          | [ADR-022 — ML API and training lifecycle boundary](decisions/ml/ADR-022-ml-serving-training-lifecycle.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Active lifecycle authority extracted from retired source ADR-003.                                                                                                                                                                                                    |
| ML ↔ backend prediction boundary                   | [ADR-023 — ML prediction boundary and backend product-policy ownership](decisions/common/ADR-023-ml-backend-prediction-boundary.md)                                                                                                                                                                                                                                                                                                                                                                                                                                | ML returns signals; backend owns alert policy, persistence, deduplication, rate limits, and side effects.                                                                                                                                                            |
| ML demo vs product frontend boundary               | [ADR-024 — ML demo surface is not the product frontend](decisions/common/ADR-024-ml-demo-product-surface-boundary.md)                                                                                                                                                                                                                                                                                                                                                                                                                                              | `ml/demo/` is an ML observation harness; `front/` is the product UI.                                                                                                                                                                                                 |
| ML data layout and access                          | [ADR-012 — Domain-first two-tier layout for `ml/data/`](decisions/ml/ADR-012-ml-data-domain-first-layout.md), [ADR-028 — Demo access boundary](decisions/common/ADR-028-demo-access-boundary.md) (superseded), and [ADR-045 — Streamlit demo is local-only](decisions/common/ADR-045-streamlit-demo-local-only.md)                                                                                                                                                                                                                                                 | ADR-012 owns domain-first ML data layout. ADR-028's deploy-time demo-access boundary is superseded by ADR-045: the demo is local-only, so the `FALL_DEMO_MODE` public/operator branching is removed. Retired source ADR-004 is mapped in the README coverage matrix. |
| Pose framework                                     | [ADR-025 — YOLO26-pose framework adoption](decisions/ml/ADR-025-yolo26-pose-framework-adoption.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Active framework authority extracted from retired source ADR-005.                                                                                                                                                                                                    |
| Frame, source, and model contracts                 | [ADR-056 — ML frame intake and source-package layout](decisions/ml/ADR-056-ml-frame-intake-and-source-package-layout.md) and [ADR-057 — FrameObservation, runner contracts, and edge-runtime architecture](decisions/ml/ADR-057-frame-observation-runner-contracts-and-edge-runtime-architecture.md) (current authorities), superseding [ADR-050](decisions/ml/ADR-050-frame-model-contract-architecture.md), [ADR-026](decisions/ml/ADR-026-frame-model-seam-architecture.md), and [ADR-006](decisions/ml/ADR-006-frame-source-intake-in-ml-util.md) (historical) | `FrameSource` intake historically moved to `ml/sources/` (ADR-056) and now lives under `ml/worker/sources/`; `FrameObservation`, runner contracts, `ModelRegistry`, and the name-based dependency boundary are defined by ADR-057. ADR-006/026/050 are retained only as historical references.                                |
| Inference output and baselines                     | [ADR-027 — Inference output axis and comparison baseline policy](decisions/ml/ADR-027-inference-output-baseline-policy.md)                                                                                                                                                                                                                                                                                                                                                                                                                                         | Active output-axis, baseline-retention, and fake-adapter rejection authority extracted from retired source ADR-005.                                                                                                                                                  |
| ML local generated/model paths                     | [ADR-015 — `ml/models/` single root](decisions/ml/ADR-015-ml-models-single-root.md) and [ADR-012](decisions/ml/ADR-012-ml-data-domain-first-layout.md)                                                                                                                                                                                                                                                                                                                                                                                                             | Current model and data roots supersede retired source ADR-007.                                                                                                                                                                                                       |
| Issue/worktree enforcement                         | [ADR-008 — Issue-driven worktrees, enforced git-natively](decisions/common/ADR-008-issue-driven-worktree-enforcement.md)                                                                                                                                                                                                                                                                                                                                                                                                                                           | One issue → one branch cut with `git switch -c` inside a persistent lane; the one hard invariant is never working on `main`; guard scripts are the shared enforcement source.                                                                                                                                                                       |
| Fall-classification strategy                       | [ADR-009 — Fall-classification strategy](decisions/ml/ADR-009-fall-classification-strategy.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Classifier is learned temporal models over COCO-17 keypoint sequences; public datasets first.                                                                                                                                                                        |
| Real-time demo mode                                | [ADR-010 — Real-time per-frame live inference demo mode](decisions/ml/ADR-010-realtime-live-inference-demo-mode.md) and [ADR-011 — Live camera intake as second `FrameSource`](decisions/ml/ADR-011-live-camera-intake-and-multipage-demo.md)                                                                                                                                                                                                                                                                                                                      | Recorded clip and camera demo modes share frame-source concepts while keeping pages separate.                                                                                                                                                                        |
| Training and evaluation gates                      | [ADR-013 — Le2i training-pipeline decisions](decisions/ml/ADR-013-le2i-training-pipeline-decisions.md), [ADR-017 — Fall-model adoption criteria](decisions/ml/ADR-017-fall-model-adoption-criteria.md), and [ADR-019 — Nursing-home gold dataset construction methodology](decisions/ml/ADR-019-nh-gold-dataset-construction.md)                                                                                                                                                                                                                                   | Training/evaluation choices remain ML-local; backend/frontend consume accepted model behavior rather than training internals.                                                                                                                                        |
| Fail-fast and enforcement timing                   | [ADR-014 — Fail-fast error policy](decisions/common/ADR-014-fail-fast-error-policy.md) and [ADR-016 — Enforcement timing principle](decisions/common/ADR-016-enforcement-timing-principle.md)                                                                                                                                                                                                                                                                                                                                                                      | Cross-runtime refusal policy and enforcement timing remain strict common decisions.                                                                                                                                                                                  |
| Dataset custody, autoresearch, and demo deployment | [ADR-018 — Cross-machine dataset custody and sync](decisions/ml/ADR-018-cross-machine-dataset-custody.md), [ADR-020 — Autoresearch loop method](decisions/ml/ADR-020-autoresearch-loop-method.md), and [ADR-021 — Demo cloud deployment deferred](decisions/ml/ADR-021-demo-cloud-deployment-deferred.md)                                                                                                                                                                                                                                                          | ML operational decisions stay ML-local unless they impose constraints on product backend/frontend surfaces.                                                                                                                                                          |

> Rationale for each decision lives in the ADR files. The coverage matrix is the authority for MECE placement and preservation checks.

---

## References

### Deep dives

- [`onboarding/README.md`](onboarding/README.md) — 아키텍처 온보딩 인덱스
- [`onboarding/edge-device.md`](onboarding/edge-device.md) — Edge device(`ml-api` + `ml-worker`) 아키텍처
- [`onboarding/edge-worker-streaming.md`](onboarding/edge-worker-streaming.md) — worker 내부 스트리밍 절차
- [`onboarding/frontend.md`](onboarding/frontend.md) — frontend SSE 수신과 컴포넌트 구조
- [`onboarding/backend.md`](onboarding/backend.md) — backend layered 책임과 Event API 흐름

### Hubs

- [`api/`](api/) — wire/API 계약
- [`decisions/`](decisions/) — ADR 허브
- [`domain/`](domain/) — 데이터 모델/도메인 문서

### Referenced ADRs

- [ADR-001 — Polyglot monorepo with per-ecosystem dependency management](decisions/common/ADR-001-polyglot-monorepo.md)
- [ADR-023 — ML prediction boundary and backend product-policy ownership](decisions/common/ADR-023-ml-backend-prediction-boundary.md)
- [ADR-029 — Per-site edge inference with signal-only egress](decisions/ml/ADR-029-edge-inference-deployment-topology.md)
- [ADR-034 — SSE realtime transport — read-only cookie-auth push with alertSeq replay](decisions/backend/ADR-034-sse-realtime-transport.md)
- [ADR-048 — ML/backend window predict contract](decisions/common/ADR-048-ml-backend-window-predict-contract.md)
- [ADR-057 — FrameObservation runner contracts and edge-runtime package architecture](decisions/ml/ADR-057-frame-observation-runner-contracts-and-edge-runtime-architecture.md)
- [ADR-062 — Host/Edge Compose topology — ML on the edge, front+backend+db on one host](decisions/common/ADR-062-host-edge-compose-topology.md)
- [ADR-063 — Native-only dev — drop the container-dev `compose.override.yaml`](decisions/common/ADR-063-native-only-dev-no-compose-override.md)
- [ADR-067 — ML edge API and camera worker service split](decisions/ml/ADR-067-ml-edge-api-worker-service-split.md)
- [ADR-068 — ML edge worker portable video runtime](decisions/ml/ADR-068-ml-edge-worker-portable-video-runtime.md)
