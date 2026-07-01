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
  user -->|"HTTPS /api/v1/*<br/>session cookie"| front
  front -->|"reverse proxy /api"| backend
  backend -.->|"SSE /api/v1/dashboard/stream<br/>alert · status frames"| user
  backend -.->|"ML_SERVING_URL pull seam<br/>dormant · ADR"| mlapi
```

> 라이브 ingress는 `ml-api → backend POST /api/v1/events` 하나뿐이다. `ml-worker`는 backend를 직접 호출하지 않고 local `ml-api` relay만 부른다. SSE는 같은 nginx same-origin 프록시를 통해 backend가 브라우저로 push한다.

---

## Directory tree

```
eldercare-fall-ai/                  ← orchestration layer only (no app deps here)
├── package.json                    ← dev:*, build:*, lint, db:*, prisma:* scripts
├── pnpm-workspace.yaml             ← workspace: [front, backend]
├── pnpm-lock.yaml                  ← single lock for all TS packages
├── compose.yaml                    ← host stack: db+backend+front(nginx), gated by `full` profile; +compose.prod.yaml overlay; compose.edge.yaml = ML edge (ADR)
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
│   ├── models/                     ← single model root (ADR; gitignored in entirety)
│   │   ├── pose/                   ← YOLO26-pose weight cache (re-downloadable)
│   │   │   └── yolo26{n,s,m,l,x}-pose.pt
│   │   └── fall/                   ← fall-detection models (trained + third-party)
│   │       ├── random-forest/      ← trained sklearn RF + metadata.json
│   │       ├── lstm/               ← trained PyTorch LSTM + metadata.json
│   │       ├── transformer/        ← trained PyTorch Transformer + metadata.json
│   │       └── pretrained/         ← curated comparison checkpoints (ADR)
│   └── data/                       ← ml/data gitignored as a whole (ADR invariant)
│       ├── {domain}/               ← domain-first layout (ADR): nursing-home/, le2i/, …
│       │   ├── raw/                ← INPUT: source footage (raw is sacred)  ─┐ ADR
│       │   ├── processed/          ← INPUT: lossless processed clips          │ (domain-scoped)
│       │   ├── poses/              ← INPUT: extracted keypoint caches (.npz)  │
│       │   └── annotated/          ← OUTPUT: rendered overlay videos         ─┘
│       ├── uploads/                ← INPUT: demo-uploaded clips (session-scoped; ADR)
│       └── eval/                   ← OUTPUT: cross-domain comparison outputs (ADR)
│
└── docs/
    ├── architecture.md             ← this file
    ├── onboarding/                 ← onboarding deep dives: edge, frontend, backend flows
    ├── decisions/                   ← compact current ADR
    └── rules/                       ← standing conventions (e.g. streamlit-demo.md)
