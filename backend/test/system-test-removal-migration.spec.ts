import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const MIGRATION_NAME = '20260813120000_remove_system_test_runtime';
const MIGRATIONS_ROOT = join(__dirname, '..', 'prisma', 'migrations');
const SCHEMA_PATH = join(__dirname, '..', 'prisma', 'schema.prisma');

const ORDINARY_EVENT_ID = 'removal-ordinary-event';
const ORDINARY_ALERT_ID = 'removal-ordinary-alert';
const ORDINARY_RECEIPT_ID = 'removal-ordinary-receipt';
const ORDINARY_GRANT_ID = '10000000-0000-4000-8000-000000000001';
const TEST_GRANT_ID = '20000000-0000-4000-8000-000000000002';
const RESOLVED_TEST_EVENT_ID = 'removal-resolved-test-event';
const RESOLVED_TEST_ALERT_ID = 'removal-resolved-test-alert';
const ACTIVE_TEST_EVENT_ID = 'removal-active-test-event';
const ACTIVE_TEST_ALERT_ID = 'removal-active-test-alert';

jest.setTimeout(180_000);

describe('SYSTEM_TEST removal migration', () => {
  it('purges only feature rows and leaves ordinary data, RLS, and runtime grants intact', async () => {
    if (!process.env.DIRECT_URL) throw new Error('DIRECT_URL is required');

    const maintenance = new PrismaClient({
      datasourceUrl: process.env.DIRECT_URL,
    });
    const databaseName = `system_test_removal_${process.pid}_${Date.now()}`;
    const databaseUrl = withDatabase(process.env.DIRECT_URL, databaseName);
    const rehearsalRoot = mkdtempSync(join(tmpdir(), 'seeon-removal-'));
    const rehearsalSchema = join(rehearsalRoot, 'schema.prisma');
    const rehearsalMigrations = join(rehearsalRoot, 'migrations');

    await maintenance.$connect();
    try {
      await maintenance.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
      cpSync(SCHEMA_PATH, rehearsalSchema);
      mkdirSync(rehearsalMigrations);
      cpSync(
        join(MIGRATIONS_ROOT, 'migration_lock.toml'),
        join(rehearsalMigrations, 'migration_lock.toml'),
      );
      for (const entry of migrationDirectories().filter(
        (name) => name < MIGRATION_NAME,
      )) {
        cpSync(join(MIGRATIONS_ROOT, entry), join(rehearsalMigrations, entry), {
          recursive: true,
        });
      }
      runPrisma(
        ['migrate', 'deploy', '--schema', rehearsalSchema],
        databaseUrl,
      );

      const rehearsal = new PrismaClient({ datasourceUrl: databaseUrl });
      await rehearsal.$connect();
      try {
        await seedPreRemovalRows(rehearsal);
        runPrisma(
          [
            'db',
            'execute',
            '--file',
            join(MIGRATIONS_ROOT, MIGRATION_NAME, 'migration.sql'),
            '--url',
            databaseUrl,
          ],
          databaseUrl,
        );

        const [survivors, removed, contract, rls, privileges] =
          await Promise.all([
            rehearsal.$queryRawUnsafe<RowCounts[]>(survivorQuery()),
            rehearsal.$queryRawUnsafe<RowCounts[]>(removedQuery()),
            rehearsal.$queryRawUnsafe<RemovalContractRow[]>(contractQuery()),
            rehearsal.$queryRawUnsafe<RlsRow[]>(rlsQuery()),
            rehearsal.$queryRawUnsafe<PrivilegeRow[]>(privilegeQuery()),
          ]);

        expect(survivors).toEqual([
          { events: 1n, alerts: 1n, receipts: 1n, grants: 1n },
        ]);
        expect(removed).toEqual([
          { events: 0n, alerts: 0n, receipts: 0n, grants: 0n },
        ]);
        expect(contract).toEqual([
          {
            retention_column: false,
            capability_column: false,
            purge_table: false,
            purge_function: false,
            purge_role: false,
            event_camera_required: true,
            event_space_required: true,
            alert_space_required: true,
            alert_probability_required: true,
          },
        ]);
        expect(rls).toEqual([
          { table_name: 'alerts', enabled: true, forced: true },
          {
            table_name: 'dashboard_receipt_history',
            enabled: true,
            forced: true,
          },
          {
            table_name: 'edge_validation_grants',
            enabled: true,
            forced: true,
          },
          { table_name: 'events', enabled: true, forced: true },
        ]);
        expect(privileges).toEqual([
          {
            can_insert_alert: true,
            can_update_alert_status: true,
            can_delete_alert: false,
            can_insert_event: true,
            can_delete_event: false,
            can_insert_grant: true,
            can_update_grant_status: true,
            can_delete_grant: false,
          },
        ]);
      } finally {
        await rehearsal.$disconnect();
      }
    } finally {
      await maintenance.$executeRawUnsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}'`,
      );
      await maintenance.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS "${databaseName}"`,
      );
      await maintenance.$disconnect();
      rmSync(rehearsalRoot, { recursive: true, force: true });
    }
  });
});

function migrationDirectories(): string[] {
  return readdirSync(MIGRATIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function withDatabase(connectionUrl: string, databaseName: string): string {
  const parsed = new URL(connectionUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function runPrisma(args: readonly string[], databaseUrl: string): void {
  const result = spawnSync('pnpm', ['exec', 'prisma', ...args], {
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DIRECT_URL: databaseUrl,
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `prisma ${args.join(' ')} failed (${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

async function seedPreRemovalRows(db: PrismaClient): Promise<void> {
  const statements = [
    `INSERT INTO facilities (id, name) VALUES ('removal-facility', 'Removal fixture')`,
    `INSERT INTO floors (id, facility_id, name, order_index) VALUES ('removal-floor', 'removal-facility', '1F', 1)`,
    `INSERT INTO spaces (id, facility_id, floor_id, name, type, capacity) VALUES ('removal-space', 'removal-facility', 'removal-floor', '101', 'ROOM', 1)`,
    `INSERT INTO cameras (id, facility_id, space_id, label) VALUES ('removal-camera', 'removal-facility', 'removal-space', 'Camera')`,
    `INSERT INTO edge_installations (id, facility_id, current_generation, updated_at) VALUES ('30000000-0000-4000-8000-000000000003', 'removal-facility', 1, now())`,
    `INSERT INTO edge_installation_generations (id, facility_id, edge_installation_id, enrollment_generation, state, updated_at) VALUES ('removal-generation', 'removal-facility', '30000000-0000-4000-8000-000000000003', 1, 'CLAIMED', now())`,
    `INSERT INTO edge_validation_grants (id, facility_id, edge_installation_id, enrollment_generation, status, capability, expires_at, closed_at) VALUES ('${ORDINARY_GRANT_ID}', 'removal-facility', '30000000-0000-4000-8000-000000000003', 1, 'ACTIVE', NULL, now() + interval '1 hour', NULL), ('${TEST_GRANT_ID}', 'removal-facility', '30000000-0000-4000-8000-000000000003', 1, 'CLOSED', 'SYSTEM_TEST', now() + interval '1 hour', now())`,
    `INSERT INTO events (id, facility_id, camera_id, space_id, type, confidence, detected_at, modified_at, dedup_key, validation_run_id, retention_expires_at) VALUES ('${ORDINARY_EVENT_ID}', 'removal-facility', 'removal-camera', 'removal-space', 'fall', 0.9, now(), now(), '${ORDINARY_EVENT_ID}', '${ORDINARY_GRANT_ID}', NULL), ('${RESOLVED_TEST_EVENT_ID}', 'removal-facility', NULL, NULL, 'SYSTEM_TEST', NULL, now(), now(), '${RESOLVED_TEST_EVENT_ID}', '${TEST_GRANT_ID}', now() - interval '1 day'), ('${ACTIVE_TEST_EVENT_ID}', 'removal-facility', NULL, NULL, 'SYSTEM_TEST', NULL, now(), now(), '${ACTIVE_TEST_EVENT_ID}', '${TEST_GRANT_ID}', now() + interval '30 days')`,
    `INSERT INTO alerts (id, facility_id, camera_id, space_id, type, probability, detected_at, status, idempotency_key, origin_event_id, resolved_at) VALUES ('${ORDINARY_ALERT_ID}', 'removal-facility', 'removal-camera', 'removal-space', 'fall', 0.9, now(), 'NEW', '${ORDINARY_ALERT_ID}', '${ORDINARY_EVENT_ID}', NULL), ('${RESOLVED_TEST_ALERT_ID}', 'removal-facility', NULL, NULL, 'SYSTEM_TEST', NULL, now(), 'RESOLVED', '${RESOLVED_TEST_ALERT_ID}', '${RESOLVED_TEST_EVENT_ID}', now()), ('${ACTIVE_TEST_ALERT_ID}', 'removal-facility', NULL, NULL, 'SYSTEM_TEST', NULL, now(), 'NEW', '${ACTIVE_TEST_ALERT_ID}', '${ACTIVE_TEST_EVENT_ID}', NULL)`,
    `INSERT INTO dashboard_receipt_history (id, facility_id, dashboard_client_id, kind, backend_event_id, alert_id, alert_seq, surface, observed_at) SELECT '${ORDINARY_RECEIPT_ID}', facility_id, 'ordinary-client', 'DELIVERY', origin_event_id, id, alert_seq, 'dashboard', now() FROM alerts WHERE id = '${ORDINARY_ALERT_ID}'`,
    `INSERT INTO dashboard_receipt_history (id, facility_id, dashboard_client_id, kind, backend_event_id, alert_id, alert_seq, surface, observed_at) SELECT 'removal-test-receipt-' || id, facility_id, 'test-client', 'DELIVERY', origin_event_id, id, alert_seq, 'dashboard', now() FROM alerts WHERE type = 'SYSTEM_TEST'`,
    `INSERT INTO alert_notes (id, facility_id, alert_id, note, author_role) VALUES ('removal-test-note', 'removal-facility', '${RESOLVED_TEST_ALERT_ID}', 'temporary validation note', 'SUPER_ADMIN')`,
    `INSERT INTO system_test_purge_audit_history (receipt_id, job_id, facility_id, purged_events, purged_alerts, purged_dashboard_receipts, purged_alert_notes) VALUES ('40000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000004', 'removal-facility', 1, 1, 0, 0)`,
  ];
  await db.$transaction(async (tx) => {
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
  });
}

function survivorQuery(): string {
  return `SELECT
    (SELECT count(*) FROM events WHERE id = '${ORDINARY_EVENT_ID}') AS events,
    (SELECT count(*) FROM alerts WHERE id = '${ORDINARY_ALERT_ID}') AS alerts,
    (SELECT count(*) FROM dashboard_receipt_history WHERE id = '${ORDINARY_RECEIPT_ID}') AS receipts,
    (SELECT count(*) FROM edge_validation_grants WHERE id = '${ORDINARY_GRANT_ID}') AS grants`;
}

function removedQuery(): string {
  return `SELECT
    (SELECT count(*) FROM events WHERE id IN ('${RESOLVED_TEST_EVENT_ID}', '${ACTIVE_TEST_EVENT_ID}')) AS events,
    (SELECT count(*) FROM alerts WHERE id IN ('${RESOLVED_TEST_ALERT_ID}', '${ACTIVE_TEST_ALERT_ID}')) AS alerts,
    (SELECT count(*) FROM dashboard_receipt_history WHERE dashboard_client_id = 'test-client') AS receipts,
    (SELECT count(*) FROM edge_validation_grants WHERE id = '${TEST_GRANT_ID}') AS grants`;
}

function contractQuery(): string {
  return `SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'retention_expires_at') AS retention_column,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'edge_validation_grants' AND column_name = 'capability') AS capability_column,
    to_regclass('public.system_test_purge_audit_history') IS NOT NULL AS purge_table,
    to_regprocedure('public.purge_expired_system_tests(text,uuid)') IS NOT NULL AS purge_function,
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'system_test_purge_owner') AS purge_role,
    (SELECT is_nullable = 'NO' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'camera_id') AS event_camera_required,
    (SELECT is_nullable = 'NO' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'space_id') AS event_space_required,
    (SELECT is_nullable = 'NO' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'alerts' AND column_name = 'space_id') AS alert_space_required,
    (SELECT is_nullable = 'NO' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'alerts' AND column_name = 'probability') AS alert_probability_required`;
}

function rlsQuery(): string {
  return `SELECT relname AS table_name, relrowsecurity AS enabled, relforcerowsecurity AS forced
    FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('alerts', 'dashboard_receipt_history', 'edge_validation_grants', 'events')
    ORDER BY relname`;
}

function privilegeQuery(): string {
  return `SELECT
    has_table_privilege('fall_app', 'public.alerts', 'INSERT') AS can_insert_alert,
    has_column_privilege('fall_app', 'public.alerts', 'status', 'UPDATE') AS can_update_alert_status,
    has_table_privilege('fall_app', 'public.alerts', 'DELETE') AS can_delete_alert,
    has_table_privilege('fall_app', 'public.events', 'INSERT') AS can_insert_event,
    has_table_privilege('fall_app', 'public.events', 'DELETE') AS can_delete_event,
    has_table_privilege('fall_app', 'public.edge_validation_grants', 'INSERT') AS can_insert_grant,
    has_column_privilege('fall_app', 'public.edge_validation_grants', 'status', 'UPDATE') AS can_update_grant_status,
    has_table_privilege('fall_app', 'public.edge_validation_grants', 'DELETE') AS can_delete_grant`;
}

type RowCounts = {
  events: bigint;
  alerts: bigint;
  receipts: bigint;
  grants: bigint;
};
type RemovalContractRow = {
  retention_column: boolean;
  capability_column: boolean;
  purge_table: boolean;
  purge_function: boolean;
  purge_role: boolean;
  event_camera_required: boolean;
  event_space_required: boolean;
  alert_space_required: boolean;
  alert_probability_required: boolean;
};
type RlsRow = { table_name: string; enabled: boolean; forced: boolean };
type PrivilegeRow = {
  can_insert_alert: boolean;
  can_update_alert_status: boolean;
  can_delete_alert: boolean;
  can_insert_event: boolean;
  can_delete_event: boolean;
  can_insert_grant: boolean;
  can_update_grant_status: boolean;
  can_delete_grant: boolean;
};
