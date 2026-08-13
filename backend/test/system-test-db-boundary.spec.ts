import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const MIGRATION_PATH = join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260813030000_system_test_media_boundary',
  'migration.sql',
);
const MIGRATION_SQL = existsSync(MIGRATION_PATH)
  ? readFileSync(MIGRATION_PATH, 'utf8')
  : '';
const MEMBERSHIP_GATE_START =
  '-- system_test_purge_owner membership gate: begin';
const MEMBERSHIP_GATE_END = '-- system_test_purge_owner membership gate: end';

const FACILITY_ID = 'system-test-db-boundary-facility';
const FLOOR_ID = 'system-test-db-boundary-floor';
const SPACE_ID = 'system-test-db-boundary-space';
const CAMERA_ID = 'system-test-db-boundary-camera';
const INSTALLATION_ID = 'c1100000-0000-4000-8000-000000000001';
const GRANT_ID = 'c2200000-0000-7000-8000-000000000001';
const NORMAL_EVENT_ID = 'system-test-db-boundary-normal-event';
const SECOND_NORMAL_EVENT_ID = 'system-test-db-boundary-normal-event-2';
const SYSTEM_EVENT_ID = 'system-test-db-boundary-system-event';
const SYSTEM_ALERT_ID = 'system-test-db-boundary-system-alert';
const CLIP_ID = 'system-test-db-boundary-clip';
const EDGE_EVENT_ID = 'c3300000-0000-4000-8000-000000000001';
const JOB_ID = 'c4400000-0000-4000-8000-000000000001';

