# SeeON-Backend

Backend services for the SeeON eldercare fall-detection platform: a
NestJS/PostgreSQL API plus an nginx API ingress, deployed to the iwinv host
by Jenkins.

The web dashboard is a separate repository, `SeniorAILab/SeeON-Front`, which
consumes this API as an external client over CORS (`FRONT_ORIGINS`). No
frontend package, build, image, or service exists here. ML runtime and edge
operations are also separate.

This repository was extracted from `SeniorAILab/SeeON`; see
[`docs/provenance/README.md`](docs/provenance/README.md) for the commit map
and extraction details.

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
bash scripts/git-guard/setup-hooks.sh
```

Real `.env.local` and `.env.host.prod` files are gitignored. Never commit
secrets or create package-local env files.

## Commands

| Script | What it does |
|---|---|
| `pnpm dev:backend` | Verify local env, start PostgreSQL, run Prisma setup, then start NestJS watch mode |
| `pnpm dev:backend:fresh` | Guard-reset the local DB, seed demo data, then start NestJS |
| `pnpm dev:backend:app` | NestJS dev server only |
| `pnpm lint` | ESLint for `backend/` |
| `pnpm format` | Prettier for `backend/` |
| `pnpm typecheck` | TypeScript checks for `backend/` |
| `pnpm env:verify` | Verify Compose, env, and deploy contracts |
| `pnpm compose:local:up` | Full local stack (db, backend, api-ingress) |
| `pnpm compose:prod:up` | Production stack with `.env.host.prod` image pins |
| `pnpm release:prod -- vX.Y.Z` | Publish a production release and start deployment |

A production deployment begins when `pnpm release:prod -- vX.Y.Z` publishes a
strict semantic-version release from `main`; Jenkins resolves that release and
deploys the corresponding commit SHA images.

## Architecture

```text
SeeON-Backend/
├── backend/        # NestJS + TypeScript + Prisma → PostgreSQL
├── infra/          # API ingress (nginx) image and config
├── docs/           # Documentation, decisions, provenance
├── scripts/        # Guards, env checks, release and deploy automation
└── compose*.yaml   # Compose (local / prod)
```

See [`docs/architecture.md`](docs/architecture.md) for architecture notes.
The dashboard client lives in `SeniorAILab/SeeON-Front`.
