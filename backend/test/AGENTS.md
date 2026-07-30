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
| Real-Postgres harnesses | `helpers/event-media-harness.ts`, `helpers/alert-media-fixture.ts` | Dual-role (`DATABASE_URL` app + `DIRECT_URL` privileged) seeding, JWT cookies, temp media root, deterministic teardown. Reuse instead of hand-rolling setup. |

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
- Fixture ids/emails/names that appear in more than one place in a file (seed,
  cleanup, route string, assertion) must derive from a single named builder or
  constant (see `alert-notes.spec.ts`), never from hand-synced duplicate string
  literals — no inline `/api/v1/alerts/<raw-id>` route strings. Exception:
  duplication that is itself the tested behavior (e.g. reusing an idempotency
  key to assert a conflict). Pre-existing files migrate opportunistically when
  touched.

## Anti-patterns

- No weakening guards, auth, Event API, or RLS assumptions to make e2e setup easier; the ML Event API itself is no-HMAC by design.
- No hidden dependency on production `.env*` files.
- No broad sleeps for async behavior; wait on observable state or explicit
  promises.
- No deleting or weakening failing tests to create a green suite.
