# Backend agent rules — NestJS alert policy / KakaoTalk webhooks (run/boot/flow in root AGENTS.md)

## Layout

```
backend/src/
├── events/                       # ML event intake: POST /api/v1/events
├── alerts/                       # alert policy + Kakao fan-out (event/alarm split: issue #388)
├── residents/ resident-assignments/ resident-risk-summaries/   # resident domain
├── facilities/ floors/ spaces/ zones/ space-statuses/ cameras/ # facility topology
├── guardians/ auth/              # guardians + authentication
├── dashboard/ status/            # read-side APIs
├── prisma/                       # PrismaService (schema: backend/prisma/schema.prisma)
└── common/                       # shared guards, filters, decorators
```

See `src/AGENTS.md` before changing Nest application code. See
`test/AGENTS.md` before changing backend integration or e2e tests.

## Guards
- `prisma/schema.prisma` is the data SSOT — change via migration, never hand-edit the DB.
- See `prisma/AGENTS.md` before changing schema, migrations, runtime DB roles, or
  deploy-time database replay.
- Event API (`POST /api/v1/events` + `POST /api/v1/events/heartbeat`) is the only ML ingress; do not reintroduce legacy machine-ingest routes, HMAC camera credentials, or `Camera.ingestMode`.
- Never commit real `.env*`; native dev reads the repo-root `.env.local` SSOT.


## Event ingest rollout contract (issue #388 cutover)
- `POST /api/v1/events` and `POST /api/v1/events/heartbeat` are the only live ML ingress endpoints.
- Removed machine-ingest routes, camera HMAC credentials, and `Camera.ingestMode` must stay removed rather than lingering as compatibility aliases.
- `CamerasService.recordHeartbeat` remains used by `EventsController.heartbeat`.
## Run
- pnpm only; test: `pnpm --filter backend test` (jest).
- lint: `pnpm --filter backend lint` (check) / `pnpm --filter backend lint:fix` (autofix). Convention: decision map.
