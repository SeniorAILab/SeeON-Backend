# eldercare-fall-ai

An eldercare fall-detection platform built as a proof-of-concept (PoC) monorepo. The system pairs a **Vite + React** frontend and **NestJS** backend (TypeScript, managed by pnpm workspaces) with an independent Python ML edge runtime (managed by uv). Production live path is `RTSP -> ml-worker -> ml-api -> backend /ingest/*` (ADR-067/029): the worker owns camera capture, model/domain evaluation, heartbeats, and alert facts. `ml-api` is a private/local FastAPI health, status, models, debug, and control surface plus the single backend ingest gateway; live camera ownership and raw frame relay stay outside that API service. Product-level decisions - alert policy, deduplication, and Kakao webhook dispatch - belong exclusively to the backend.

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 24 |
| pnpm | 10.32.1 |
| uv | any recent version |
| Docker | any recent version (for PostgreSQL) |

## Quick Start

Native hot reload is the default daily development loop. Compose runs PostgreSQL by default; app containers are for parity/prod checks.

```bash
# 1. Install JS dependencies (front + backend workspace)
pnpm install

# 2. Install Python dependencies (ml)
cd ml && uv sync && cd ..

# 3. Copy the single local environment file
#    .env.local feeds native backend, Vite frontend, Prisma, and local Compose.
cp .env.local.example .env.local

# 4. Start PostgreSQL via Docker
pnpm db:up

# 5. Generate Prisma client
pnpm prisma:generate

# 6. Start app services in separate terminals
pnpm dev:backend  # http://localhost:8080
pnpm dev:ml-api       # ml-api / FastAPI private-local surface on http://localhost:8000
pnpm dev:ml-worker --config config/ml-worker.local.yaml
pnpm dev:front    # http://localhost:3000

# 7. Register git hooks + git wt alias (run once per clone)
bash scripts/git-guard/setup-hooks.sh
```

> Real `.env.local`, `.env.host.prod`, and `.env.edge.prod` files are gitignored.
> Never commit secrets. Do not create package-local env files under `backend/`,
> `front/`, or `ml/`.

## Standard ports

| Service | Local URL | Container/service port |
|---|---|---:|
| `front` | `http://localhost:3000` | `3000` |
| `backend` | `http://localhost:8080` | `8080` |
| `ml-api` | `http://localhost:8000` | `8000` |
| `db` | `localhost:5432` | `5432` |

Browser-facing URLs must use `localhost` because the browser runs on the host. Compose service names are only for container/server-internal traffic: for example, a future server-side frontend backend call may use `http://backend:8080`. Do not put service-name URLs in `VITE_*` variables. Edge workers relay production ingest facts to `ml-api`, which reaches backend `/ingest/*`; RTSP/video transport stays inside the worker.

For container parity and production-shaped runs:

```bash
pnpm compose:local:up  # full local host stack via .env.local + --profile full
pnpm compose:prod:up   # full prod host stack via .env.host.prod image pins
```

Edge Compose is separate from the host stack and runs the two ML edge services:

```bash
EDGE_CAMERA_CONFIG=./ml/config/ml-worker.local.yaml \
  docker compose -f compose.edge.yaml up -d --build
```

`EDGE_CAMERA_CONFIG` points to a gitignored per-camera YAML file with RTSP URLs,
relay URL/token, camera identity, and the LSTM fall-model artifact contract.
Backend `/ingest/*` endpoints, key IDs, and signing secrets live in `ml-api`
per ADR-067/029.

On macOS, prefer the native `pnpm dev:*` loop for daily frontend/backend/ML work. The container host stack (`pnpm compose:local:up`) builds runner images for parity/deploy shaping, not hot-reload dev - there is no `compose.override.yaml` container-dev overlay (ADR-063).

## Commands

| Script | What it does |
|--------|-------------|
| `pnpm dev:front` | Vite dev server (`front/`) on `:3000` |
| `pnpm dev:backend` | NestJS dev server in watch mode (`backend/`) |
| `pnpm dev:ml-api` | `ml-api` FastAPI private/local surface on `:8000` via uvicorn (`ml/api/`) |
| `pnpm dev:ml-worker` | `ml-worker` RTSP worker; pass `--config config/ml-worker.local.yaml` because the script runs inside `ml/` |
| `pnpm dev:demo` | Streamlit demo UI (`ml/demo/`) |
| `pnpm lint` | ESLint across TS packages + ruff check for `ml/` |
| `pnpm format` | Prettier for `backend/` + ruff format for `ml/` |
| `pnpm typecheck` | `tsc --noEmit` for `front/` and `backend/` |
| `pnpm db:up` | `docker compose up -d db` — start PostgreSQL |
| `pnpm db:down` | `docker compose down` — stop all Compose services |
| `pnpm compose:local:up` | Full local host stack (db+backend+front[nginx], `.env.local`, `--profile full`) |
| `pnpm compose:prod:up` | Production full host stack (`compose.yaml` + `compose.prod.yaml`, `.env.host.prod` image pins) |
| `pnpm release:prod -- vX.Y.Z` | Create the non-prerelease GitHub Release that triggers production deploy |
| `pnpm prisma:generate` | Regenerate Prisma client from `schema.prisma` |
| `pnpm prisma:migrate` | Run Prisma migrations (`migrate dev`) |

## Architecture

```
eldercare-fall-ai/
├── front/          # Vite + React + TypeScript (frontend SSOT)
├── backend/        # NestJS + TypeScript + Prisma → PostgreSQL
├── ml/             # 9-package layered edge runtime (ADR-056/057/067/068); see ml/README.md
│   ├── contracts/  # L0 pure contracts (frame/observation/model/artifacts/event)
│   ├── features/   # L0 pure feature math
│   ├── sources/    # L1 FrameSource intake (video/webcam/rtsp; OpenCV current backend)
│   ├── runners/    # L1 model runners + ModelRegistry
│   ├── perception/ # L2 observation assembly
│   ├── domains/    # L3 domain interpreters (fall, bed_exit)
│   ├── worker/     # ml-worker process + worker-owned live orchestration/state
│   ├── events/     # L4 alert signing/outbox/publisher (-> POST /ingest/alerts)
│   ├── api/        # ml-api FastAPI: /health, /status, /models, /debug/*
│   ├── demo/       # Streamlit demo UI (fall classification via api)
│   ├── training/   # Batch training pipeline
│   ├── data/       # Video dataset — domain-first layout (gitignored; ADR-012)
│   └── models/     # Model single root (gitignored; ADR-015)
├── docs/
│   ├── architecture.md   # System diagram and component boundaries
│   └── decisions/        # Architecture Decision Records (ADRs)
└── compose*.yaml    # host Compose plus compose.edge.yaml for ML edge services
```

See [`docs/architecture.md`](docs/architecture.md) for the full system diagram and component boundaries, and [`docs/decisions/`](docs/decisions/) for ADRs covering key decisions such as the database strategy (PostgreSQL everywhere via Docker Compose) and the ML/product boundary.

**Dependency locks are per-ecosystem.** `pnpm-lock.yaml` covers `front/` and `backend/`; `ml/uv.lock` covers the Python project. The root `package.json` is an orchestration layer only — it holds no application dependencies.

## MCP: NotebookLM

This repo ships a project-scoped NotebookLM MCP server in `.mcp.json` so the team can use it.

Each teammate needs the `notebooklm-mcp` CLI installed and on `PATH`:

```bash
# install the notebooklm-mcp / nlm CLI (e.g. into ~/.local/bin)
nlm login   # authenticate with your Google account
```

Then open the repo in Claude Code and approve the `notebooklm-mcp` server when prompted.
