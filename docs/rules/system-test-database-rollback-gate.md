# SYSTEM_TEST database migration and rollback gate

Migration `20260813030000_system_test_media_boundary` is forward-only. The four published migrations before it remain immutable:

```text
63b50c2d0dd1b5e2d3447d766b9fcbf060f9d5601776ad063288ee6769571973  20260812230000_media_download_safe_method/migration.sql
51da43bccad9a66dcdd9b0d76450b05cb40963df0a7819ab89f346d484ec73ac  20260813000000_system_test_dashboard_gate/migration.sql
54e78586b33644defff4a1c3acbe4945fd23330b2f96ebf5b104493d0b028841  20260813010000_system_test_purge_least_privilege/migration.sql
cdb9b9f4f37734300262bf3f92daaea5865488e86c2a87b2a6c58b7645ca7c7c  20260813020000_edge_validation_grant_least_privilege/migration.sql
```

## Deterministic local 44 -> 49 rehearsal

Run against disposable local PostgreSQL only. This copies migrations into a temporary Prisma tree; it does not edit the repository.

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
set -a
. ./.env.local
set +a

fixture_db=seeon_migration_44_to_49
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT

docker compose exec -T db dropdb --if-exists -U "$POSTGRES_USER" "$fixture_db"
docker compose exec -T db createdb -U "$POSTGRES_USER" "$fixture_db"
mkdir -p "$fixture_dir/prisma/migrations"
cp backend/prisma/schema.prisma backend/prisma/migrations/migration_lock.toml \
  "$fixture_dir/prisma/"
find backend/prisma/migrations -mindepth 1 -maxdepth 1 -type d -print \
  | LC_ALL=C sort | head -44 \
  | while IFS= read -r migration; do
      cp -R "$migration" "$fixture_dir/prisma/migrations/"
    done

fixture_direct_url="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT:-5432}/${fixture_db}?schema=public"
DIRECT_URL="$fixture_direct_url" DATABASE_URL="$fixture_direct_url" \
  pnpm --dir backend exec prisma migrate deploy \
  --schema "$fixture_dir/prisma/schema.prisma"

docker compose exec -T db psql -U "$POSTGRES_USER" -d "$fixture_db" \
  -v ON_ERROR_STOP=1 -Atc \
  "SELECT count(*), max(migration_name) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"
# Expected: 44|20260811154344_edge_installation_heartbeat_sync

find backend/prisma/migrations -mindepth 1 -maxdepth 1 -type d -print \
  | LC_ALL=C sort | tail -n +45 \
  | while IFS= read -r migration; do
      cp -R "$migration" "$fixture_dir/prisma/migrations/"
    done
DIRECT_URL="$fixture_direct_url" DATABASE_URL="$fixture_direct_url" \
  pnpm --dir backend exec prisma migrate deploy \
  --schema "$fixture_dir/prisma/schema.prisma"
# Expected: migrations 45, 46, 47, 48, and 49 are each applied once.

DIRECT_URL="$fixture_direct_url" DATABASE_URL="$fixture_direct_url" \
  pnpm --dir backend exec prisma migrate deploy \
  --schema "$fixture_dir/prisma/schema.prisma"
# Expected: "No pending migrations to apply."

docker compose exec -T db psql -U "$POSTGRES_USER" -d "$fixture_db" \
  -v ON_ERROR_STOP=1 -Atc \
  "SELECT count(*), count(DISTINCT migration_name), max(migration_name) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"
# Expected: 49|49|20260813030000_system_test_media_boundary

docker compose exec -T db dropdb -U "$POSTGRES_USER" "$fixture_db"
```

## Restored production-dump gate

The production dump is host-only. Do not access it, production PostgreSQL, or production roles before **2026-08-17 KST**. After that embargo, the deploy owner must run this in a separately approved, isolated rehearsal PostgreSQL instance, never against the live production database. Supply URLs whose database users are equivalent to the production migration and runtime roles.

```bash
set -euo pipefail
cd /path/to/checked-out/SeeON-Backend
export SOURCE_DUMP=/host-only/path/to/exact-pre-migration.dump
export ADMIN_MAINTENANCE_URL='postgresql://MIGRATION_ROLE:URL_ENCODED_PASSWORD@REHEARSAL_HOST:5432/postgres?sslmode=require'
export REHEARSAL_DB="seeon_restore_$(date -u +%Y%m%dT%H%M%SZ)"
export REHEARSAL_PG_URL="postgresql://MIGRATION_ROLE:URL_ENCODED_PASSWORD@REHEARSAL_HOST:5432/${REHEARSAL_DB}?sslmode=require"
export DIRECT_URL="${REHEARSAL_PG_URL}&schema=public"
export DATABASE_URL="postgresql://fall_app:URL_ENCODED_PASSWORD@REHEARSAL_HOST:5432/${REHEARSAL_DB}?sslmode=require&schema=public"