// allow: SIZE_OK -- focused real-Postgres migration contract and atomicity fixture.
describe('SYSTEM_TEST database media boundary', () => {
  let admin: PrismaClient;
  let runtime: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DIRECT_URL || !process.env.DATABASE_URL) {
      throw new Error('DIRECT_URL and DATABASE_URL are required');
    }
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
    await Promise.all([runtime.$disconnect(), admin.$disconnect()]);
  });

  it('allows ordinary app bindings and rejects SYSTEM_TEST binding inserts and relevant updates', async () => {
    await seedNormalEvent(NORMAL_EVENT_ID, 'normal-1');
    await seedNormalEvent(SECOND_NORMAL_EVENT_ID, 'normal-2');
    await seedSystemTest();
    await seedClip();

    await runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.facility_id', ${FACILITY_ID}, true)`;
      await tx.eventMediaBinding.create({
        data: {
          eventId: NORMAL_EVENT_ID,
          facilityId: FACILITY_ID,
          clipId: CLIP_ID,
          ordinal: 0,
        },
      });
    });
    await expect(
      admin.eventMediaBinding.findUnique({
        where: { eventId: NORMAL_EVENT_ID },
      }),
    ).resolves.toMatchObject({ clipId: CLIP_ID, ordinal: 0 });

    await expect(
      runtime.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', ${FACILITY_ID}, true)`;
        await tx.eventMediaBinding.create({
          data: {
            eventId: SYSTEM_EVENT_ID,
            facilityId: FACILITY_ID,
            clipId: CLIP_ID,
            ordinal: 1,
          },
        });
      }),
    ).rejects.toThrow('SYSTEM_TEST event media binding forbidden');

    await expect(
      admin.eventMediaBinding.create({
        data: {
          eventId: SYSTEM_EVENT_ID,
          facilityId: FACILITY_ID,
          clipId: CLIP_ID,
          ordinal: 1,
        },
      }),
    ).rejects.toThrow('SYSTEM_TEST event media binding forbidden');

    await expect(
      admin.$executeRawUnsafe(
        `UPDATE public.event_media_bindings
         SET event_id = $1, ordinal = 1
         WHERE event_id = $2`,
        SYSTEM_EVENT_ID,
        NORMAL_EVENT_ID,
      ),
    ).rejects.toThrow('SYSTEM_TEST event media binding forbidden');

    await expect(
      admin.eventMediaBinding.count({ where: { eventId: SYSTEM_EVENT_ID } }),
    ).resolves.toBe(0);
  });

  it('purges a controlled preexisting SYSTEM_TEST binding while preserving receipt semantics', async () => {
    await seedSystemTest();
    await seedClip();
    await insertPreexistingSystemTestBinding();

    const [result] = await purge();

    expect(result).toMatchObject({
      receipt_id: JOB_ID,
      job_id: JOB_ID,
      facility_id: FACILITY_ID,
      purged_events: 1,
      purged_alerts: 1,
      purged_dashboard_receipts: 0,
      purged_alert_notes: 0,
      replayed: false,
    });
    await expect(
      admin.eventMediaBinding.count({ where: { eventId: SYSTEM_EVENT_ID } }),
    ).resolves.toBe(0);
    await expect(
      admin.event.count({ where: { id: SYSTEM_EVENT_ID } }),
    ).resolves.toBe(0);
    await expect(
      admin.alert.count({ where: { id: SYSTEM_ALERT_ID } }),
    ).resolves.toBe(0);

    const audits = await admin.$queryRawUnsafe<AuditRow[]>(
      `SELECT purged_events, purged_alerts,
              purged_dashboard_receipts, purged_alert_notes
       FROM public.system_test_purge_audit_history
       WHERE job_id = $1::uuid`,
      JOB_ID,
    );
    expect(audits).toEqual([
      {
        purged_events: 1,
        purged_alerts: 1,
        purged_dashboard_receipts: 0,
        purged_alert_notes: 0,
      },
    ]);
  });

  it('rolls the binding and all parent deletes back when purge audit insertion fails', async () => {
    await seedSystemTest();
    await seedClip();
    await insertPreexistingSystemTestBinding();
    await admin.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION public.fail_system_test_media_purge_for_test()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced system test media purge failure';
      END
      $$
    `);
    await admin.$executeRawUnsafe(`
      CREATE TRIGGER fail_system_test_media_purge_for_test
      BEFORE INSERT ON public.system_test_purge_audit_history
      FOR EACH ROW
      EXECUTE FUNCTION public.fail_system_test_media_purge_for_test()
    `);

    try {
      await expect(purge()).rejects.toThrow(
        'forced system test media purge failure',
      );
      await expect(
        admin.eventMediaBinding.count({ where: { eventId: SYSTEM_EVENT_ID } }),
      ).resolves.toBe(1);
      await expect(
        admin.event.count({ where: { id: SYSTEM_EVENT_ID } }),
      ).resolves.toBe(1);
      await expect(
        admin.alert.count({ where: { id: SYSTEM_ALERT_ID } }),
      ).resolves.toBe(1);
      await expect(
        admin.systemTestPurgeAudit.count({ where: { jobId: JOB_ID } }),
      ).resolves.toBe(0);
    } finally {
      await admin.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS fail_system_test_media_purge_for_test
        ON public.system_test_purge_audit_history
      `);
      await admin.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS public.fail_system_test_media_purge_for_test()',
      );
    }
  });

  it('keeps the NOLOGIN purge owner isolated from every role membership', async () => {
    const memberships = await admin.$queryRawUnsafe<RoleMembershipRow[]>(`
      SELECT owner_role.rolname AS owner_name,
             member_role.rolname AS member_name,
             member_role.rolcanlogin AS member_can_login
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles AS member_role
        ON member_role.oid = membership.member
      WHERE owner_role.rolname = 'system_test_purge_owner'
         OR member_role.rolname = 'system_test_purge_owner'
      ORDER BY owner_role.rolname, member_role.rolname
    `);
    const [owner] = await admin.$queryRawUnsafe<PurgeOwnerRow[]>(`
      SELECT rolcanlogin AS can_login
      FROM pg_catalog.pg_roles
      WHERE rolname = 'system_test_purge_owner'
    `);

    const triggerFunctions = await admin.$queryRawUnsafe<
      TriggerFunctionContractRow[]
    >(`
        SELECT function_row.proname AS function_name,
               owner_role.rolname AS owner_name,
               function_row.prosecdef AS security_definer,
               function_row.proconfig AS function_config,
               pg_catalog.has_function_privilege(
                 'fall_app', function_row.oid, 'EXECUTE'
               ) AS app_can_execute,
               EXISTS (
                 SELECT 1
                 FROM pg_catalog.aclexplode(
                   coalesce(
                     function_row.proacl,
                     pg_catalog.acldefault('f', function_row.proowner)
                   )
                 ) AS function_acl
                 WHERE function_acl.grantee OPERATOR(pg_catalog.=) 0
                   AND function_acl.privilege_type
                         OPERATOR(pg_catalog.=) 'EXECUTE'
               ) AS public_can_execute
        FROM pg_catalog.pg_proc AS function_row
        JOIN pg_catalog.pg_namespace AS function_schema
          ON function_schema.oid = function_row.pronamespace
        JOIN pg_catalog.pg_roles AS owner_role
          ON owner_role.oid = function_row.proowner
        WHERE function_schema.nspname = 'public'
          AND function_row.proname IN (
            'reject_system_test_event_media_binding',
            'reject_system_test_event_with_media_binding'
          )
        ORDER BY function_row.proname
      `);

    expect(owner).toEqual({ can_login: false });
    expect(memberships).toEqual([]);
    expect(memberships.filter((row) => row.member_can_login)).toEqual([]);
    expect(triggerFunctions).toEqual([
      {
        function_name: 'reject_system_test_event_media_binding',
        owner_name: 'system_test_purge_owner',
        security_definer: true,
        function_config: ['search_path=pg_catalog'],
        app_can_execute: false,
        public_can_execute: false,
      },
      {
        function_name: 'reject_system_test_event_with_media_binding',
        owner_name: 'system_test_purge_owner',
        security_definer: true,
        function_config: ['search_path=pg_catalog'],
        app_can_execute: false,
        public_can_execute: false,
      },
    ]);
  });

  it('fails the migration rehearsal deterministically instead of revoking an existing membership', async () => {
    const membershipGate = migrationMembershipGate();

    await expect(
      admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('GRANT system_test_purge_owner TO fall_app');
        await tx.$executeRawUnsafe(membershipGate);
      }),
    ).rejects.toThrow(
      'system_test_purge_owner must have zero role memberships',
    );

    const memberships = await admin.$queryRawUnsafe<{ count: bigint }[]>(`
      SELECT pg_catalog.count(*) AS count
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = membership.roleid
      WHERE owner_role.rolname = 'system_test_purge_owner'
    `);
    expect(Number(memberships[0].count)).toBe(0);
  });

  async function seedRoots(): Promise<void> {
    await admin.facility.create({
      data: { id: FACILITY_ID, name: 'System test DB boundary' },
    });
    await admin.floor.create({
      data: {
        id: FLOOR_ID,
        facilityId: FACILITY_ID,
        name: 'Boundary floor',
        orderIndex: 1,
      },
    });
    await admin.space.create({
      data: {
        id: SPACE_ID,
        facilityId: FACILITY_ID,
        floorId: FLOOR_ID,
        name: 'Boundary room',
        type: 'ROOM',
        capacity: 1,
      },
    });
    await admin.camera.create({
      data: {
        id: CAMERA_ID,
        facilityId: FACILITY_ID,
        spaceId: SPACE_ID,
        label: 'Boundary camera',
      },
    });
    await admin.edgeInstallation.create({
      data: {
        id: INSTALLATION_ID,
        facilityId: FACILITY_ID,
        generations: { create: { generation: 1, state: 'CLAIMED' } },
      },
    });
    await admin.edgeValidationGrant.create({
      data: {
        id: GRANT_ID,
        facilityId: FACILITY_ID,
        edgeInstallationId: INSTALLATION_ID,
        enrollmentGeneration: 1,
        status: 'CLOSED',
        capability: 'SYSTEM_TEST',
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        closedAt: new Date('2026-01-01T00:01:00.000Z'),
      },
    });
  }

  async function seedNormalEvent(id: string, dedupKey: string): Promise<void> {
    await admin.event.create({
      data: {
        id,
        facilityId: FACILITY_ID,
        cameraId: CAMERA_ID,
        spaceId: SPACE_ID,
        type: 'fall',
        detectedAt: new Date('2026-01-01T00:00:00.000Z'),
        dedupKey,
      },
    });
  }

  async function seedSystemTest(): Promise<void> {
    await admin.event.create({
      data: {
        id: SYSTEM_EVENT_ID,
        facilityId: FACILITY_ID,
        cameraId: null,
        spaceId: null,
        type: 'SYSTEM_TEST',
        confidence: null,
        detectedAt: new Date('2026-01-01T00:00:00.000Z'),
        dedupKey: SYSTEM_EVENT_ID,
        edgeEventId: EDGE_EVENT_ID,
        validationRunId: GRANT_ID,
        retentionExpiresAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    });
    await admin.alert.create({
      data: {
        id: SYSTEM_ALERT_ID,
        facilityId: FACILITY_ID,
        cameraId: null,
        spaceId: null,
        type: 'SYSTEM_TEST',
        probability: null,
        detectedAt: new Date('2026-01-01T00:00:00.000Z'),
        status: 'RESOLVED',
        idempotencyKey: SYSTEM_ALERT_ID,
        originEventId: SYSTEM_EVENT_ID,
        resolvedAt: new Date('2026-01-01T00:01:00.000Z'),
      },
    });
  }

  async function seedClip(): Promise<void> {
    await admin.mediaClip.create({
      data: {
        id: CLIP_ID,
        facilityId: FACILITY_ID,
        cameraId: CAMERA_ID,
        externalClipId: CLIP_ID,
      },
    });
  }

  async function insertPreexistingSystemTestBinding(): Promise<void> {
    await admin.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT pg_catalog.set_config('session_replication_role', 'replica', true)",
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO public.event_media_bindings
           (event_id, facility_id, clip_id, ordinal)
         VALUES ($1, $2, $3, 0)`,
        SYSTEM_EVENT_ID,
        FACILITY_ID,
        CLIP_ID,
      );
    });
  }

  async function purge(): Promise<PurgeResult[]> {
    return runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.facility_id', ${FACILITY_ID}, true)`;
      return tx.$queryRawUnsafe<PurgeResult[]>(
        'SELECT * FROM public.purge_expired_system_tests($1, $2::uuid)',
        FACILITY_ID,
        JOB_ID,
      );
    });
  }

  async function cleanup(): Promise<void> {
    await admin.$executeRawUnsafe(
      `
      DELETE FROM public.system_test_purge_audit_history
      WHERE facility_id = $1
    `,
      FACILITY_ID,
    );
    await admin.eventMediaBinding.deleteMany({
      where: { facilityId: FACILITY_ID },
    });
    await admin.alert.deleteMany({ where: { facilityId: FACILITY_ID } });
    await admin.event.deleteMany({ where: { facilityId: FACILITY_ID } });
    await admin.mediaClip.deleteMany({ where: { facilityId: FACILITY_ID } });
    await admin.edgeValidationGrant.deleteMany({
      where: { facilityId: FACILITY_ID },
    });
    await admin.edgeInstallation.deleteMany({
      where: { facilityId: FACILITY_ID },
    });
    await admin.camera.deleteMany({ where: { facilityId: FACILITY_ID } });
    await admin.space.deleteMany({ where: { facilityId: FACILITY_ID } });
    await admin.floor.deleteMany({ where: { facilityId: FACILITY_ID } });
    await admin.facility.deleteMany({ where: { id: FACILITY_ID } });
  }
});

function migrationMembershipGate(): string {
  const start = MIGRATION_SQL.indexOf(MEMBERSHIP_GATE_START);
  const end = MIGRATION_SQL.indexOf(MEMBERSHIP_GATE_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('migration 49 membership gate not found');
  }
  return MIGRATION_SQL.slice(start + MEMBERSHIP_GATE_START.length, end);
}

type PurgeResult = {
  receipt_id: string;
  job_id: string;
  facility_id: string;
  purged_events: number;
  purged_alerts: number;
  purged_dashboard_receipts: number;
  purged_alert_notes: number;
  replayed: boolean;
};

type AuditRow = {
  purged_events: number;
  purged_alerts: number;
  purged_dashboard_receipts: number;
  purged_alert_notes: number;
};

type RoleMembershipRow = {
  owner_name: string;
  member_name: string;
  member_can_login: boolean;
};

type PurgeOwnerRow = {
  can_login: boolean;
};

type TriggerFunctionContractRow = {
  function_name: string;
  owner_name: string;
  security_definer: boolean;
  function_config: string[];
  app_can_execute: boolean;
  public_can_execute: boolean;
};
