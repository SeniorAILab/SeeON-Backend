import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AlertWriterService } from '../src/alerts/alert-writer.service.js';
import { AlertsService } from '../src/alerts/alerts.service.js';
import { AppModule } from '../src/app.module.js';
import {
  JwtAuthGuard,
  type RequestWithAuth,
} from '../src/auth/jwt-auth.guard.js';
import { configureVersionedTestApp } from './helpers/versioned-app.js';

const FACILITY_A = 'system-test-retention-a';
const FACILITY_B = 'system-test-retention-b';
const USER_ID = 'system-test-retention-admin';
const INSTALLATION_A = 'a1100000-0000-4000-8000-000000000001';
const INSTALLATION_B = 'b1100000-0000-4000-8000-000000000001';
const GRANT_A = 'a2200000-0000-7000-8000-000000000001';
const ACTIVE_GRANT_A = 'a2200000-0000-7000-8000-000000000002';
const RUNTIME_GRANT_A = 'a2200000-0000-7000-8000-000000000003';
const UNREFERENCED_GRANT_A = 'a2200000-0000-7000-8000-000000000004';
const GRANT_B = 'b2200000-0000-7000-8000-000000000001';
const PURGE_PATH = '/api/v1/admin/system-test-retention/purge';
let sequence = 0;

class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithAuth>();
    req.user = {
      id: USER_ID,
      facilityId: null,
      role: Role.SUPER_ADMIN,
      email: 'retention-admin@example.invalid',
      nickname: 'Retention Admin',
      sessionVersion: 1,
    };
    return true;
  }
}

