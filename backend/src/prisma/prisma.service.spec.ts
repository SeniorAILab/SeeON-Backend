import { Prisma, PrismaClient } from '@prisma/client';
import { MissingTenantContextError } from '../common/errors';
import { TenantContext } from '../common/tenant-context';
import { cleanupFacilityFixtures } from '../../test/helpers/facility-fixture-cleanup.js';
import { PrismaService } from './prisma.service';

type RoleRow = {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
};

type CountRow = { count: number };
type IdRow = { id: string };

describe('Prisma tenant boundary (RLS + facility GUC)', () => {
  const facilityIds = [
    'prisma-rls-facility-a',
    'prisma-rls-facility-b',
  ] as const;
  let direct: PrismaClient;
  let prisma: PrismaService;

  beforeAll(async () => {
    if (!process.env.DIRECT_URL || !process.env.DATABASE_URL) {
      throw new Error(
        'DIRECT_URL and DATABASE_URL are required for tenant RLS tests',
      );
    }

    direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    prisma = new PrismaService();
    await direct.$connect();
    await prisma.onModuleInit();

    await cleanupFacilityFixtures(direct, facilityIds);

    await direct.facility.createMany({
      data: [
        { id: 'prisma-rls-facility-a', name: 'Facility A' },
        { id: 'prisma-rls-facility-b', name: 'Facility B' },
      ],
    });

    await direct.user.createMany({
      data: [
        {
          id: 'prisma-rls-user-a',
          facilityId: 'prisma-rls-facility-a',
          nickname: 'Owner A',
        },
        {
          id: 'prisma-rls-user-b',
          facilityId: 'prisma-rls-facility-b',
          nickname: 'Owner B',
        },
      ],
    });

    await direct.floor.createMany({
      data: [
        {
          id: 'prisma-rls-floor-a',
          facilityId: 'prisma-rls-facility-a',
          name: 'Floor A',
          orderIndex: 1,
        },
        {
          id: 'prisma-rls-floor-b',
          facilityId: 'prisma-rls-facility-b',
          name: 'Floor B',
          orderIndex: 1,
        },
      ],
    });

    await direct.space.createMany({
      data: [
        {
          id: 'prisma-rls-space-a',
          facilityId: 'prisma-rls-facility-a',
          floorId: 'prisma-rls-floor-a',
          name: 'Room A',
          type: 'ROOM',
          capacity: 1,
        },
        {
          id: 'prisma-rls-space-b',
          facilityId: 'prisma-rls-facility-b',
          floorId: 'prisma-rls-floor-b',
          name: 'Room B',
          type: 'ROOM',
          capacity: 1,
        },
      ],
    });

    await direct.camera.createMany({
      data: [
        {
          id: 'prisma-rls-camera-a',
          facilityId: 'prisma-rls-facility-a',
          spaceId: 'prisma-rls-space-a',
          label: 'Camera A',
        },
        {
          id: 'prisma-rls-camera-b',
          facilityId: 'prisma-rls-facility-b',
          spaceId: 'prisma-rls-space-b',
          label: 'Camera B',
        },
      ],
    });

    await direct.event.createMany({
      data: [
        'prisma-rls-event-a',
        'prisma-rls-event-c',
        // spare origin for raw INSERTs expected to be rejected by RLS
        'prisma-rls-event-raw-a',
      ].map((id) => ({
        id,
        facilityId: 'prisma-rls-facility-a',
        cameraId: 'prisma-rls-camera-a',
        spaceId: 'prisma-rls-space-a',
        type: 'fall',
        detectedAt: new Date('2026-06-13T00:00:00.000Z'),
        dedupKey: id,
      })),
    });
    await direct.event.createMany({
      data: ['prisma-rls-event-b', 'prisma-rls-event-raw-b'].map((id) => ({
        id,
        facilityId: 'prisma-rls-facility-b',
        cameraId: 'prisma-rls-camera-b',
        spaceId: 'prisma-rls-space-b',
        type: 'fall',
        detectedAt: new Date('2026-06-13T00:01:00.000Z'),
        dedupKey: id,
      })),
    });

    await direct.alert.createMany({
      data: [
        {
          id: 'prisma-rls-alert-a',
          facilityId: 'prisma-rls-facility-a',
          cameraId: 'prisma-rls-camera-a',
          spaceId: 'prisma-rls-space-a',
          type: 'fall',
          probability: 0.91,
          detectedAt: new Date('2026-06-13T00:00:00.000Z'),
          idempotencyKey: 'idem-a',
          originEventId: 'prisma-rls-event-a',
        },
        {
          id: 'prisma-rls-alert-c',
          facilityId: 'prisma-rls-facility-a',
          cameraId: 'prisma-rls-camera-a',
          spaceId: 'prisma-rls-space-a',
          type: 'fall',
          probability: 0.93,
          detectedAt: new Date('2026-06-13T00:00:30.000Z'),
          idempotencyKey: 'idem-c',
          originEventId: 'prisma-rls-event-c',
        },
        {
          id: 'prisma-rls-alert-b',
          facilityId: 'prisma-rls-facility-b',
          cameraId: 'prisma-rls-camera-b',
          spaceId: 'prisma-rls-space-b',
          type: 'fall',
          probability: 0.92,
          detectedAt: new Date('2026-06-13T00:01:00.000Z'),
          idempotencyKey: 'idem-b',
          originEventId: 'prisma-rls-event-b',
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await cleanupFacilityFixtures(direct, facilityIds);
    await direct.$disconnect();
  });

  it('uses a dedicated runtime role without superuser or BYPASSRLS privileges', async () => {
    const rows = await direct.$queryRaw<RoleRow[]>`
      SELECT rolname, rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = 'fall_app'
    `;

    expect(rows).toEqual([
      { rolname: 'fall_app', rolsuper: false, rolbypassrls: false },
    ]);
  });

  it('fails closed for tenant model access without an application facility context', async () => {
    await expect(prisma.db.camera.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(prisma.db.alert.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(prisma.db.alertNote.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(prisma.db.mediaClip.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(prisma.db.eventMediaBinding.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(
      prisma.db.mediaRetentionHold.findMany(),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
    await expect(prisma.db.mediaAccessLog.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(prisma.db.floor.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(prisma.db.space.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
  });

  it('does not treat an unbound request TenantContext as a set_config-bound database context', async () => {
    await expect(
      TenantContext.run('prisma-rls-facility-a', () =>
        prisma.db.camera.findMany(),
      ),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('lets Postgres RLS deny unscoped raw SQL issued by the app role', async () => {
    const rows = await prisma.db.$queryRaw<
      Array<CountRow & { table_name: string }>
    >`
      SELECT table_name, count::int
      FROM (
        SELECT 'Alert' AS table_name, COUNT(*) AS count FROM alerts
        UNION ALL SELECT 'AlertNote', COUNT(*) FROM alert_notes
        UNION ALL SELECT 'Camera', COUNT(*) FROM cameras
        UNION ALL SELECT 'Space', COUNT(*) FROM spaces
      ) denied_counts
      ORDER BY table_name
    `;

    expect(rows).toEqual([
      { table_name: 'Alert', count: 0 },
      { table_name: 'AlertNote', count: 0 },
      { table_name: 'Camera', count: 0 },
      { table_name: 'Space', count: 0 },
    ]);

    await expect(
      prisma.db.$executeRaw`
        INSERT INTO alerts (id, facility_id, camera_id, space_id, type, probability, detected_at, idempotency_key, origin_event_id)
        VALUES ('raw-unscoped', 'prisma-rls-facility-a', 'prisma-rls-camera-a', 'prisma-rls-space-a', 'fall', 0.5, now(), 'raw-unscoped-key', 'prisma-rls-event-raw-a')
      `,
    ).rejects.toThrow();
  });

  it('binds app.facility_id with set_config(app.facility_id) and scopes model plus raw queries to that facility', async () => {
    const result = await prisma.withFacilityContext(
      'prisma-rls-facility-a',
      async (tx) => {
        const alerts = await tx.alert.findMany({
          orderBy: { id: 'asc' },
        });
        const rawAlerts = await tx.$queryRaw<IdRow[]>`
        SELECT id FROM alerts ORDER BY id
      `;
        const rawCrossFacilityAlerts = await tx.$queryRaw<IdRow[]>`
        SELECT id FROM alerts WHERE facility_id = 'prisma-rls-facility-b'
      `;
        await tx.alertNote.create({
          data: {
            id: 'prisma-rls-note-a',
            facilityId: 'prisma-rls-facility-a',
            alertId: 'prisma-rls-alert-a',
            note: 'checked',
            createdById: 'prisma-rls-user-a',
            authorRole: 'ADMIN',
          },
        });
        const notes = await tx.alertNote.findMany({ orderBy: { id: 'asc' } });
        const rawCrossFacilityNotes = await tx.$queryRaw<IdRow[]>`
        SELECT id FROM alert_notes WHERE facility_id = 'prisma-rls-facility-b'
      `;
        const rawCrossFacilityUpdate = await tx.$executeRaw`
        UPDATE alerts SET type = type WHERE facility_id = 'prisma-rls-facility-b'
      `;
        return {
          alertIds: alerts.map((alert) => alert.id),
          noteIds: notes.map((note) => note.id),
          rawAlertIds: rawAlerts.map((alert) => alert.id),
          rawCrossFacilityAlertIds: rawCrossFacilityAlerts.map(
            (alert) => alert.id,
          ),
          rawCrossFacilityNoteIds: rawCrossFacilityNotes.map((note) => note.id),
          rawCrossFacilityUpdate,
          crossCamera: await tx.camera.findUnique({
            where: { id: 'prisma-rls-camera-b' },
          }),
          crossAlert: await tx.alert.findUnique({
            where: { id: 'prisma-rls-alert-b' },
          }),
          crossSpace: await tx.space.findUnique({
            where: { id: 'prisma-rls-space-b' },
          }),
        };
      },
    );

    expect(result.alertIds).toEqual([
      'prisma-rls-alert-a',
      'prisma-rls-alert-c',
    ]);
    expect(result.noteIds).toEqual(['prisma-rls-note-a']);
    expect(result.rawAlertIds).toEqual([
      'prisma-rls-alert-a',
      'prisma-rls-alert-c',
    ]);
    expect(result.rawCrossFacilityAlertIds).toEqual([]);
    expect(result.rawCrossFacilityNoteIds).toEqual([]);
    expect(result.rawCrossFacilityUpdate).toBe(0);
    expect(result.crossCamera).toBeNull();
    expect(result.crossAlert).toBeNull();
    expect(result.crossSpace).toBeNull();
    await expect(prisma.db.alertNote.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );

    const afterTransaction = await prisma.db.$queryRaw<CountRow[]>`
      SELECT COUNT(*)::int AS count FROM alerts
    `;
    expect(afterTransaction[0]?.count).toBe(0);
  });

  it('lets Postgres RLS reject scoped raw writes that target a different facility', async () => {
    await expect(
      prisma.withFacilityContext(
        'prisma-rls-facility-a',
        async (tx) =>
          tx.$executeRaw`
          INSERT INTO alerts (id, facility_id, camera_id, space_id, type, probability, detected_at, idempotency_key, origin_event_id)
          VALUES ('raw-wrong-facility', 'prisma-rls-facility-b', 'prisma-rls-camera-b', 'prisma-rls-space-b', 'fall', 0.5, now(), 'raw-wrong-facility-key', 'prisma-rls-event-raw-b')
        `,
      ),
    ).rejects.toThrow();

    const rows = await direct.alert.findMany({
      where: { id: 'raw-wrong-facility' },
    });
    expect(rows).toEqual([]);
  });

  it('keeps concurrent facility-bound transactions isolated', async () => {
    const [facilityAIds, facilityBIds] = await Promise.all([
      prisma.withFacilityContext('prisma-rls-facility-a', async (tx) =>
        (await tx.alert.findMany({ orderBy: { id: 'asc' } })).map(
          (alert) => alert.id,
        ),
      ),
      prisma.withFacilityContext('prisma-rls-facility-b', async (tx) =>
        (await tx.alert.findMany({ orderBy: { id: 'asc' } })).map(
          (alert) => alert.id,
        ),
      ),
    ]);

    expect(facilityAIds).toEqual(['prisma-rls-alert-a', 'prisma-rls-alert-c']);
    expect(facilityBIds).toEqual(['prisma-rls-alert-b']);
  });

  it('rejects cross-facility composite foreign keys at the database layer', async () => {
    await expectPrismaCode(
      direct.camera.create({
        data: {
          id: 'bad-camera',
          facilityId: 'prisma-rls-facility-b',
          spaceId: 'prisma-rls-space-a',
          label: 'Bad Camera',
        },
      }),
      'P2003',
    );

    await expectPrismaCode(
      direct.alert.create({
        data: {
          id: 'bad-alert',
          facilityId: 'prisma-rls-facility-b',
          cameraId: 'prisma-rls-camera-a',
          spaceId: 'prisma-rls-space-b',
          type: 'fall',
          probability: 0.99,
          detectedAt: new Date('2026-06-13T00:02:00.000Z'),
          idempotencyKey: 'bad-alert',
          // valid facility-B origin so the composite camera FK stays the failure
          originEventId: 'prisma-rls-event-raw-b',
        },
      }),
      'P2003',
    );
  });
});

async function expectPrismaCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected Prisma error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe(code);
  }
}
