# Backend agent rules — NestJS alert policy / KakaoTalk webhooks (run/boot/flow in root AGENTS.md)

## Layout

```
backend/src/
├── ingest/                       # ML alert intake: POST /ingest/alerts, HMAC-guarded (hmac.guard.ts)
├── alerts/ alert-rules/          # alert policy + rules → KakaoTalk fan-out
├── detection-events/             # raw ML detection events
├── residents/ resident-assignments/ resident-risk-summaries/   # resident domain
├── facilities/ floors/ spaces/ zones/ space-statuses/ cameras/ # facility topology
├── guardians/ auth/              # guardians + authentication
├── dashboard/ status/            # read-side APIs
├── prisma/                       # PrismaService (schema: backend/prisma/schema.prisma)
└── common/                       # shared guards, filters, decorators
```

## Guards
- `prisma/schema.prisma` is the data SSOT — change via migration, never hand-edit the DB.
- Never bypass the HMAC guard on `POST /ingest/alerts` (`src/ingest/hmac.guard.ts`).
- Never commit `.env*` (native dev reads `backend/.env.development`).

## Run
- pnpm only; test: `pnpm --filter backend test` (jest).
