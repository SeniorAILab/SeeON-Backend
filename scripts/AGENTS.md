# Scripts agent rules - repo guards, env checks, releases

## Overview
`scripts/**` owns repository automation outside application runtimes: git
workflow guards, backend contract guards, env contract checks, release helpers,
and production deploy scripts.

## Structure

```text
scripts/
├── backend-guard/  # backend schema/migration and DTO contract checks
├── deploy/         # Naver Cloud VM bootstrap and VM-side deploy execution
├── env/            # compose/env example contract verification
├── git-guard/      # worktree, freshness, lint/type, migration, asset guards
└── release/        # release creation and manual production deploy helpers
```

## Where to look

| Task | Location | Notes |
| --- | --- | --- |
| Protected-branch guard | `git-guard/assert-not-main.sh` | Refuses commit/push on `main` (the one hard invariant). |
| Local lint gate | `git-guard/check-lint.sh` | Mirrors changed-package lint/type checks. |
| Freshness guard | `git-guard/check-freshness.sh` | Protects stale protected-branch work. |
| Migration guard | `backend-guard/check-schema-migration.sh` | Blocks schema changes without migration SQL. |
| DTO guard | `backend-guard/check-dto-contracts.mjs` | Hard gate for backend DTO names and body types. |
| Env contract | `env/verify-compose-env-contract.mjs` | Checks compose env usage against examples. |
| Release | `release/create-production-release.mjs` | Creates production release tags; deploy separately while Actions-backed CD is paused. |
| Manual deploy | `release/manual-production-deploy.mjs` | Current local GHCR build/push/upload production deploy path. |
| VM deploy | `deploy/` | See `deploy/AGENTS.md` before editing. |

## Conventions

- Keep guard logic single-source. Do not reimplement backend guard behavior in
  GitHub Actions, package scripts, or agent hooks.
- POSIX shell guards should run noninteractively and fail with clear stderr.
- Backend guard scripts may reuse `scripts/git-guard/lib.sh`; keep shared shell
  helpers there rather than copying functions.
- `backend-guard/check-schema-migration.sh` is a blocking schema/migration
  contract. It runs from pre-commit and CI.
- `backend-guard/check-dto-contracts.mjs` is the hard DTO contract gate. ESLint
  layering checks remain warn-first.
- Release and deploy scripts must use explicit refs or image tags. Production
  deploy currently uses local manual build/push; GitHub workflow deploys are
  explicit `workflow_dispatch` only until Actions-backed CD is re-enabled.
- Production DB deploy defaults to `DEPLOY_DB_MODE=migrate`: backup with
  `pg_dump -Fc`, validate with `pg_restore --list`, then run
  `prisma migrate deploy` from deploy tooling. `baseline-existing` and
  `reset-demo` require explicit allow flags.
- Env verification reads tracked example contracts. Real `.env*` files remain
  gitignored and must not be generated here.

## Anti-patterns

- No `rm -rf` worktree cleanup helper. Use the repo worktree removal flow.
- No fallback `latest`, fallback branch, or inferred production image tag.
- No server-side app image builds in deploy scripts. VM deploy pulls already
  built GHCR images.
- No default production schema reset, seed, raw migration replay, `db push`, or
  app-start migration.
- No automatic retry, rollback, or alternate deploy path that hides the first
  failure.
- No secret printing while handling env files, registry credentials, SSH, or
  release tokens.
- No hook that blocks reversible convention work before commit; follow ADR.
