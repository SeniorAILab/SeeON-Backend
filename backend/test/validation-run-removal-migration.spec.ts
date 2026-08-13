import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const MIGRATION_NAME = '20260813170000_remove_validation_run_grants';
const MIGRATIONS_ROOT = join(__dirname, '..', 'prisma', 'migrations');
const SCHEMA_PATH = join(__dirname, '..', 'prisma', 'schema.prisma');
const FACILITY_ID = 'validation-removal-facility';
const EVENT_ID = 'validation-removal-event';
const ALERT_ID = 'validation-removal-alert';
const RECEIPT_ID = 'validation-removal-receipt';
const CLIP_ID = 'validation-removal-clip';
const INSTALLATION_ID = '30000000-0000-4000-8000-000000000003';
const GRANT_ID = '40000000-0000-4000-8000-000000000004';
const LINKED_EVENT_ID = 'validation-removal-linked-event';

jest.setTimeout(180_000);

describe('validation-run/grant removal migration', () => {
  it('replays the complete empty migration chain to the final schema', async () => {
    await withDisposableDatabase(
      'validation_removal_full',
      async (databaseUrl) => {
        runPrisma(['migrate', 'deploy', '--schema', SCHEMA_PATH], databaseUrl);
        const db = new PrismaClient({ datasourceUrl: databaseUrl });
        await db.$connect();
        try {
          await expectFinalObjectsAbsent(db);
        } finally {
          await db.$disconnect();
        }
      },
    );
  });

  it('aborts on retired rows, then removes only exact retired history from migration 49 state', async () => {
    await withDisposableDatabase(
      'validation_removal_49_50',
      async (databaseUrl) => {
        const rehearsalRoot = mkdtempSync(
          join(tmpdir(), 'seeon-validation-removal-'),
        );
        try {
          const rehearsalSchema = join(rehearsalRoot, 'schema.prisma');
          const rehearsalMigrations = join(rehearsalRoot, 'migrations');
          cpSync(SCHEMA_PATH, rehearsalSchema);
          mkdirSync(rehearsalMigrations);
          cpSync(
            join(MIGRATIONS_ROOT, 'migration_lock.toml'),
            join(rehearsalMigrations, 'migration_lock.toml'),
          );
          for (const entry of migrationDirectories().filter(
            (name) => name < MIGRATION_NAME,
          )) {
            cpSync(
              join(MIGRATIONS_ROOT, entry),
              join(rehearsalMigrations, entry),
              {
                recursive: true,
              },
            );
          }
          runPrisma(
            ['migrate', 'deploy', '--schema', rehearsalSchema],
            databaseUrl,
          );

          const db = new PrismaClient({ datasourceUrl: databaseUrl });
          await db.$connect();
          try {
            await seedMigration49Fixture(db);
            const ordinaryBefore = await ordinaryContract(db);

            await db.$executeRawUnsafe(
              `INSERT INTO edge_validation_grants (id, facility_id, edge_installation_id, enrollment_generation, expires_at) VALUES ('${GRANT_ID}', '${FACILITY_ID}', '${INSTALLATION_ID}', 1, now() + interval '1 hour')`,
            );
            expect(
              runPrismaExpectFailure(
                [
                  'db',
                  'execute',
                  '--file',
                  migrationSqlPath(),
                  '--url',
                  databaseUrl,
                ],
                databaseUrl,
              ),
            ).toContain('migration 50 precondition failed');

            await db.$executeRawUnsafe(
              `INSERT INTO events (id, facility_id, camera_id, space_id, type, confidence, detected_at, modified_at, dedup_key, validation_run_id) VALUES ('${LINKED_EVENT_ID}', '${FACILITY_ID}', 'validation-removal-camera', 'validation-removal-space', 'fall', 0.8, now(), now(), '${LINKED_EVENT_ID}', '${GRANT_ID}')`,
            );
            expect(
              runPrismaExpectFailure(
                [
                  'db',
                  'execute',
                  '--file',
                  migrationSqlPath(),
                  '--url',
                  databaseUrl,
                ],
                databaseUrl,
              ),
            ).toContain('validation-linked events=1');

            expect(await retiredHistoryCounts(db)).toEqual({
              createOperations: 2n,
              closeOperations: 2n,
              createdAudits: 2n,
              closedAudits: 2n,
            });
            await db.$executeRawUnsafe(
              `DELETE FROM events WHERE id = '${LINKED_EVENT_ID}'`,
            );
            await db.$executeRawUnsafe(
              `DELETE FROM edge_validation_grants WHERE id = '${GRANT_ID}'`,
            );

            await db.$executeRawUnsafe('CREATE ROLE system_test_purge_owner');
            expect(
              runPrismaExpectFailure(
                [
                  'db',
                  'execute',
                  '--file',
                  migrationSqlPath(),
                  '--url',
                  databaseUrl,
                ],
                databaseUrl,
              ),
            ).toContain(
              'migration 50 role precondition failed: system_test_purge_owner unexpectedly exists',
            );
            expect(await retiredHistoryCounts(db)).toEqual({
              createOperations: 2n,
              closeOperations: 2n,
              createdAudits: 2n,
              closedAudits: 2n,
            });
            await expectFinalObjectsPresent(db);
            await db.$executeRawUnsafe('DROP ROLE system_test_purge_owner');

            runPrisma(
              [
                'db',
                'execute',
                '--file',
                migrationSqlPath(),
                '--url',
                databaseUrl,
              ],
              databaseUrl,
            );

            expect(await ordinaryContract(db)).toEqual(ordinaryBefore);
            expect(await preservedHistoryCounts(db)).toEqual({
              issueOperations: 1n,
              transferOperations: 1n,
              issueAudits: 1n,
              replacementAudits: 1n,
              transferAudits: 1n,
              topologyAudits: 1n,
            });
            expect(await retiredHistoryCounts(db)).toEqual({
              createOperations: 0n,
              closeOperations: 0n,
              createdAudits: 0n,
              closedAudits: 0n,
            });
            await expectFinalObjectsAbsent(db);
          } finally {
            await db.$disconnect();
          }
        } finally {
          rmSync(rehearsalRoot, { recursive: true, force: true });
        }
      },
    );
  });
});

