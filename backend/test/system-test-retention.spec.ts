import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
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
    const normal = await seedNormalEvent();
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
    await expect(
      admin.event.count({ where: { id: normal.eventId } }),
    ).resolves.toBe(1);

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

  async function seedNormalEvent(): Promise<FixtureIds> {
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
    return ids;
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
    await expect(
      runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', ${FACILITY_A}, true)`;
        await tx.$executeRawUnsafe('DELETE FROM events WHERE id = $1', eventId);
      }),
    ).rejects.toThrow();
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
