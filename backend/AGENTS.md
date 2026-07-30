# Backend agent rules — NestJS alert policy / email alert webhooks (run/boot/flow in root AGENTS.md)

## Layout

```
backend/src/
├── events/                       # ML event intake: POST /api/v1/events
├── alerts/                       # alert policy + email fan-out (event/alarm split: issue #388)
├── media/                        # event/alert clip storage + authenticated playback (largest module)
├── facilities/ floors/ spaces/ cameras/ # facility topology
├── auth/                         # authentication
├── dashboard/                    # read-side APIs + SSE
├── ml-config/ users/ demo-seed/  # edge config, user admin, demo fixtures
├── prisma/                       # PrismaService (schema: backend/prisma/schema.prisma)
└── common/ config/               # shared guards, filters, domain errors, env validation
```

See `src/AGENTS.md` before changing Nest application code, `src/alerts/AGENTS.md`
for the alert write/read split, `src/media/AGENTS.md` for clips, and
`test/AGENTS.md` before changing backend integration or e2e tests. There is no
`src/status/` module.

## Guards
- `prisma/schema.prisma` is the data SSOT — change via migration, never hand-edit the DB.
- See `prisma/AGENTS.md` before changing schema, migrations, runtime DB roles, or
  deploy-time database replay.
- Event API (`POST /api/v1/events` + `POST /api/v1/events/heartbeat`) is the only ML *event-fact* ingress; `PUT /api/v1/events/:eventId/snapshot` is an authenticated auxiliary edge route. All three share `EdgeIngestTokenGuard` (edge bearer, #567). Do not reintroduce legacy machine-ingest routes, HMAC camera credentials, or `Camera.ingestMode`.
- Never commit real `.env*`; native dev reads the repo-root `.env.local` SSOT.
- Backend spec 파일에서 `fac_happy_nokyang` 같은 scoped-id 문자열은 파일별 이름 있는 상수 하나에서 파생해야 합니다.


## Event ingest rollout contract (issue #388 cutover)
- `POST /api/v1/events` and `POST /api/v1/events/heartbeat` are the only live ML event-fact ingress endpoints; `PUT /api/v1/events/:eventId/snapshot` is an authenticated auxiliary edge route sharing the same `EdgeIngestTokenGuard` (#567) — it is not a legacy/unguarded route.
- Removed machine-ingest routes, camera HMAC credentials, and `Camera.ingestMode` must stay removed rather than lingering as compatibility aliases.
- `CamerasService.recordHeartbeat` remains used by `EventsController.heartbeat`.

## Data model (v1 is room-centric)
- v1 monitors at **room (space) granularity only**. There is no resident/guardian domain: `residents`, `resident_assignments`, `resident_statuses`, and `guardians` (tables + CRUD API) were dropped and return in v2. Alerts key off `spaceId`/`cameraId`, never a resident.
- Table roles (keep these boundaries when adding columns/tables):
  - **Append-only history / event log** — insert-and-keep, never repurposed as mutable state: `events` (immutable ML event SSOT), `alerts` (alert log; `alertSeq` is the SSE Last-Event-ID), `alert_events` + `delivery_attempts` (email delivery outbox). New audit/history goes here as append rows.
  - **Facility topology / config** — mutable domain rows: `facilities`, `floors`, `spaces`, `cameras`.
  - **Identity / auth** — `users`; app-layer gated, NOT RLS tenant models (see `TENANT_MODELS` in `src/prisma/prisma.service.ts`).
- Re-adding resident/guardian in v2 is a schema+API addition, not a revival of the removed columns on `alerts`.

## Run
- pnpm only; test: `pnpm --filter backend test` (jest).
- lint: `pnpm --filter backend lint` (check) / `pnpm --filter backend lint:fix` (autofix). Convention: ADR.