async function withDisposableDatabase(
  prefix: string,
  run: (databaseUrl: string) => Promise<void>,
): Promise<void> {
  if (!process.env.DIRECT_URL) throw new Error('DIRECT_URL is required');
  const maintenance = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL,
  });
  const databaseName = `${prefix}_${process.pid}_${Date.now()}`;
  const databaseUrl = withDatabase(process.env.DIRECT_URL, databaseName);
  await maintenance.$connect();
  try {
    await maintenance.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    await run(databaseUrl);
  } finally {
    await maintenance.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}'`,
    );
    await maintenance.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${databaseName}"`,
    );
    await maintenance.$disconnect();
  }
}

function migrationDirectories(): string[] {
  return readdirSync(MIGRATIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function migrationSqlPath(): string {
  return join(MIGRATIONS_ROOT, MIGRATION_NAME, 'migration.sql');
}

function withDatabase(connectionUrl: string, databaseName: string): string {
  const parsed = new URL(connectionUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function runPrisma(args: readonly string[], databaseUrl: string): void {
  const result = spawnPrisma(args, databaseUrl);
  if (result.status !== 0) {
    throw new Error(
      `prisma ${args.join(' ')} failed (${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function runPrismaExpectFailure(
  args: readonly string[],
  databaseUrl: string,
): string {
  const result = spawnPrisma(args, databaseUrl);
  if (result.status === 0) {
    throw new Error(`prisma ${args.join(' ')} unexpectedly succeeded`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

function spawnPrisma(args: readonly string[], databaseUrl: string) {
  return spawnSync('pnpm', ['exec', 'prisma', ...args], {
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DIRECT_URL: databaseUrl,
    },
    encoding: 'utf8',
  });
}

async function seedMigration49Fixture(db: PrismaClient): Promise<void> {
  const statements = [
    `INSERT INTO facilities (id, name) VALUES ('${FACILITY_ID}', 'Validation removal fixture')`,
    `INSERT INTO floors (id, facility_id, name, order_index) VALUES ('validation-removal-floor', '${FACILITY_ID}', '1F', 1)`,
    `INSERT INTO spaces (id, facility_id, floor_id, name, type, capacity) VALUES ('validation-removal-space', '${FACILITY_ID}', 'validation-removal-floor', '101', 'ROOM', 1)`,
    `INSERT INTO cameras (id, facility_id, space_id, label) VALUES ('validation-removal-camera', '${FACILITY_ID}', 'validation-removal-space', 'Camera')`,
    `INSERT INTO events (id, facility_id, camera_id, space_id, type, confidence, detected_at, modified_at, dedup_key) VALUES ('${EVENT_ID}', '${FACILITY_ID}', 'validation-removal-camera', 'validation-removal-space', 'fall', 0.9, now(), now(), '${EVENT_ID}')`,
    `INSERT INTO alerts (id, facility_id, camera_id, space_id, type, probability, detected_at, status, idempotency_key, origin_event_id) VALUES ('${ALERT_ID}', '${FACILITY_ID}', 'validation-removal-camera', 'validation-removal-space', 'fall', 0.9, now(), 'NEW', '${ALERT_ID}', '${EVENT_ID}')`,
    `INSERT INTO dashboard_receipt_history (id, facility_id, dashboard_client_id, kind, backend_event_id, alert_id, alert_seq, surface, observed_at) SELECT '${RECEIPT_ID}', facility_id, 'ordinary-client', 'DELIVERY', origin_event_id, id, alert_seq, 'dashboard', now() FROM alerts WHERE id = '${ALERT_ID}'`,
    `INSERT INTO media_clips (id, facility_id, camera_id, external_clip_id, status, state_version, storage_state, updated_at) VALUES ('${CLIP_ID}', '${FACILITY_ID}', 'validation-removal-camera', '${CLIP_ID}', 'PENDING', 1, 'NONE', now())`,
    `INSERT INTO event_media_bindings (event_id, facility_id, clip_id, ordinal) VALUES ('${EVENT_ID}', '${FACILITY_ID}', '${CLIP_ID}', 0)`,
    `INSERT INTO edge_installations (id, facility_id, current_generation, updated_at) VALUES ('${INSTALLATION_ID}', '${FACILITY_ID}', 1, now())`,
    `INSERT INTO edge_installation_generations (id, facility_id, edge_installation_id, enrollment_generation, state, updated_at) VALUES ('validation-removal-generation', '${FACILITY_ID}', '${INSTALLATION_ID}', 1, 'CLAIMED', now())`,
    operationInsert('50000000-0000-4000-8000-000000000001', 'VALIDATION_RUN'),
    operationInsert('50000000-0000-4000-8000-000000000002', 'VALIDATION_RUN'),
    operationInsert(
      '50000000-0000-4000-8000-000000000003',
      'VALIDATION_RUN_CLOSE',
    ),
    operationInsert(
      '50000000-0000-4000-8000-000000000004',
      'VALIDATION_RUN_CLOSE',
    ),
    operationInsert('50000000-0000-4000-8000-000000000005', 'ISSUE'),
    operationInsert(
      '50000000-0000-4000-8000-000000000006',
      'OWNERSHIP_TRANSFER',
    ),
    auditInsert('VALIDATION_RUN_CREATED', 1),
    auditInsert('VALIDATION_RUN_CREATED', 2),
    auditInsert('VALIDATION_RUN_CLOSED', 3),
    auditInsert('VALIDATION_RUN_CLOSED', 4),
    auditInsert('CREDENTIAL_ISSUED', 5),
    auditInsert('INSTALLATION_REPLACED', 6),
    auditInsert('OWNERSHIP_TRANSFERRED', 7),
    auditInsert('TOPOLOGY_APPLIED', 8),
  ];
  await db.$transaction(async (tx) => {
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
  });
}

function operationInsert(id: string, operationType: string): string {
  return `INSERT INTO edge_admin_operations (id, facility_id, idempotency_key, operation_type, body_hash, status, updated_at) VALUES ('${id}', '${FACILITY_ID}', '${id}', '${operationType}', repeat('0', 64), 'SUCCEEDED', now())`;
}

function auditInsert(action: string, sequence: number): string {
  return `INSERT INTO edge_provisioning_audit_history (facility_id, edge_installation_id, enrollment_generation, action, outcome, request_id) VALUES ('${FACILITY_ID}', '${INSTALLATION_ID}', 1, '${action}', 'SUCCEEDED', 'validation-removal-${sequence}')`;
}

async function ordinaryContract(db: PrismaClient): Promise<OrdinaryContract> {
  const rows = await db.$queryRawUnsafe<OrdinaryContract[]>(`SELECT
    (SELECT count(*) FROM events WHERE id = '${EVENT_ID}') AS events,
    (SELECT count(*) FROM alerts WHERE id = '${ALERT_ID}') AS alerts,
    (SELECT count(*) FROM dashboard_receipt_history WHERE id = '${RECEIPT_ID}') AS receipts,
    (SELECT count(*) FROM media_clips WHERE id = '${CLIP_ID}') AS clips,
    (SELECT count(*) FROM event_media_bindings WHERE event_id = '${EVENT_ID}') AS bindings,
    (SELECT jsonb_agg(jsonb_build_object('table', c.relname, 'rls', c.relrowsecurity, 'force', c.relforcerowsecurity) ORDER BY c.relname) FROM pg_class c WHERE c.oid IN ('public.events'::regclass, 'public.alerts'::regclass)) AS rls,
    (SELECT jsonb_agg(jsonb_build_object('name', conname, 'definition', pg_get_constraintdef(oid)) ORDER BY conname) FROM pg_constraint WHERE conrelid IN ('public.events'::regclass, 'public.alerts'::regclass) AND conname <> 'events_facility_id_validation_run_id_fkey') AS foreign_keys,
    has_table_privilege('fall_app', 'public.events', 'SELECT') AS event_select,
    has_table_privilege('fall_app', 'public.events', 'INSERT') AS event_insert,
    has_table_privilege('fall_app', 'public.events', 'UPDATE') AS event_update,
    has_table_privilege('fall_app', 'public.events', 'DELETE') AS event_delete,
    has_table_privilege('fall_app', 'public.alerts', 'SELECT') AS alert_select,
    has_table_privilege('fall_app', 'public.alerts', 'INSERT') AS alert_insert`);
  const row = rows.at(0);
  if (!row) throw new Error('ordinary contract query returned no row');
  return row;
}

async function retiredHistoryCounts(db: PrismaClient) {
  const rows = await db.$queryRawUnsafe<RetiredHistoryCounts[]>(`SELECT
    (SELECT count(*) FROM edge_admin_operations WHERE operation_type = 'VALIDATION_RUN') AS "createOperations",
    (SELECT count(*) FROM edge_admin_operations WHERE operation_type = 'VALIDATION_RUN_CLOSE') AS "closeOperations",
    (SELECT count(*) FROM edge_provisioning_audit_history WHERE action = 'VALIDATION_RUN_CREATED') AS "createdAudits",
    (SELECT count(*) FROM edge_provisioning_audit_history WHERE action = 'VALIDATION_RUN_CLOSED') AS "closedAudits"`);
  const row = rows.at(0);
  if (!row) throw new Error('retired history query returned no row');
  return row;
}

async function preservedHistoryCounts(db: PrismaClient) {
  const rows = await db.$queryRawUnsafe<PreservedHistoryCounts[]>(`SELECT
    (SELECT count(*) FROM edge_admin_operations WHERE operation_type = 'ISSUE') AS "issueOperations",
    (SELECT count(*) FROM edge_admin_operations WHERE operation_type = 'OWNERSHIP_TRANSFER') AS "transferOperations",
    (SELECT count(*) FROM edge_provisioning_audit_history WHERE action = 'CREDENTIAL_ISSUED') AS "issueAudits",
    (SELECT count(*) FROM edge_provisioning_audit_history WHERE action = 'INSTALLATION_REPLACED') AS "replacementAudits",
    (SELECT count(*) FROM edge_provisioning_audit_history WHERE action = 'OWNERSHIP_TRANSFERRED') AS "transferAudits",
    (SELECT count(*) FROM edge_provisioning_audit_history WHERE action = 'TOPOLOGY_APPLIED') AS "topologyAudits"`);
  const row = rows.at(0);
  if (!row) throw new Error('preserved history query returned no row');
  return row;
}

async function expectFinalObjectsPresent(db: PrismaClient): Promise<void> {
  const rows = await db.$queryRawUnsafe<FinalContract[]>(finalContractSql());
  expect(rows).toEqual([
    {
      grant_table_absent: false,
      event_column_absent: false,
      event_index_absent: false,
      event_fk_absent: false,
      grant_enum_absent: false,
      purge_role_absent: false,
    },
  ]);
}

async function expectFinalObjectsAbsent(db: PrismaClient): Promise<void> {
  const rows = await db.$queryRawUnsafe<FinalContract[]>(finalContractSql());
  expect(rows).toEqual([
    {
      grant_table_absent: true,
      event_column_absent: true,
      event_index_absent: true,
      event_fk_absent: true,
      grant_enum_absent: true,
      purge_role_absent: true,
    },
  ]);
}

function finalContractSql(): string {
  return `SELECT
    to_regclass('public.edge_validation_grants') IS NULL AS grant_table_absent,
    NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'validation_run_id') AS event_column_absent,
    to_regclass('public.events_facility_id_validation_run_id_idx') IS NULL AS event_index_absent,
    NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_facility_id_validation_run_id_fkey') AS event_fk_absent,
    NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EdgeValidationGrantStatus') AS grant_enum_absent,
    NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'system_test_purge_owner') AS purge_role_absent`;
}

type OrdinaryContract = {
  events: bigint;
  alerts: bigint;
  receipts: bigint;
  clips: bigint;
  bindings: bigint;
  rls: unknown;
  foreign_keys: unknown;
  event_select: boolean;
  event_insert: boolean;
  event_update: boolean;
  event_delete: boolean;
  alert_select: boolean;
  alert_insert: boolean;
};
type RetiredHistoryCounts = {
  createOperations: bigint;
  closeOperations: bigint;
  createdAudits: bigint;
  closedAudits: bigint;
};
type PreservedHistoryCounts = {
  issueOperations: bigint;
  transferOperations: bigint;
  issueAudits: bigint;
  replacementAudits: bigint;
  transferAudits: bigint;
  topologyAudits: bigint;
};
type FinalContract = {
  grant_table_absent: boolean;
  event_column_absent: boolean;
  event_index_absent: boolean;
  event_fk_absent: boolean;
  grant_enum_absent: boolean;
  purge_role_absent: boolean;
};
