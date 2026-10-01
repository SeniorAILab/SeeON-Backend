<p align="center">
  <img src="./docs/readme-hero.webp" alt="Abstract 3D artwork of connected service layers." width="100%" />
</p>

<p align="center"><sub>SENIOR AI LAB · SEEON</sub></p>

<h1 align="center">SeeON Backend</h1>

<p align="center">
  <strong>The API behind SeeON’s care-monitoring dashboard.</strong><br />
  NestJS · PostgreSQL · nginx · Jenkins
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#deployment">Deployment</a>
</p>

Backend services for the SeeON eldercare fall-detection platform. This repository owns the API, database integration, API ingress, and backend deployment tooling.

The [web dashboard](https://github.com/SeniorAILab/SeeON-Front) consumes the API as an external client over CORS (`FRONT_ORIGINS`). Frontend builds and ML edge operations live in separate repositories.

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
This repository was extracted from `SeniorAILab/SeeON`. The [provenance guide](./docs/provenance/README.md) records the commit map and extraction details.

## Commands

| Script | What it does |
|---|---|
| `pnpm dev:backend` | Verify local env, start PostgreSQL, run Prisma setup, then start NestJS watch mode |
| `pnpm dev:backend:fresh` | **Resets the guarded local DB**, seeds demo data, then starts NestJS |
| `pnpm dev:backend:app` | NestJS dev server only |
| `pnpm lint` | ESLint for `backend/` |
| `pnpm format` | Prettier for `backend/` |
| `pnpm typecheck` | TypeScript checks for `backend/` |
| `pnpm env:verify` | Verify Compose, env, and deploy contracts |
| `pnpm compose:local:up` | Full local stack (db, backend, api-ingress) |
| `pnpm compose:prod:up` | Production stack with `.env.host.prod` image pins |
| `pnpm release:prod -- vX.Y.Z` | Publish a production release and start deployment |


## Verification

Run checks from the repository root. Database-backed tests need the local PostgreSQL environment (`DATABASE_URL` and `DIRECT_URL`).

```bash
pnpm typecheck
pnpm lint
pnpm --filter backend test
pnpm --filter backend run dto:check
pnpm env:verify
```

See [AGENTS.md](./AGENTS.md) for the schema, migration, repository-boundary, and deployment gates required for each change.

## Deployment

`pnpm release:prod -- vX.Y.Z` publishes a qualifying production release from `main` and signals Jenkins. Jenkins resolves the release to a commit SHA, builds the backend images, and handles deployment to the iwinv host. A release signal alone is not evidence that deployment completed; the pipeline can also no-op when the SHA is already live.

Keep real `.env.local` and `.env.host.prod` files out of git. Do not create package-local environment files or commit secrets.

## Documentation

- [Architecture](./docs/architecture.md): service boundaries
- [Extraction provenance](./docs/provenance/README.md): origin and commit map
- [Contributor guidance](./AGENTS.md): commands, guards, and scoped rules
- [SeeON Front](https://github.com/SeniorAILab/SeeON-Front): the dashboard client

The hero is conceptual artwork, not a deployment or product-readiness result.
