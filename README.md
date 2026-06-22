# eldercare-fall-ai

An eldercare fall-detection platform built as a proof-of-concept (PoC) monorepo. The system pairs a **Vite + React** frontend and **NestJS** backend (TypeScript, managed by pnpm workspaces) with an independent Python **FastAPI** serving layer (managed by uv) that classifies video frames and returns fall-probability predictions. Product-level decisions — alert policy, deduplication, and Kakao webhook dispatch — belong exclusively to the backend; the ML layer returns predictions only. The repo is at PoC stage: front and backend are runnable skeletons with realtime transport and full feature implementation deliberately deferred.

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

# 3. Copy environment templates
#    Root .env feeds Docker Compose ${VAR} interpolation; backend/.env.development
#    is what the native NestJS dev server reads (PORT, DATABASE_URL/DIRECT_URL, auth).
cp .env.example .env
cp backend/.env.example backend/.env.development

# 4. Start PostgreSQL via Docker
pnpm db:up

# 5. Generate Prisma client
pnpm prisma:generate

# 6. Start app services in separate terminals
pnpm dev:backend  # http://localhost:8080
pnpm dev:ml       # http://localhost:8000
pnpm dev:front    # http://localhost:3000

# 7. Register git hooks + git wt alias (run once per clone)
bash scripts/git-guard/setup-hooks.sh
```

> Real `.env.*` files (`.env`, `.env.development`, `.env.production`) are gitignored. Never commit secrets.

## Standard ports

| Service | Local URL | Container/service port |
|---|---|---:|
| `front` | `http://localhost:3000` | `3000` |
| `backend` | `http://localhost:8080` | `8080` |
| `ml-serving` | `http://localhost:8000` | `8000` |
| `db` | `localhost:5432` | `5432` |

Browser-facing URLs must use `localhost` because the browser runs on the host. Compose service names are only for container/server-internal traffic: for example, backend uses `http://ml-serving:8000` inside Compose, and a future server-side frontend backend call may use `http://backend:8080`. Do not put service-name URLs in `VITE_*` variables.

For container parity and production-shaped runs:

```bash
pnpm compose:full      # full host stack (db+backend+front[nginx], runner) via --profile full
pnpm compose:prod:up   # compose.yaml + compose.prod.yaml, runner targets
```

On macOS, prefer the native `pnpm dev:*` loop for daily frontend/backend/ML work. The container host stack (`pnpm compose:full`) builds runner images for parity/deploy shaping, not hot-reload dev — there is no `compose.override.yaml` container-dev overlay (ADR-063).

## Commands

| Script | What it does |
|--------|-------------|
| `pnpm dev:front` | Vite dev server (`front/`) on `:3000` |
| `pnpm dev:backend` | NestJS dev server in watch mode (`backend/`) |
| `pnpm dev:ml` | FastAPI serving on `:8000` via uvicorn (`ml/serving/`) |
| `pnpm dev:demo` | Streamlit demo UI (`ml/demo/`) |
| `pnpm lint` | ESLint across TS packages + ruff check for `ml/` |
| `pnpm format` | Prettier for `backend/` + ruff format for `ml/` |
| `pnpm typecheck` | `tsc --noEmit` for `front/` and `backend/` |
| `pnpm db:up` | `docker compose up -d db` — start PostgreSQL |
| `pnpm db:down` | `docker compose down` — stop all Compose services |
| `pnpm compose:full` | Full host stack (db+backend+front[nginx], `--profile full`) |
| `pnpm compose:prod:up` | Production-shaped Compose stack (`compose.yaml` + `compose.prod.yaml`) |
| `pnpm prisma:generate` | Regenerate Prisma client from `schema.prisma` |
| `pnpm prisma:migrate` | Run Prisma migrations (`migrate dev`) |

## Architecture

```
eldercare-fall-ai/
├── front/          # Vite + React + TypeScript (frontend SSOT)
├── backend/        # NestJS + TypeScript + Prisma → PostgreSQL
├── ml/             # 9-package layered edge runtime (ADR-056/057); see ml/README.md
│   ├── contracts/  # L0 pure contracts (frame/observation/model/artifacts/event)
│   ├── features/   # L0 pure feature math
│   ├── sources/    # L1 FrameSource intake (video/webcam/rtsp)
│   ├── runners/    # L1 model runners + ModelRegistry
│   ├── perception/ # L2 observation assembly
│   ├── domains/    # L3 domain interpreters (fall, bed_exit)
│   ├── runtime/    # L3 edge orchestration (camera manager/worker)
│   ├── events/     # L4 alert signing/outbox/publisher (→ POST /ingest/alerts)
│   ├── serving/    # FastAPI: /health, /debug/predict/window
│   ├── demo/       # Streamlit demo UI (fall classification via serving)
│   ├── training/   # Batch training pipeline
│   ├── data/       # Video dataset — domain-first layout (gitignored; ADR-012)
│   └── models/     # Model single root (gitignored; ADR-015)
├── docs/
│   ├── architecture.md   # System diagram and component boundaries
│   └── decisions/        # Architecture Decision Records (ADRs)
└── compose*.yaml    # Compose base/dev override/prod overlay
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