```

---

## Three top-level responsibilities

### 1. `front/` — Product UI

Vite 5 + React 18 + Tailwind CSS v3, React Router for routing. The frontend defaults to real backend mode (`VITE_USE_MOCK` unset or `false`) through the apiClient seam. Login/session/facility onboarding is backend-direct in dev/prod via email/password `POST /api/v1/auth/login`, Kakao OAuth for existing Kakao-linked local accounts, `GET /api/v1/auth/session`, and `POST /api/v1/facilities`. Realtime dashboard updates arrive through backend SSE (`GET /api/v1/dashboard/stream`) with cookie auth and `alertSeq` replay.

**Demo vs runtime (canonical).** The front-only mock runtime (`VITE_USE_MOCK=true` with `realtimeEngine`, `mockData`, and `DemoMode`) is the front-alone "demo" path — it exists only to run the frontend by itself without a backend. dev and prod run on the real backend + real DB (demo content is seeded via `backend/prisma/demo-nokyang.fixture.ts`); there is no mock at runtime in dev/prod. The mock survives only for automated tests. The front-only mock ("demo") is therefore being retired; removing the mock-runtime code is a tracked follow-up.

**Frontend overview.** Three UI modes: staff (`StaffLayout`: `/now` `/rooms` `/alerts`), admin (`AppLayout` sidebar: `/admin/*`), monitor (fullscreen TV: `/monitor`). Service seam: components/pages call `src/services/*`; backend endpoint mappers live in `src/services/api/*`; UI never consumes backend DTOs directly. Key frontend domain entities (`front/src/types/index.ts`, the FE domain SSOT until Phase 2): Facility, Floor, Space, Zone, SpaceStatus, DetectionEvent, ActionLog, Resident, ResidentAssignment, ResidentRiskSummary, ResidentAction, VideoClip, VideoAccessLog, AlertRule, User, MonitorSettings, DemoMode. The frontend domain model is a UI/domain view and currently diverges from the backend DB model; alignment is tracked in a dedicated FE↔BE issue.

Runs via: `pnpm dev:front` → `pnpm --filter front dev`

### 2. `backend/` — Product logic, persistence, alert policy

NestJS 11, `@nestjs/config`, Prisma 6 (PostgreSQL). Listens on `PORT` (local default 8080 from `.env.local`).

`AppModule` wires `ConfigModule` (global, reads root `.env.local` for native/local runs) and `PrismaModule`. The domain model (facility tenant root, auth/session, floor, space, zone, resident, residentAssignment, guardian, camera, alert, residentStatus) is defined in the Prisma schema with facility-scoped row-level security on the `app.facility_id` GUC. Placement/resident CRUD is implemented; space-status and resident-risk read models are guarded 501 skeletons pending the ML read-model, while the alert-rule and detection-event skeleton routes have been removed.

Key responsibilities:

- Own auth/session, facility-scoped RLS (`app.facility_id`), dashboard read models, and admin CRUD.
- Receive edge facts through backend Event API (`POST /api/v1/events` and `POST /api/v1/events/heartbeat`); the former `ML_SERVING_URL` backend-pull seam from ADR was dormant and removed; it is not part of the live path.
- Apply alert policy (threshold, dedup key, rate-limit), persist immutable events and derived alerts, and publish SSE dashboard frames.
- Dispatch Kakao delivery through the outbox/delivery adapter layer.

Runs via: `pnpm dev:backend` → `pnpm backend:db:up` → `pnpm dev:backend:app` → `pnpm --filter backend start:dev`.

### 3. `ml/` — Training pipeline, live worker, and gateway api

Independent uv project. Two distinct lifecycles share one project:

| Lifecycle            | Entry                                          | Runtime       | Trigger                   |
| -------------------- | ---------------------------------------------- | ------------- | ------------------------- |
| **API gateway** (online) | `api/main.py` (FastAPI)                        | milliseconds  | edge relay/status HTTP (`backend` pull removed, ADR) |
| **Worker** (live ML) | `worker/edge_worker.py` | long-running | RTSP capture, model/domain evaluation, relay facts |
| **Training** (batch) | `training/` (self-contained pose extraction + artifacts) | minutes–hours | manual / scheduled job    |
| **Demo** (dev tool)  | `demo/app.py` (Streamlit)                      | interactive   | developer                 |

`ml-api` exposes unversioned probes `GET /health/live`, `GET /health/ready`, legacy `GET /health`, and versioned routes `GET /api/v1/status`, `GET /api/v1/models`, `POST /api/v1/relay/alerts`, and `POST /api/v1/relay/heartbeat`. Prediction routes, including `POST /predict` and `POST /api/v1/debug/predict/*`, are removed. `ml-api` boots as a thin gateway (config → backend Event API gateway → heartbeat store → readiness); it does not load models, choose devices, assemble camera loops, or run worker runtime (ADR). `/api/v1/status` is derived from the relay-heartbeat store; production camera loops and classification run in `ml-worker`. The fall runner loads `ml/models/fall/<model_type>/metadata.json` inside worker-owned runners; model weights are gitignored and must be placed manually (or produced by training). See ADR for the `ml/models/` single-root layout.

Dependency boundaries are package-name based and enforced by `ml/tests/test_import_dependency_ladder.py`: `contracts`/`features` are shared pure foundations; live ML packages live under `worker/{sources,runners,perception,domains}`; `events` owns relay schemas/clients; `api` is an ML-free gateway; `training` imports only `contracts` and `features` from production packages. `ml-worker` owns live orchestration/state (there is no `runtime` package; ADR); `ml/core/` and `ml/util/` are removed.

Runs via: `pnpm dev:ml` → `uv run --directory ml uvicorn api.main:app --reload --host 127.0.0.1 --port 8000`

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
| Model versioning | **ML** (`models/fall/<model_type>/`) | Single-root layout (ADR); backend does not own model artifacts |

ML is intentionally edge-local and signal-only: `ml-worker` predicts and emits relay facts through `ml-api`; backend decides product policy, persistence, deduplication, rate limits, tenant ownership, and user-facing side effects. The legacy backend-pull `ML_SERVING_URL` window-predict seam is dormant/removed from live topology by ADR and must not be described as the operating path.

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
├── front/package.json       ← vite@5, react@18, react-router-dom@6, tailwindcss@3 (ADR)
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

PostgreSQL everywhere. The choice was made because Prisma bakes `provider` into the schema and migration files — unlike Hibernate, it does not support runtime dialect switching. Using SQLite in dev and PostgreSQL in prod would require maintaining two migration histories. See ADR for the full trade-off analysis.

| Layer            | Technology                                       | Config                         |
| ---------------- | ------------------------------------------------ | ------------------------------ |
| Database engine  | PostgreSQL 17-alpine (Docker)                    | `compose.yaml`                  |
| ORM / migrations | Prisma 6                                         | `backend/prisma/schema.prisma` |
| Dev connection   | `postgresql://fall_app:fall_app@localhost:5432/fall_dev` | `.env.local.example`            |
| Prod connection  | `DATABASE_URL` / `DIRECT_URL` with production roles | `.env.host.prod.example`        |

Backend-owned local DB commands:

```bash
pnpm dev:backend:fresh        # start db, reset/apply migrations, generate Prisma Client, seed, then start Nest
pnpm dev:backend              # start db, then start Nest watch mode without reset
pnpm backend:prisma:migrate   # prisma migrate dev (reads .env.local via dotenv-cli)
pnpm backend:prisma:generate  # regenerate Prisma Client after schema changes
```

The Compose stack mounts a named volume (`pgdata`) so data survives container restarts. Default local credentials (`fall`/`fall`) match `.env.local`; production overlays require `.env.host.prod`.

**Compose topology.** The host stack is `db` + `backend` + `front`, all in `compose.yaml` with `backend`/`front` behind the `full` profile, plus `compose.prod.yaml` as the prod overlay. `pnpm backend:db:up` is db-only with `.env.local` and is normally reached through `pnpm dev:backend`; daily dev is native hot reload via `pnpm dev:*`. `pnpm compose:local:up` brings up the whole local host stack with `.env.local`, and `pnpm compose:prod:up` brings up the same full host stack with `.env.host.prod`. There is no `compose.override.yaml`. `front` is a Vite SPA served by `nginx` that reverse-proxies `/api` to `backend:8080` (same-origin); auth routes are `/api/v1/auth/*`. ML is **not** in the host stack — it runs on the external edge device defined by `compose.edge.yaml` and `.env.edge.prod`: `ml-api` publishes `127.0.0.1:${ML_SERVING_PORT:-8000}:8000`, `ml-worker` reaches it over the Compose network at `RELAY_URL=http://ml-api:8000` with `API_EDGE_RELAY_TOKEN`, and `ml-api` pushes no-HMAC events to backend `POST /api/v1/events` through `API_BACKEND_EVENTS_URL`. The backend `ML_SERVING_URL` pull seam stays dormant. DB backups: `scripts/db-backup.sh` (backup + restore procedure documented in its header).

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

## Key decisions

The current decision summary lives in [`docs/decisions/README.md`](decisions/README.md).
Architecture-level consequences are:

| Concern | Current architecture note |
| --- | --- |
| Repo topology | Node packages use pnpm workspaces; ML is an independent `uv` project; root scripts orchestrate only. |
| Runtime topology | Host runs `db` + `backend` + `front`; edge runs `ml-api` + `ml-worker`; daily dev is native hot reload. |
| Backend | NestJS + Prisma + PostgreSQL; backend owns facility tenancy, alert policy, persistence, SSE, and Kakao side effects. |
| ML | ML owns perception, model loading, frame observations, training/evaluation, and edge worker runtime. |
| ML/backend boundary | ML emits signal-only facts through `ml-api`; backend decides product policy and side effects. |
| Frontend | `front/` is Vite + React product UI; it consumes backend APIs/SSE and does not own ML policy. |
| Data and models | `ml/data/` is domain-first and gitignored; `ml/models/` is the single model artifact root. |
| Verification | Real E2E evidence must pass through production code paths; fake harnesses stay unit/contract/smoke only. |

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
- [`decisions/`](decisions/) — ADR
- [`domain/`](domain/) — 데이터 모델/도메인 문서
