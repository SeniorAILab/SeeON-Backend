# Prisma agent rules - schema, migrations, and deploy boundary

## Overview
`backend/prisma/**` is the database contract: Prisma schema, committed
migration SQL, seed data, and Postgres role initialization.

## Where to look
- `schema.prisma` - data model SSOT and runtime/migration URL split.
- `migrations/*/migration.sql` - committed SQL replayed in production deploys.
- `init/01-create-app-role.sql` and `init/02-sync-app-role.sh` - runtime role
  setup and privilege synchronization.
- `docs/runbooks/ncloud-vm-deploy.md` - production replay contract.

## Conventions
- `DATABASE_URL` is the runtime app role path. `DIRECT_URL` is for migrations,
  schema introspection, and seed/admin work only.
- Schema changes require committed migration SQL; keep deploy replay compatible
  with `psql -v ON_ERROR_STOP=1`.
- The backend Docker build may generate Prisma Client, but the production app
  container must not run Prisma CLI migrations at startup.
- Production migration replay belongs to deploy tooling, not the NestJS app
  process and not a separate migrate image.
- Keep the fixed runtime role contract aligned with `APP_DB_USER=fall_app`
  unless a backend ADR changes it.

## Anti-patterns
- No hand-edited production database changes outside migrations.
- No backend startup `prisma migrate`, `db push`, reset, or seed.
- No bundling migration SQL into the runtime app image for execution by the app.
- No weakening the app role into owner/superuser to make migrations easier.
- No migration failure swallowing; failed SQL must stop deployment.
