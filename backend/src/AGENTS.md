# Backend src agent rules - NestJS application code

## Overview
`backend/src/**` owns the NestJS runtime: modules, controllers, services,
repositories, DTOs, guards, adapters, and read-side APIs.

## Where to look

| Task | Location | Notes |
| --- | --- | --- |
| Bootstrap composition | `app.module.ts`, `main.ts` | Process wiring and global Nest setup. |
| Event ingestion | `events/` | Versioned Event API intake. |
| Alert policy | `alerts/` | Policy, repositories, ports, email fan-out. Read `alerts/AGENTS.md` first. |
| Media clips | `media/` | Clip ingest/playback/audit. Read `media/AGENTS.md` first. |
| Auth/session | `auth/` | Email/password session auth. Read `auth/AGENTS.md` first. |
| Facility topology | `facilities/`, `floors/`, `spaces/`, `cameras/` | Room-centric placement APIs. |
| Read-side / SSE | `dashboard/` | Dashboard read model and `GET /api/v1/dashboard/stream`. |
| Edge + admin config | `ml-config/`, `users/`, `demo-seed/` | Edge runtime config, user administration, demo fixtures. |
| Shared Nest pieces | `common/`, `config/`, `prisma/` | Filters, domain errors, env validation, PrismaService wrapper. |

## Conventions

- Keep controllers thin: request parsing, guards, response mapping.
- Put business decisions in services and persistence in repositories.
- Repositories must not throw HTTP exceptions or import controllers/services.
- Controllers must not import Prisma, repositories, or concrete adapters.
- Services depend on ports or repositories, not concrete delivery adapters.
- DTO request/response contracts live in domain `dto/*.dto.ts` files.
- `@Body()` types must be exported `*Dto` classes: class-validator-decorated
  DTO classes + global `ValidationPipe`; no manual typeof parsing in
  controllers.
- Schema changes belong under `backend/prisma/`; read `../prisma/AGENTS.md`
  first.
- Runtime env comes from the repo-root `.env.local`; do not create
  `backend/.env*`.

## Anti-patterns

- Do not reintroduce legacy machine-ingest routes; ML ingress is the no-HMAC Event API: `POST /api/v1/events` and `POST /api/v1/events/heartbeat`.
- No inline DTO interfaces/types in controllers or services.
- No controller-to-repository or controller-to-Prisma shortcuts.
- No repository imports from HTTP/Nest controller concerns.
- No app-start Prisma migrations, `db push`, reset, or seed shortcuts.