createdb --maintenance-db="$ADMIN_MAINTENANCE_URL" "$REHEARSAL_DB"
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname="$REHEARSAL_PG_URL" "$SOURCE_DUMP"
psql "$REHEARSAL_PG_URL" -v ON_ERROR_STOP=1 -P pager=off -c \
  "SELECT count(*) AS applied, max(migration_name) AS latest FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"
# Required baseline evidence: applied=44 and latest=20260811154344_edge_installation_heartbeat_sync.

pnpm --dir backend exec prisma migrate deploy --schema backend/prisma/schema.prisma
# Required evidence: exactly migrations 45 through 49 apply, once each.
pnpm --dir backend exec prisma migrate deploy --schema backend/prisma/schema.prisma
# Required evidence: "No pending migrations to apply."

psql "$REHEARSAL_PG_URL" -v ON_ERROR_STOP=1 -P pager=off -c \
  "SELECT count(*) AS applied, count(DISTINCT migration_name) AS distinct_applied, max(migration_name) AS latest FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"
# Required evidence: applied=49, distinct_applied=49, latest=20260813030000_system_test_media_boundary.

psql "$REHEARSAL_PG_URL" -v ON_ERROR_STOP=1 -P pager=off -c \
  "SELECT member_role.rolname AS unexpected_member FROM pg_catalog.pg_auth_members membership JOIN pg_catalog.pg_roles owner_role ON owner_role.oid=membership.roleid JOIN pg_catalog.pg_roles member_role ON member_role.oid=membership.member WHERE owner_role.rolname='system_test_purge_owner';"
# Required evidence: zero rows.
```

Retain the dump identity/hash, the two complete `migrate deploy` transcripts, and both SQL result sets as deployment-gate evidence. A baseline other than exactly 44 successful migrations is not this rehearsal and must not be reported as one.

## Old-image code-only rollback predicate

An old backend image is unsafe while any SYSTEM_TEST event, alert, media binding, or validation run remains. A code-only rollback is allowed only when the following query returns `code_only_rollback_safe = true` and every count is zero, immediately before rollback:

```sql
WITH system_test_state AS (
  SELECT
    (SELECT pg_catalog.count(*)
       FROM public.events AS event_row
      WHERE event_row.type OPERATOR(pg_catalog.=) 'SYSTEM_TEST') AS event_count,
    (SELECT pg_catalog.count(*)
       FROM public.alerts AS alert_row
      WHERE alert_row.type OPERATOR(pg_catalog.=) 'SYSTEM_TEST') AS alert_count,
    (SELECT pg_catalog.count(*)
       FROM public.event_media_bindings AS binding_row
       JOIN public.events AS event_row
         ON event_row.facility_id OPERATOR(pg_catalog.=) binding_row.facility_id
        AND event_row.id OPERATOR(pg_catalog.=) binding_row.event_id
      WHERE event_row.type OPERATOR(pg_catalog.=) 'SYSTEM_TEST') AS binding_count,
    (SELECT pg_catalog.count(*)
       FROM public.edge_validation_grants AS grant_row
      WHERE grant_row.capability OPERATOR(pg_catalog.=) 'SYSTEM_TEST') AS run_count
)
SELECT
  event_count,
  alert_count,
  binding_count,
  run_count,
  event_count OPERATOR(pg_catalog.=) 0
    AND alert_count OPERATOR(pg_catalog.=) 0
    AND binding_count OPERATOR(pg_catalog.=) 0
    AND run_count OPERATOR(pg_catalog.=) 0 AS code_only_rollback_safe
FROM system_test_state;
```

Do not claim old-image compatibility after SYSTEM_TEST rows have been created unless this predicate has subsequently returned true. Database migrations are not rolled back by a code-only image rollback.
