# eldercare-fall-ai

An eldercare fall-detection platform built as a proof-of-concept (PoC) monorepo. The system pairs a **Next.js** frontend and **NestJS** backend (TypeScript, managed by pnpm workspaces) with an independent Python **FastAPI** serving layer (managed by uv) that classifies video frames and returns fall-probability predictions. Product-level decisions — alert policy, deduplication, and Kakao webhook dispatch — belong exclusively to the backend; the ML layer returns predictions only. The repo is at PoC stage: front and backend are runnable skeletons with realtime transport and full feature implementation deliberately deferred.

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 24 |
| pnpm | 10.32.1 |
| uv | any recent version |
| Docker | any recent version (for PostgreSQL) |

## Quick Start

```bash
# 1. Install JS dependencies (front + backend workspace)
pnpm install

# 2. Install Python dependencies (ml)
cd ml && uv sync

# 3. Copy environment template
cp backend/.env.example backend/.env.development

# 4. Start PostgreSQL via Docker
pnpm db:up

# 5. Generate Prisma client
pnpm prisma:generate

# 6. Register git hooks + git wt alias (run once per clone)
bash scripts/git-guard/setup-hooks.sh
```

> Real `.env.*` files (`.env.development`, `.env.production`) are gitignored. Never commit secrets.

## Commands

| Script | What it does |
|--------|-------------|
| `pnpm dev:front` | Next.js dev server (`front/`) |
| `pnpm dev:backend` | NestJS dev server in watch mode (`backend/`) |
| `pnpm dev:ml` | FastAPI serving on `:8000` via uvicorn (`ml/serving/`) |
| `pnpm dev:demo` | Streamlit demo UI (`ml/demo/`) |
| `pnpm lint` | ESLint across TS packages + ruff check for `ml/` |
| `pnpm format` | Prettier for `backend/` + ruff format for `ml/` |
| `pnpm typecheck` | `tsc --noEmit` for `front/` and `backend/` |
| `pnpm db:up` | `docker compose up -d db` — start PostgreSQL |
| `pnpm db:down` | `docker compose down` — stop all Compose services |
| `pnpm prisma:generate` | Regenerate Prisma client from `schema.prisma` |
| `pnpm prisma:migrate` | Run Prisma migrations (`migrate dev`) |

## Architecture

```
eldercare-fall-ai/
├── front/          # Next.js + TypeScript  (PoC skeleton)
├── backend/        # NestJS + TypeScript + Prisma → PostgreSQL
├── ml/
│   ├── serving/    # FastAPI: /health, /predict
│   ├── training/   # Batch training pipeline (deferred)
│   ├── demo/       # Streamlit demo UI
│   ├── artifacts/  # Versioned model weights: <model>/<version>/
│   └── data/       # Video dataset — domain-first layout (gitignored; ADR-012)
├── docs/
│   ├── architecture.md   # System diagram and component boundaries
│   └── decisions/        # Architecture Decision Records (ADRs)
└── docker-compose.yml    # PostgreSQL service definition
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
