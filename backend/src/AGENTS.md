# Backend src agent rules - NestJS application code

## Overview
`backend/src/**` owns the NestJS runtime: modules, controllers, services,
repositories, DTOs, guards, adapters, and read-side APIs.

## Where to look

| Task | Location | Notes |
| --- | --- | --- |
| Bootstrap composition | `app.module.ts`, `main.ts` | Process wiring and global Nest setup. |
| Event ingestion | `events/` | Versioned Event API intake. |
| Alert policy | `alerts/` | Policy, repositories, ports, Kakao fan-out. |
| Auth/session | `auth/`, `guardians/` | Email/password, Kakao, guardian domain. |
| Facility topology | `facilities/`, `floors/`, `spaces/`, `zones/`, `cameras/` | Room-centric placement APIs. |
| Resident domain | `residents/`, `resident-assignments/`, `resident-risk-summaries/` | Resident read/write surfaces. |
| Shared Nest pieces | `common/`, `config/`, `prisma/` | Filters, config, PrismaService wrapper. |

## Conventions

- Keep controllers thin: request parsing, guards, response mapping.
- Put business decisions in services and persistence in repositories.
- Repositories must not throw HTTP exceptions or import controllers/services.
- Controllers must not import Prisma, repositories, or concrete adapters.
- Services depend on ports or repositories, not concrete delivery adapters.
- DTO request/response contracts live in domain `dto/*.dto.ts` files.
- `@Body()` types must be exported `*Dto` classes/interfaces from DTO files.
- Schema changes belong under `backend/prisma/`; read `../prisma/AGENTS.md`
  first.
- Runtime env comes from the repo-root `.env.local`; do not create
  `backend/.env*`.

## Anti-patterns

- Do not reintroduce legacy `ingest/` HMAC routes; ML ingress is `POST /api/v1/events`.
- No inline DTO interfaces/types in controllers or services.
- No controller-to-repository or controller-to-Prisma shortcuts.
- No repository imports from HTTP/Nest controller concerns.
- No app-start Prisma migrations, `db push`, reset, or seed shortcuts.
