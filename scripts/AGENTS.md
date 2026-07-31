# Scripts agent rules - repo guards, env checks, releases

## Overview
`scripts/**` owns repository automation outside application runtimes: git
workflow guards, backend contract guards, env contract checks, release helpers,
and production deploy scripts.

## Structure
```text
scripts/
├── backend-guard/  # backend schema/migration coupling and schema convention checks
├── db/             # local DB reset / Prisma orchestration helpers
├── dev/            # native local dev command orchestration and env guards
├── deploy/         # iwinv host bootstrap and VM-side deploy execution
├── env/            # compose/env example contract verification
├── git-guard/      # worktree, freshness, lint/type, migration, asset guards
├── release/        # production release creation
└── repo-residue-check.mjs  # host/ML residue gate (CI job `repo-residue`)
```

## Where to look
| Task | Location | Notes |
| --- | --- | --- |
| Protected-branch guard | `git-guard/assert-not-main.sh` | Refuses commit/push on `main` (the one hard invariant). |
| Local dev orchestration | `dev/`, `db/` | Guarded local env checks, DB reset, and native dev command sequencing. |
| Local lint gate | `git-guard/check-lint.sh` | Mirrors changed-package lint/type checks; runs backend tests when the local DB is up. |
| Migration order guard | `git-guard/check-migrations.sh` | Rejects out-of-order/misnamed Prisma migrations (pre-push + CI); `--fix` renumbers. |
| Freshness guard | `git-guard/check-freshness.sh` | Protects stale protected-branch work. |
| Migration guard | `backend-guard/check-schema-migration.sh` | Blocks schema changes without migration SQL, append-only tables not named `*_history`, and undocumented nullable `*Id` fields. |
| DTO guard | `backend/eslint.dto.config.mjs` (via `pnpm --filter backend run dto:check`) | Hard gate for backend DTO names and body types. |
| Env contract | `env/verify-compose-env-contract.mjs` | Checks compose env usage against examples. |
| Event-clip contracts | `env/verify-event-clip-compose.mjs`, `deploy/validate-event-clip-env.sh` | Reject unsafe clip defaults, retention, capacity, and file permissions. |
| ML residue gate | `repo-residue-check.mjs` | Blocks `ml/`, `compose.edge.yaml`, and ML image/CD logic in this host repo. |
| Local DB safety | `dev/assert-local-db-env.mjs`, `dev/local-env.mjs` | Refuse production/remote DB targets and non-`fall_dev` databases. |
| Asset guard | `git-guard/deny-assets.sh` | Blocks model weights, media files, and blobs over 5 MB. |
| Release | `release/create-production-release.mjs` | Publishing a production release starts deployment. |
| VM deploy | `deploy/` | See `deploy/AGENTS.md` before editing. |

## Conventions
- Keep guard logic single-source. Do not reimplement backend guard behavior in
  GitHub Actions, package scripts, or agent hooks.
- POSIX shell guards should run noninteractively and fail with clear stderr.
- Backend guard scripts may reuse `scripts/git-guard/lib.sh`; keep shared shell
  helpers there rather than copying functions.
- `backend-guard/check-schema-migration.sh` is a blocking schema/migration
  contract. It runs from pre-commit and CI.
- `backend/eslint.dto.config.mjs` (run as `dto:check`) is the hard DTO contract
  gate. The main backend ESLint config is also blocking in local guards and CI.
- Production release issuance is the deployment trigger. Release and deploy
  scripts must use explicit refs or image tags.
- Production DB deploy runs `prisma migrate deploy` through `scripts/deploy/iwinv-deploy.sh`; there is no `DEPLOY_DB_MODE`, `baseline-existing`, or `reset-demo` mode.
- Before migration, `iwinv-deploy.sh` backs up with `pg_dump -Fc` and validates the dump with `pg_restore --list`. Restore with `iwinv-deploy.sh --restore-db <dump> --ack-data-loss`.
- Env verification reads tracked example contracts. Real `.env*` files remain
  gitignored and must not be generated here.

## Anti-patterns
- No `rm -rf` worktree cleanup helper. Use the repo worktree removal flow.
- No fallback `latest`, fallback branch, or inferred production image tag.
- No server-side app image builds in deploy scripts. VM deploy pulls already
  built local Jenkins images.
- No default production schema reset, seed, raw migration replay, `db push`, or
  app-start migration.
- No automatic retry, rollback, or alternate deploy path that hides the first
  failure.
- No secret printing while handling env files, registry credentials, SSH, or
  release tokens.
- No hook that blocks reversible convention work before commit; follow ADR.
