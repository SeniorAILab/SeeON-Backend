# eldercare-fall-ai

Host services for the eldercare fall-detection platform: a Vite + React frontend
and NestJS/PostgreSQL backend.

ML runtime and edge operations are separated → `SeniorAILab/eldercare-fall-ml`.

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 24 |
| pnpm | 10.32.1 |
| Docker | any recent version (for PostgreSQL) |

## Quick Start

```bash
pnpm install
cp .env.local.example .env.local
pnpm dev:backend
pnpm dev:front
bash scripts/git-guard/setup-hooks.sh
```

Real `.env.local` and `.env.host.prod` files are gitignored. Never commit
secrets or create package-local env files.

## Commands

| Script | What it does |
|---|---|
| `pnpm dev:front` | Vite dev server (`front/`) on `:3000` |
| `pnpm dev:backend` | Verify local env, start PostgreSQL, run Prisma setup, then start NestJS watch mode |
| `pnpm dev:backend:fresh` | Guard-reset the local DB, seed demo data, then start NestJS |
| `pnpm dev:backend:app` | NestJS dev server only |
| `pnpm lint` | ESLint across TypeScript packages |
| `pnpm format` | Prettier for `backend/` |
| `pnpm typecheck` | TypeScript checks for `front/` and `backend/` |
| `pnpm env:verify` | Verify host Compose and environment contracts |
| `pnpm compose:local:up` | Full local host stack (db, backend, front) |
| `pnpm compose:prod:up` | Production host stack with `.env.host.prod` image pins |
| `pnpm release:prod -- vX.Y.Z` | Publish a production release and start deployment |

A production deployment begins when `pnpm release:prod -- vX.Y.Z` publishes a
strict semantic-version release from `main`; Jenkins resolves that release and
deploys the corresponding commit SHA images.
## Architecture

```text
eldercare-fall-ai/
├── front/          # Vite + React + TypeScript
├── backend/        # NestJS + TypeScript + Prisma → PostgreSQL
├── docs/           # Host documentation and decisions
└── compose*.yaml   # Host Compose
```

See [`docs/architecture.md`](docs/architecture.md) for host component
boundaries. ML runtime and edge documentation live in
`SeniorAILab/eldercare-fall-ml`.

## MCP: NotebookLM

This repo ships a project-scoped NotebookLM MCP server in `.mcp.json` so the team can use it.

Each teammate needs the `notebooklm-mcp` CLI installed and on `PATH`:

```bash
# install the notebooklm-mcp / nlm CLI (e.g. into ~/.local/bin)
nlm login   # authenticate with your Google account
```

Then open the repo in Claude Code and approve the `notebooklm-mcp` server when prompted.
