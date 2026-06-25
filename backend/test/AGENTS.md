# Backend test agent rules - Jest integration and e2e tests

## Overview
`backend/test/**` owns backend integration/e2e tests that are not colocated
with a single source module.

## Where to look

| Task | Location | Notes |
| --- | --- | --- |
| HTTP e2e | `*-e2e.spec.ts` | Supertest/Nest app scenarios. |
| Cross-module behavior | `*.spec.ts` | Tests spanning multiple backend domains. |
| Unit specs | `../src/**/*.spec.ts` | Prefer colocated tests for one module/class. |
| DB contract | `../prisma/AGENTS.md` | Read before adding migration/schema tests. |

## Conventions

- Use `pnpm --filter backend test` for the normal Jest suite.
- Keep one-module unit tests colocated under `src/**`; use `test/**` for
  integration, e2e, and cross-module behavior.
- Build a real Nest app only when the behavior crosses module or transport
  boundaries.
- Keep DB setup explicit and deterministic. Tests must not depend on a
  developer's untracked local state.
- Prefer clear HTTP assertions over snapshot-style broad response matching.
- When a test exercises tenant or session behavior, assert both allowed and
  denied paths.

## Anti-patterns

- No weakening guards, auth, HMAC, or RLS assumptions to make e2e setup easier.
- No hidden dependency on production `.env*` files.
- No broad sleeps for async behavior; wait on observable state or explicit
  promises.
- No deleting or weakening failing tests to create a green suite.
