# Backend agent rules — NestJS alert policy / KakaoTalk webhooks (run/boot/flow in root AGENTS.md)

## Layout

```
backend/src/
├── ingest/                       # ML alert intake: POST /ingest/alerts, HMAC-guarded (hmac.guard.ts)
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
- Never bypass the HMAC guard on `POST /ingest/alerts` (`src/ingest/hmac.guard.ts`).
- Never commit real `.env*`; native dev reads the repo-root `.env.local` SSOT.


## Event ingest rollout contract (issue #388 PR4+)
- `POST /ingest/alerts` remains the live ML alarm ingress until PR5 wires `Event -> AlertPolicy -> Alert` and enforces a per-camera single-writer cutover.
- PR4 intentionally keeps ML payload/HMAC synchronization deferred: legacy `/ingest/alerts` and `/ingest/heartbeat` stay HMAC-guarded and live while versioned event endpoints use the no-HMAC internal API contract.
- Do not add `Camera.ingestMode` in PR4. PR5 owns the per-camera single-writer mechanism, e.g. `Camera.ingestMode = LEGACY_ALERTS | EVENT_API` with default `LEGACY_ALERTS`, plus enforcement.
- After every camera is cut over, `/ingest/alerts` must become `404` or `410` by documented product choice rather than lingering as a compatibility alias.
## Run
- pnpm only; test: `pnpm --filter backend test` (jest).
- lint: `pnpm --filter backend lint` (check) / `pnpm --filter backend lint:fix` (autofix). Convention: ADR-070.