describe('SYSTEM_TEST audited retention purge', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let runtime: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DIRECT_URL || !process.env.DATABASE_URL) {
      throw new Error('DIRECT_URL and DATABASE_URL are required');
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(JwtAuthGuard)
      .useClass(SuperAdminGuard)
      .compile();
    app = moduleRef.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();
    admin = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
    runtime = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    await Promise.all([admin.$connect(), runtime.$connect()]);
  });

  beforeEach(async () => {
    await cleanup();
    await seedRoots();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await Promise.all([admin.$disconnect(), runtime.$disconnect()]);
  });

  it('purges only resolved, closed, expired SYSTEM_TEST rows and records one durable receipt', async () => {
    const expired = await seedSystemTest({
      facilityId: FACILITY_A,
      grantId: GRANT_A,
      retentionExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      status: 'RESOLVED',
      dependencies: true,
    });
    const unresolved = await seedSystemTest({
      facilityId: FACILITY_A,
      grantId: GRANT_A,
      retentionExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      status: 'NEW',
    });
    const beforeBoundary = await seedSystemTest({
      facilityId: FACILITY_A,
      grantId: GRANT_A,
      retentionExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      status: 'RESOLVED',
    });
    await admin.edgeValidationGrant.create({
      data: {
        id: ACTIVE_GRANT_A,
        facilityId: FACILITY_A,
        edgeInstallationId: INSTALLATION_A,
        enrollmentGeneration: 1,
        status: 'ACTIVE',
        capability: 'SYSTEM_TEST',
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    const openValidationRun = await seedSystemTest({
      facilityId: FACILITY_A,
      grantId: ACTIVE_GRANT_A,
      retentionExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      status: 'RESOLVED',
    });
    const normal = await seedNormalEvent({ alert: true });
    const otherFacility = await seedSystemTest({
      facilityId: FACILITY_B,
      grantId: GRANT_B,
      retentionExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      status: 'RESOLVED',
    });

    await expectArbitraryDeleteDenied(normal.eventId);

    const successfulJobId = jobId();
    const first = await purge(FACILITY_A, successfulJobId).expect(200);
    const firstBody = first.body as unknown as PurgeHttpResponse;
    expect(firstBody).toMatchObject({
      facilityId: FACILITY_A,
      purgedEvents: 1,
      purgedAlerts: 1,
      purgedDashboardReceipts: 1,
      purgedAlertNotes: 1,
      replayed: false,
    });
    expect(typeof firstBody.receiptId).toBe('string');
    expect(typeof firstBody.purgedAt).toBe('string');

    await expectRows(expired, false);
    await expectRows(unresolved, true);
    await expectRows(beforeBoundary, true);
    await expectRows(openValidationRun, true);
    await expectRows(otherFacility, true);
    await expectRows(normal, true);

    const audits = await purgeAudits(FACILITY_A);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      facility_id: FACILITY_A,
      purged_events: 1,
      purged_alerts: 1,
      purged_dashboard_receipts: 1,
      purged_alert_notes: 1,
    });

    const replay = await purge(FACILITY_A, successfulJobId).expect(200);
    const replayBody = replay.body as unknown as PurgeHttpResponse;
    expect(replayBody).toEqual({ ...firstBody, replayed: true });
    await expect(purgeAudits(FACILITY_A)).resolves.toHaveLength(1);

    const second = await purge(FACILITY_A, jobId()).expect(200);
    expect(second.body as unknown as PurgeHttpResponse).toMatchObject({
      facilityId: FACILITY_A,
      receiptId: null,
      purgedEvents: 0,
      purgedAlerts: 0,
      purgedDashboardReceipts: 0,
      purgedAlertNotes: 0,
      purgedAt: null,
      replayed: false,
    });
    await expect(purgeAudits(FACILITY_A)).resolves.toHaveLength(1);
    await expect(
      runtime.$queryRawUnsafe('SELECT * FROM system_test_purge_audit_history'),
    ).rejects.toThrow();
  });

  it('denies direct Alert and dependent-table retention bypasses as fall_app', async () => {
    const normal = await seedNormalEvent({ alert: true });
    const systemTest = await seedSystemTest({
      facilityId: FACILITY_A,
      grantId: GRANT_A,
      retentionExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      status: 'RESOLVED',
      dependencies: true,
    });

    await expectRoleStatementDenied(
      'DELETE FROM public.alerts WHERE id = $1',
      normal.alertId,
    );
    await expectRoleStatementDenied(
      'DELETE FROM public.alerts WHERE id = $1',
      systemTest.alertId,
    );
    await expectRoleStatementDenied(
      "UPDATE public.alerts SET type = 'fall' WHERE id = $1",
      systemTest.alertId,
    );
    await expectRoleStatementDenied(
      "UPDATE public.alert_notes SET note = 'bypassed' WHERE id = $1",
      systemTest.noteId,
    );
    await expectRoleStatementDenied(
      'DELETE FROM public.alert_notes WHERE id = $1',
      systemTest.noteId,
    );
    await expectRoleStatementDenied(
      "UPDATE public.dashboard_receipt_history SET surface = 'bypassed' WHERE id = $1",
      systemTest.receiptId,
    );
    await expectRoleStatementDenied(
      'DELETE FROM public.dashboard_receipt_history WHERE id = $1',
      systemTest.receiptId,
    );
    await expectRoleStatementDenied(
      'UPDATE public.event_media_bindings SET ordinal = ordinal WHERE false',
    );
    await expectRoleStatementDenied(
      'DELETE FROM public.event_media_bindings WHERE false',
    );

    await expectRows(normal, true);
    await expectRows(systemTest, true);
    await expect(
      admin.alertNote.findUniqueOrThrow({ where: { id: systemTest.noteId } }),
    ).resolves.toMatchObject({ note: 'purge dependency only' });
    await expect(
      admin.dashboardReceipt.findUniqueOrThrow({
        where: { id: systemTest.receiptId },
      }),
    ).resolves.toMatchObject({ surface: 'normalized-feed' });
  });

  it('preserves normal runtime Alert insert, ack, resolve, snapshot update, and read', async () => {
    const normal = await seedNormalEvent();
    const writer = app.get(AlertWriterService);
    const alerts = app.get(AlertsService);

    const created = await writer.writeAlert({
      facilityId: FACILITY_A,
      cameraId: normal.cameraId,
      spaceId: normal.spaceId,
      type: 'fall',
      probability: 0.91,
      snapshotKey: null,
      detectedAt: new Date('2026-01-01T00:00:00.000Z'),
      idempotencyKey: normal.alertId,
      originEventId: normal.eventId,
    });
    expect(created.created).toBe(true);

    const acked = await writer.ackAlert({
      facilityId: FACILITY_A,
      alertId: created.id,
      actorUserId: USER_ID,
    });
    expect(acked).toMatchObject({ status: 'ACKED', ackedById: USER_ID });

    await alerts.setSnapshotKey(
      FACILITY_A,
      created.id,
      'normal-runtime-snapshot.jpg',
    );
    const resolved = await writer.resolveAlert({
      facilityId: FACILITY_A,
      alertId: created.id,
      actorUserId: USER_ID,
    });
    expect(resolved).toMatchObject({
      status: 'RESOLVED',
      resolvedById: USER_ID,
    });
    await expect(alerts.getOne(FACILITY_A, created.id)).resolves.toMatchObject({
      id: created.id,
      status: 'RESOLVED',
      snapshotKey: 'normal-runtime-snapshot.jpg',
    });
  });

  it('preserves runtime grant create, read, and lifecycle-only close', async () => {
    const closedAt = new Date('2026-01-01T00:05:00.000Z');
    const result = await runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.facility_id', ${FACILITY_A}, true)`;
      await tx.edgeValidationGrant.create({
        data: {
          id: RUNTIME_GRANT_A,
          facilityId: FACILITY_A,
          edgeInstallationId: INSTALLATION_A,
          enrollmentGeneration: 1,
          capability: 'SYSTEM_TEST',
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        },
      });
      const created = await tx.edgeValidationGrant.findUniqueOrThrow({
        where: { id: RUNTIME_GRANT_A },
      });
      const closed = await tx.edgeValidationGrant.update({
        where: { id: RUNTIME_GRANT_A },
        data: { status: 'CLOSED', closedAt },
      });
      return { created, closed };
    });

    expect(result.created).toMatchObject({
      id: RUNTIME_GRANT_A,
      facilityId: FACILITY_A,
      status: 'ACTIVE',
      closedAt: null,
    });
    expect(result.closed).toMatchObject({
      id: RUNTIME_GRANT_A,
      facilityId: FACILITY_A,
      status: 'CLOSED',
      closedAt,
    });
  });

  it('denies immutable grant updates and referenced or unreferenced grant deletes as fall_app', async () => {
    const referenced = await seedSystemTest({
      facilityId: FACILITY_A,
      grantId: GRANT_A,
      retentionExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      status: 'NEW',
    });
    await admin.edgeValidationGrant.create({
      data: {
        id: UNREFERENCED_GRANT_A,
        facilityId: FACILITY_A,
        edgeInstallationId: INSTALLATION_A,
        enrollmentGeneration: 1,
        status: 'ACTIVE',
        capability: 'SYSTEM_TEST',
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    const before = await admin.edgeValidationGrant.findUniqueOrThrow({
      where: { id: UNREFERENCED_GRANT_A },
    });

    await expectRoleStatementDenied(
      'UPDATE public.edge_validation_grants SET capability = NULL WHERE id = $1::uuid',
      UNREFERENCED_GRANT_A,
    );
    await expectRoleStatementDenied(
      "UPDATE public.edge_validation_grants SET expires_at = TIMESTAMP '2100-01-01 00:00:00' WHERE id = $1::uuid",
      UNREFERENCED_GRANT_A,
    );
    await expectRoleStatementDenied(
      'UPDATE public.edge_validation_grants SET facility_id = facility_id WHERE id = $1::uuid',
      UNREFERENCED_GRANT_A,
    );
    await expectRoleStatementDenied(
      'UPDATE public.edge_validation_grants SET edge_installation_id = edge_installation_id WHERE id = $1::uuid',
      UNREFERENCED_GRANT_A,
    );
    await expectRoleStatementDenied(
      'UPDATE public.edge_validation_grants SET enrollment_generation = enrollment_generation WHERE id = $1::uuid',
      UNREFERENCED_GRANT_A,
    );
    await expectRoleStatementDenied(
      'UPDATE public.edge_validation_grants SET created_at = created_at WHERE id = $1::uuid',
      UNREFERENCED_GRANT_A,
    );
    await expectRoleStatementDenied(
      'UPDATE public.edge_validation_grants SET id = id WHERE id = $1::uuid',
      UNREFERENCED_GRANT_A,
    );
    await expectRoleStatementDenied(
      'DELETE FROM public.edge_validation_grants WHERE id = $1::uuid',
      GRANT_A,
    );
    await expectRoleStatementDenied(
      'DELETE FROM public.edge_validation_grants WHERE id = $1::uuid',
      UNREFERENCED_GRANT_A,
    );

    await expectRows(referenced, true);
    await expect(
      admin.edgeValidationGrant.findUniqueOrThrow({
        where: { id: UNREFERENCED_GRANT_A },
      }),
    ).resolves.toEqual(before);
    const grantColumns = await admin.$queryRawUnsafe<
      { column_name: string }[]
    >(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'edge_validation_grants'
      ORDER BY ordinal_position
    `);
    expect(grantColumns.map((row) => row.column_name)).toEqual([
      'id',
      'facility_id',
      'edge_installation_id',
      'enrollment_generation',
      'status',
      'created_at',
      'expires_at',
      'closed_at',
      'capability',
    ]);
  });

  it('pins the runtime table, column, function-owner, and execute privilege matrix', async () => {
    const tablePrivileges = await admin.$queryRawUnsafe<TablePrivilegeRow[]>(`
      SELECT table_name, privilege_type
      FROM information_schema.table_privileges
      WHERE grantee = 'fall_app'
        AND table_schema = 'public'
        AND table_name IN (
          'alerts',
          'alert_notes',
          'dashboard_receipt_history',
          'events',
          'event_media_bindings',
          'edge_validation_grants',
          'system_test_purge_audit_history'
        )
      ORDER BY table_name, privilege_type
    `);
    expect(tablePrivileges).toEqual([
      { table_name: 'alert_notes', privilege_type: 'INSERT' },
      { table_name: 'alert_notes', privilege_type: 'SELECT' },
      { table_name: 'alerts', privilege_type: 'INSERT' },
      { table_name: 'alerts', privilege_type: 'SELECT' },
      { table_name: 'dashboard_receipt_history', privilege_type: 'INSERT' },
      { table_name: 'dashboard_receipt_history', privilege_type: 'SELECT' },
      { table_name: 'edge_validation_grants', privilege_type: 'INSERT' },
      { table_name: 'edge_validation_grants', privilege_type: 'SELECT' },
      { table_name: 'event_media_bindings', privilege_type: 'INSERT' },
      { table_name: 'event_media_bindings', privilege_type: 'SELECT' },
      { table_name: 'events', privilege_type: 'INSERT' },
      { table_name: 'events', privilege_type: 'SELECT' },
    ]);

    const ownerPrivileges = await admin.$queryRawUnsafe<TablePrivilegeRow[]>(`
      SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'system_test_purge_owner'
        AND table_schema = 'public'
      ORDER BY table_name, privilege_type
    `);
    expect(ownerPrivileges).toEqual([
      { table_name: 'alert_notes', privilege_type: 'DELETE' },
      { table_name: 'alert_notes', privilege_type: 'SELECT' },
      { table_name: 'alerts', privilege_type: 'DELETE' },
      { table_name: 'alerts', privilege_type: 'SELECT' },
      { table_name: 'alerts', privilege_type: 'UPDATE' },
      {
        table_name: 'dashboard_receipt_history',
        privilege_type: 'DELETE',
      },
      {
        table_name: 'dashboard_receipt_history',
        privilege_type: 'SELECT',
      },
      { table_name: 'edge_validation_grants', privilege_type: 'SELECT' },
      { table_name: 'edge_validation_grants', privilege_type: 'UPDATE' },
      { table_name: 'events', privilege_type: 'DELETE' },
      { table_name: 'events', privilege_type: 'SELECT' },
      { table_name: 'events', privilege_type: 'UPDATE' },
      {
        table_name: 'system_test_purge_audit_history',
        privilege_type: 'INSERT',
      },
      {
        table_name: 'system_test_purge_audit_history',
        privilege_type: 'SELECT',
      },
    ]);

    const updateColumns = await admin.$queryRawUnsafe<ColumnPrivilegeRow[]>(`
      SELECT table_name, column_name
      FROM information_schema.column_privileges
      WHERE grantee = 'fall_app'
        AND table_schema = 'public'
        AND privilege_type = 'UPDATE'
        AND table_name IN (
          'alerts',
          'alert_notes',
          'dashboard_receipt_history',
          'events',
          'event_media_bindings',
          'edge_validation_grants',
          'system_test_purge_audit_history'
        )
      ORDER BY table_name, column_name
    `);
    expect(updateColumns).toEqual([
      { table_name: 'alerts', column_name: 'acked_at' },
      { table_name: 'alerts', column_name: 'acked_by_id' },
      { table_name: 'alerts', column_name: 'resolved_at' },
      { table_name: 'alerts', column_name: 'resolved_by_id' },
      { table_name: 'alerts', column_name: 'snapshot_key' },
      { table_name: 'alerts', column_name: 'status' },
      { table_name: 'edge_validation_grants', column_name: 'closed_at' },
      { table_name: 'edge_validation_grants', column_name: 'status' },
    ]);

    const functionContract = await admin.$queryRawUnsafe<
      FunctionContractRow[]
    >(`
      SELECT
        owner_role.rolname AS owner_name,
        owner_role.rolcanlogin AS owner_can_login,
        owner_role.rolsuper AS owner_is_superuser,
        owner_role.rolbypassrls AS owner_bypasses_rls,
        owner_role.rolinherit AS owner_inherits,
        has_schema_privilege(
          'system_test_purge_owner',
          'public',
          'CREATE'
        ) AS owner_can_create_in_schema,
        function_row.prosecdef AS security_definer,
        function_row.proconfig AS function_config,
        has_function_privilege(
          'fall_app',
          'public.purge_expired_system_tests(text, uuid)',
          'EXECUTE'
        ) AS app_can_execute,
        EXISTS (
          SELECT 1
          FROM aclexplode(
            coalesce(
              function_row.proacl,
              acldefault('f', function_row.proowner)
            )
          ) AS function_acl
          WHERE function_acl.grantee = 0
            AND function_acl.privilege_type = 'EXECUTE'
        ) AS public_can_execute,
        pg_has_role(
          'fall_app',
          'system_test_purge_owner',
          'MEMBER'
        ) AS app_is_owner_member
      FROM pg_proc AS function_row
      JOIN pg_namespace AS function_schema
        ON function_schema.oid = function_row.pronamespace
      JOIN pg_roles AS owner_role
        ON owner_role.oid = function_row.proowner
      WHERE function_schema.nspname = 'public'
        AND function_row.proname = 'purge_expired_system_tests'
    `);
    const executePrivileges = await admin.$queryRawUnsafe<
      ExecutePrivilegeRow[]
    >(`
        SELECT grantor, grantee, privilege_type
        FROM information_schema.routine_privileges
        WHERE specific_schema = 'public'
          AND routine_name = 'purge_expired_system_tests'
        ORDER BY grantee, privilege_type
      `);
    expect(executePrivileges).toEqual([
      {
        grantor: 'system_test_purge_owner',
        grantee: 'fall_app',
        privilege_type: 'EXECUTE',
      },
      {
        grantor: 'system_test_purge_owner',
        grantee: 'system_test_purge_owner',
        privilege_type: 'EXECUTE',
      },
    ]);

    expect(functionContract).toEqual([
      {
        owner_name: 'system_test_purge_owner',
        owner_can_login: false,
        owner_is_superuser: false,
        owner_bypasses_rls: false,
        owner_inherits: false,
        owner_can_create_in_schema: false,
        security_definer: true,
        function_config: ['search_path=pg_catalog'],
        app_can_execute: true,
        public_can_execute: false,
        app_is_owner_member: false,
      },
    ]);
  });

  it('stores only qualified built-in calls and static public relations in the purge function', async () => {
    const [stored] = await admin.$queryRawUnsafe<FunctionDefinitionRow[]>(`
      SELECT pg_get_functiondef(function_row.oid) AS definition
      FROM pg_proc AS function_row
      JOIN pg_namespace AS function_schema
        ON function_schema.oid = function_row.pronamespace
      WHERE function_schema.nspname = 'public'
        AND function_row.proname = 'purge_expired_system_tests'
    `);
    expect(stored).toBeDefined();
    const definition = stored.definition;
    const builtIns = [
      'transaction_timestamp',
      'btrim',
      'current_setting',
      'pg_advisory_xact_lock',
      'hashtextextended',
      'coalesce',
      'array_agg',
      'cardinality',
    ];
    for (const builtIn of builtIns) {
      expect(definition).not.toMatch(
        new RegExp(`(?<![\\w.])${builtIn}\\s*\\(`, 'i'),
      );
    }
    for (const qualified of builtIns.filter(
      (builtIn) => builtIn !== 'coalesce',
    )) {
      expect(definition).toMatch(
        new RegExp(`pg_catalog\\.${qualified}\\s*\\(`, 'i'),
      );
    }
    expect(definition).not.toMatch(/\bEXECUTE\b/i);
    for (const relation of [
      'system_test_purge_audit_history',
      'events',
      'alerts',
      'edge_validation_grants',
      'dashboard_receipt_history',
      'alert_notes',
    ]) {
      expect(definition).not.toMatch(
        new RegExp(`(?<![\\w.])${relation}\\b`, 'i'),
      );
      expect(definition).toMatch(new RegExp(`public\\.${relation}\\b`, 'i'));
    }
  });

  it('rejects malformed facility scope before invoking the purge', async () => {
    await purge('   ', jobId()).expect(400);
    await expect(purgeAudits(FACILITY_A)).resolves.toHaveLength(0);
    await expect(purgeAudits(FACILITY_B)).resolves.toHaveLength(0);
  });

  it('grants the runtime role only function execution and enforces facility context', async () => {
    const privileges = await admin.$queryRawUnsafe<PrivilegeRow[]>(`
      SELECT
        has_function_privilege(
          'fall_app',
          'public.purge_expired_system_tests(text, uuid)',
          'EXECUTE'
        ) AS can_execute,
        has_table_privilege('fall_app', 'public.events', 'DELETE') AS can_delete_events,
        has_table_privilege(
          'fall_app',
          'public.system_test_purge_audit_history',
          'SELECT, INSERT, UPDATE, DELETE'
        ) AS can_access_audit
    `);
    expect(privileges).toEqual([
      {
        can_execute: true,
        can_delete_events: false,
        can_access_audit: false,
      },
    ]);

    await expect(
      runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', ${FACILITY_A}, true)`;
        await tx.$queryRawUnsafe(
          'SELECT * FROM public.purge_expired_system_tests($1, $2::uuid)',
          FACILITY_B,
          jobId(),
        );
      }),
    ).rejects.toThrow('facility context mismatch');
  });

  it('uses database transaction time with an inclusive exact expiry boundary', async () => {
    const ids = nextIds(FACILITY_A);
    const result = await runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.facility_id', ${FACILITY_A}, true)`;
      await tx.$executeRawUnsafe(
        `INSERT INTO events
          (id, facility_id, camera_id, space_id, type, confidence, detected_at,
           created_at, modified_at, dedup_key, edge_event_id, validation_run_id,
           retention_expires_at)
         VALUES ($1, $2, NULL, NULL, 'SYSTEM_TEST', NULL, transaction_timestamp(),
           transaction_timestamp(), transaction_timestamp(), $3, $4::uuid, $5::uuid,
           transaction_timestamp())`,
        ids.eventId,
        FACILITY_A,
        ids.eventId,
        ids.edgeEventId,
        GRANT_A,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO alerts
          (id, facility_id, camera_id, space_id, type, probability, snapshot_key,
           detected_at, status, idempotency_key, origin_event_id, resolved_at)
         VALUES ($1, $2, NULL, NULL, 'SYSTEM_TEST', NULL, NULL,
           transaction_timestamp(), 'RESOLVED', $3, $4, transaction_timestamp())`,
        ids.alertId,
        FACILITY_A,
        ids.alertId,
        ids.eventId,
      );
      return tx.$queryRawUnsafe<PurgeResult[]>(
        'SELECT * FROM purge_expired_system_tests($1, $2::uuid)',
        FACILITY_A,
        jobId(),
      );
    });

    expect(result).toHaveLength(1);
    expect(Number(result[0].purged_events)).toBe(1);
    await expectRows(ids, false);
  });

  it('retains a row strictly before its boundary without sleeping', async () => {
    const ids = nextIds(FACILITY_A);
    const result = await runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.facility_id', ${FACILITY_A}, true)`;
      await tx.$executeRawUnsafe(
        `INSERT INTO events
          (id, facility_id, camera_id, space_id, type, confidence, detected_at,
           created_at, modified_at, dedup_key, edge_event_id, validation_run_id,
           retention_expires_at)
         VALUES ($1, $2, NULL, NULL, 'SYSTEM_TEST', NULL, transaction_timestamp(),
           transaction_timestamp(), transaction_timestamp(), $3, $4::uuid, $5::uuid,
           transaction_timestamp() + interval '1 millisecond')`,
        ids.eventId,
        FACILITY_A,
        ids.eventId,
        ids.edgeEventId,
        GRANT_A,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO alerts
          (id, facility_id, camera_id, space_id, type, probability, snapshot_key,
           detected_at, status, idempotency_key, origin_event_id, resolved_at)
         VALUES ($1, $2, NULL, NULL, 'SYSTEM_TEST', NULL, NULL,
           transaction_timestamp(), 'RESOLVED', $3, $4, transaction_timestamp())`,
        ids.alertId,
        FACILITY_A,
        ids.alertId,
        ids.eventId,
      );
      return tx.$queryRawUnsafe<PurgeResult[]>(
        'SELECT * FROM purge_expired_system_tests($1, $2::uuid)',
        FACILITY_A,
        jobId(),
      );
    });

    expect(Number(result[0].purged_events)).toBe(0);
    await expectRows(ids, true);
  });

  it('serializes concurrent facility jobs and never double-counts or double-audits', async () => {
    await seedSystemTest({
      facilityId: FACILITY_A,
      grantId: GRANT_A,
      retentionExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      status: 'RESOLVED',
    });

    const responses = await Promise.all([
      purge(FACILITY_A, jobId()).expect(200),
      purge(FACILITY_A, jobId()).expect(200),
    ]);
    expect(
      responses
        .map(
          (value) => (value.body as unknown as PurgeHttpResponse).purgedEvents,
        )
        .sort(),
    ).toEqual([0, 1]);
    await expect(purgeAudits(FACILITY_A)).resolves.toHaveLength(1);
  });

  it('rolls all deletes back when durable audit insertion fails', async () => {
    const candidate = await seedSystemTest({
      facilityId: FACILITY_A,
      grantId: GRANT_A,
      retentionExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      status: 'RESOLVED',
      dependencies: true,
    });
    await admin.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_system_test_purge_audit_for_test()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced audit failure'; END $$
    `);
    await admin.$executeRawUnsafe(`
      CREATE TRIGGER fail_system_test_purge_audit_for_test
      BEFORE INSERT ON system_test_purge_audit_history
      FOR EACH ROW EXECUTE FUNCTION fail_system_test_purge_audit_for_test()
    `);
    try {
      await purge(FACILITY_A, jobId()).expect(500);
      await expectRows(candidate, true);
      await expect(purgeAudits(FACILITY_A)).resolves.toHaveLength(0);
    } finally {
      await admin.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS fail_system_test_purge_audit_for_test
          ON system_test_purge_audit_history
      `);
      await admin.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS fail_system_test_purge_audit_for_test()',
      );
    }
  });

  function purge(facilityId: string, idempotencyKey: string) {
    return request(app.getHttpServer())
      .post(PURGE_PATH)
      .set('Idempotency-Key', idempotencyKey)
      .send({ schemaVersion: 1, facilityId });
  }

  async function seedRoots(): Promise<void> {
    await admin.user.create({
      data: {
        id: USER_ID,
        email: 'retention-admin@example.invalid',
        nickname: 'Retention Admin',
        role: Role.SUPER_ADMIN,
      },
    });
    await admin.facility.createMany({
      data: [
        { id: FACILITY_A, name: 'Retention A' },
        { id: FACILITY_B, name: 'Retention B' },
      ],
    });
    await seedGrant(FACILITY_A, INSTALLATION_A, GRANT_A);
    await seedGrant(FACILITY_B, INSTALLATION_B, GRANT_B);
  }

  async function seedGrant(
    facilityId: string,
    installationId: string,
    grantId: string,
  ): Promise<void> {
    await admin.edgeInstallation.create({
      data: {
        id: installationId,
        facilityId,
        generations: {
          create: { generation: 1, state: 'CLAIMED' },
        },
      },
    });
    await admin.edgeValidationGrant.create({
      data: {
        id: grantId,
        facilityId,
        edgeInstallationId: installationId,
        enrollmentGeneration: 1,
        status: 'CLOSED',
        capability: 'SYSTEM_TEST',
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        closedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
  }

  async function seedSystemTest(input: {
    facilityId: string;
    grantId: string;
    retentionExpiresAt: Date;
    status: 'NEW' | 'RESOLVED';
    dependencies?: boolean;
  }): Promise<FixtureIds> {
    const ids = nextIds(input.facilityId);
    await admin.event.create({
      data: {
        id: ids.eventId,
        facilityId: input.facilityId,
        cameraId: null,
        spaceId: null,
        type: 'SYSTEM_TEST',
        confidence: null,
        detectedAt: new Date('2026-01-01T00:00:00.000Z'),
        dedupKey: ids.eventId,
        edgeEventId: ids.edgeEventId,
        validationRunId: input.grantId,
        retentionExpiresAt: input.retentionExpiresAt,
      },
    });
    const alert = await admin.alert.create({
      data: {
        id: ids.alertId,
        facilityId: input.facilityId,
        cameraId: null,
        spaceId: null,
        type: 'SYSTEM_TEST',
        probability: null,
        snapshotKey: null,
        detectedAt: new Date('2026-01-01T00:00:00.000Z'),
        status: input.status,
        idempotencyKey: ids.alertId,
        originEventId: ids.eventId,
        resolvedAt:
          input.status === 'RESOLVED'
            ? new Date('2026-01-01T00:01:00.000Z')
            : null,
      },
    });
    if (input.dependencies) {
      await admin.alertNote.create({
        data: {
          id: ids.noteId,
          facilityId: input.facilityId,
          alertId: ids.alertId,
          note: 'purge dependency only',
          authorRole: Role.STAFF,
        },
      });
      await admin.dashboardReceipt.create({
        data: {
          id: ids.receiptId,
          facilityId: input.facilityId,
          dashboardClientId: 'retention-contract',
          kind: 'DELIVERY',
          backendEventId: ids.eventId,
          alertId: ids.alertId,
          alertSeq: alert.alertSeq,
          surface: 'normalized-feed',
          observedAt: new Date('2026-01-01T00:00:01.000Z'),
        },
      });
    }
    return ids;
  }

  async function seedNormalEvent(
    input: { alert?: boolean } = {},
  ): Promise<NormalFixtureIds> {
    const ids = nextIds(FACILITY_A);
    const floorId = `${ids.eventId}-floor`;
    const spaceId = `${ids.eventId}-space`;
    const cameraId = `${ids.eventId}-camera`;
    await admin.floor.create({
      data: {
        id: floorId,
        facilityId: FACILITY_A,
        name: floorId,
        orderIndex: 1,
      },
    });
    await admin.space.create({
      data: {
        id: spaceId,
        facilityId: FACILITY_A,
        floorId,
        name: spaceId,
        type: 'ROOM',
        capacity: 1,
      },
    });
    await admin.camera.create({
      data: { id: cameraId, facilityId: FACILITY_A, spaceId, label: cameraId },
    });
    await admin.event.create({
      data: {
        id: ids.eventId,
        facilityId: FACILITY_A,
        cameraId,
        spaceId,
        type: 'fall',
        detectedAt: new Date('2026-01-01T00:00:00.000Z'),
        dedupKey: ids.eventId,
        edgeEventId: ids.edgeEventId,
      },
    });
    if (input.alert === true) {
      await admin.alert.create({
        data: {
          id: ids.alertId,
          facilityId: FACILITY_A,
          cameraId,
          spaceId,
          type: 'fall',
          probability: 0.91,
          detectedAt: new Date('2026-01-01T00:00:00.000Z'),
          status: 'NEW',
          idempotencyKey: ids.alertId,
          originEventId: ids.eventId,
        },
      });
    }
    return { ...ids, cameraId, spaceId };
  }

  async function expectRows(ids: FixtureIds, present: boolean): Promise<void> {
    await expect(
      admin.event.count({ where: { id: ids.eventId } }),
    ).resolves.toBe(present ? 1 : 0);
    await expect(
      admin.alert.count({ where: { id: ids.alertId } }),
    ).resolves.toBe(present ? 1 : 0);
  }

  async function expectArbitraryDeleteDenied(eventId: string): Promise<void> {
    await expectRoleStatementDenied(
      'DELETE FROM public.events WHERE id = $1',
      eventId,
    );
  }

  async function expectRoleStatementDenied(
    statement: string,
    ...parameters: unknown[]
  ): Promise<void> {
    await expect(
      admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE fall_app');
        await tx.$executeRaw`SELECT set_config('app.facility_id', ${FACILITY_A}, true)`;
        await tx.$executeRawUnsafe(statement, ...parameters);
      }),
    ).rejects.toThrow(/permission denied|privilege/i);
  }

  async function purgeAudits(facilityId: string): Promise<PurgeAudit[]> {
    return admin.$queryRawUnsafe<PurgeAudit[]>(
      `SELECT facility_id, purged_events, purged_alerts,
              purged_dashboard_receipts, purged_alert_notes
       FROM system_test_purge_audit_history
       WHERE facility_id = $1 ORDER BY purged_at, receipt_id`,
      facilityId,
    );
  }

  async function cleanup(): Promise<void> {
    await admin.$executeRawUnsafe(`
      DO $$ BEGIN
        IF to_regclass('public.system_test_purge_audit_history') IS NOT NULL THEN
          DELETE FROM system_test_purge_audit_history
          WHERE facility_id IN ('${FACILITY_A}', '${FACILITY_B}');
        END IF;
      END $$;
    `);
    await admin.dashboardReceipt.deleteMany({
      where: { facilityId: { in: [FACILITY_A, FACILITY_B] } },
    });
    await admin.alertNote.deleteMany({
      where: { facilityId: { in: [FACILITY_A, FACILITY_B] } },
    });
    await admin.alert.deleteMany({
      where: { facilityId: { in: [FACILITY_A, FACILITY_B] } },
    });
    await admin.event.deleteMany({
      where: { facilityId: { in: [FACILITY_A, FACILITY_B] } },
    });
    await admin.camera.deleteMany({
      where: { facilityId: { in: [FACILITY_A, FACILITY_B] } },
    });
    await admin.space.deleteMany({
      where: { facilityId: { in: [FACILITY_A, FACILITY_B] } },
    });
    await admin.floor.deleteMany({
      where: { facilityId: { in: [FACILITY_A, FACILITY_B] } },
    });
    await admin.edgeValidationGrant.deleteMany({
      where: { facilityId: { in: [FACILITY_A, FACILITY_B] } },
    });
    await admin.edgeInstallation.deleteMany({
      where: { facilityId: { in: [FACILITY_A, FACILITY_B] } },
    });
    await admin.user.deleteMany({ where: { id: USER_ID } });
    await admin.facility.deleteMany({
      where: { id: { in: [FACILITY_A, FACILITY_B] } },
    });
  }
});

function nextIds(facilityId: string): FixtureIds {
  sequence += 1;
  const suffix = sequence.toString(16).padStart(12, '0');
  return {
    eventId: `${facilityId}-event-${sequence}`,
    alertId: `${facilityId}-alert-${sequence}`,
    noteId: `${facilityId}-note-${sequence}`,
    receiptId: `${facilityId}-receipt-${sequence}`,
    edgeEventId: `8b0f5ba2-d359-4d8e-948f-${suffix}`,
  };
}

function jobId(): string {
  sequence += 1;
  return `0197f671-3a31-7a6c-a6e4-${sequence.toString(16).padStart(12, '0')}`;
}

type FixtureIds = {
  eventId: string;
  alertId: string;
  noteId: string;
  receiptId: string;
  edgeEventId: string;
};

type NormalFixtureIds = FixtureIds & {
  cameraId: string;
  spaceId: string;
};

type PurgeResult = {
  purged_events: bigint;
};

type PurgeAudit = {
  facility_id: string;
  purged_events: number;
  purged_alerts: number;
  purged_dashboard_receipts: number;
  purged_alert_notes: number;
};

type PurgeHttpResponse = {
  schemaVersion: 1;
  receiptId: string | null;
  jobId: string;
  facilityId: string;
  purgedEvents: number;
  purgedAlerts: number;
  purgedDashboardReceipts: number;
  purgedAlertNotes: number;
  purgedAt: string | null;
  replayed: boolean;
};

type PrivilegeRow = {
  can_execute: boolean;
  can_delete_events: boolean;
  can_access_audit: boolean;
};

type TablePrivilegeRow = {
  table_name: string;
  privilege_type: string;
};

type ColumnPrivilegeRow = {
  table_name: string;
  column_name: string;
};

type ExecutePrivilegeRow = {
  grantor: string;
  grantee: string;
  privilege_type: string;
};

type FunctionDefinitionRow = {
  definition: string;
};

type FunctionContractRow = {
  owner_name: string;
  owner_can_login: boolean;
  owner_is_superuser: boolean;
  owner_bypasses_rls: boolean;
  owner_inherits: boolean;
  owner_can_create_in_schema: boolean;
  security_definer: boolean;
  function_config: string[];
  app_can_execute: boolean;
  public_can_execute: boolean;
  app_is_owner_member: boolean;
};
