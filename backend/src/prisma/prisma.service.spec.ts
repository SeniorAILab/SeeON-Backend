import { Prisma, PrismaClient } from '@prisma/client';
import { MissingTenantContextError } from '../common/errors';
import { TenantContext } from '../common/tenant-context';
import { PrismaService } from './prisma.service';

type RoleRow = {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
};

type CountRow = { count: number };
type IdRow = { id: string };

describe('Prisma tenant boundary (RLS + facility GUC)', () => {
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

    await direct.alertNote.deleteMany();
    await direct.alert.deleteMany();
    await direct.event.deleteMany();
    await direct.camera.deleteMany();
    await direct.user.deleteMany();
    await direct.space.deleteMany();
    await direct.floor.deleteMany();
    await direct.facility.deleteMany();

    await direct.facility.createMany({
      data: [
        { id: 'facility-a', name: 'Facility A', code: 'facility-a' },
        { id: 'facility-b', name: 'Facility B', code: 'facility-b' },
      ],
    });

    await direct.user.createMany({
      data: [
        {
          id: 'user-a',
          facilityId: 'facility-a',
          nickname: 'Owner A',
        },
        {
          id: 'user-b',
          facilityId: 'facility-b',
          nickname: 'Owner B',
        },
      ],
    });

    await direct.floor.createMany({
      data: [
        {
          id: 'floor-a',
          facilityId: 'facility-a',
          name: 'Floor A',
          orderIndex: 1,
        },
        {
          id: 'floor-b',
          facilityId: 'facility-b',
          name: 'Floor B',
          orderIndex: 1,
        },
      ],
    });

    await direct.space.createMany({
      data: [
        {
          id: 'space-a',
          facilityId: 'facility-a',
          floorId: 'floor-a',
          name: 'Room A',
          type: 'ROOM',
          capacity: 1,
        },
        {
          id: 'space-b',
          facilityId: 'facility-b',
          floorId: 'floor-b',
          name: 'Room B',
          type: 'ROOM',
          capacity: 1,
        },
      ],
    });

    await direct.camera.createMany({
      data: [
        {
          id: 'cam-a',
          facilityId: 'facility-a',
          spaceId: 'space-a',
          label: 'Camera A',
        },
        {
          id: 'cam-b',
          facilityId: 'facility-b',
          spaceId: 'space-b',
          label: 'Camera B',
        },
      ],
    });

    await direct.alert.createMany({
      data: [
        {
          id: 'alert-a',
          facilityId: 'facility-a',
          cameraId: 'cam-a',
          spaceId: 'space-a',
          type: 'fall',
          probability: 0.91,
          detectedAt: new Date('2026-06-13T00:00:00.000Z'),
          idempotencyKey: 'idem-a',
        },
        {
          id: 'alert-c',
          facilityId: 'facility-a',
          cameraId: 'cam-a',
          spaceId: 'space-a',
          type: 'fall',
          probability: 0.93,
          detectedAt: new Date('2026-06-13T00:00:30.000Z'),
          idempotencyKey: 'idem-c',
        },
        {
          id: 'alert-b',
          facilityId: 'facility-b',
          cameraId: 'cam-b',
          spaceId: 'space-b',
          type: 'fall',
          probability: 0.92,
          detectedAt: new Date('2026-06-13T00:01:00.000Z'),
          idempotencyKey: 'idem-b',
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
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
    await expect(prisma.db.floor.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(prisma.db.space.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
  });

  it('does not treat an unbound request TenantContext as a set_config-bound database context', async () => {
    await expect(
      TenantContext.run('facility-a', () => prisma.db.camera.findMany()),
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
        INSERT INTO alerts (id, facility_id, camera_id, space_id, type, probability, detected_at, idempotency_key)
        VALUES ('raw-unscoped', 'facility-a', 'cam-a', 'space-a', 'fall', 0.5, now(), 'raw-unscoped-key')
      `,
    ).rejects.toThrow();
  });

  it('binds app.facility_id with set_config(app.facility_id) and scopes model plus raw queries to that facility', async () => {
    const result = await prisma.withFacilityContext(
      'facility-a',
      async (tx) => {
        const alerts = await tx.alert.findMany({
          orderBy: { id: 'asc' },
        });
        const rawAlerts = await tx.$queryRaw<IdRow[]>`
        SELECT id FROM alerts ORDER BY id
      `;
        const rawCrossFacilityAlerts = await tx.$queryRaw<IdRow[]>`
        SELECT id FROM alerts WHERE facility_id = 'facility-b'
      `;
        await tx.alertNote.create({
          data: {
            id: 'note-a',
            facilityId: 'facility-a',
            alertId: 'alert-a',
            note: 'checked',
            createdById: 'user-a',
            authorRole: 'ADMIN',
          },
        });
        const notes = await tx.alertNote.findMany({ orderBy: { id: 'asc' } });
        const rawCrossFacilityNotes = await tx.$queryRaw<IdRow[]>`
        SELECT id FROM alert_notes WHERE facility_id = 'facility-b'
      `;
        const rawCrossFacilityUpdate = await tx.$executeRaw`
        UPDATE alerts SET type = type WHERE facility_id = 'facility-b'
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
          crossCamera: await tx.camera.findUnique({ where: { id: 'cam-b' } }),
          crossAlert: await tx.alert.findUnique({ where: { id: 'alert-b' } }),
          crossSpace: await tx.space.findUnique({ where: { id: 'space-b' } }),
        };
      },
    );

    expect(result.alertIds).toEqual(['alert-a', 'alert-c']);
    expect(result.noteIds).toEqual(['note-a']);
    expect(result.rawAlertIds).toEqual(['alert-a', 'alert-c']);
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
        'facility-a',
        async (tx) =>
          tx.$executeRaw`
          INSERT INTO alerts (id, facility_id, camera_id, space_id, type, probability, detected_at, idempotency_key)
          VALUES ('raw-wrong-facility', 'facility-b', 'cam-b', 'space-b', 'fall', 0.5, now(), 'raw-wrong-facility-key')
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
      prisma.withFacilityContext('facility-a', async (tx) =>
        (await tx.alert.findMany({ orderBy: { id: 'asc' } })).map(
          (alert) => alert.id,
        ),
      ),
      prisma.withFacilityContext('facility-b', async (tx) =>
        (await tx.alert.findMany({ orderBy: { id: 'asc' } })).map(
          (alert) => alert.id,
        ),
      ),
    ]);

    expect(facilityAIds).toEqual(['alert-a', 'alert-c']);
    expect(facilityBIds).toEqual(['alert-b']);
  });

  it('rejects cross-facility composite foreign keys at the database layer', async () => {
    await expectPrismaCode(
      direct.camera.create({
        data: {
          id: 'bad-camera',
          facilityId: 'facility-b',
          spaceId: 'space-a',
          label: 'Bad Camera',
        },
      }),
      'P2003',
    );

    await expectPrismaCode(
      direct.alert.create({
        data: {
          id: 'bad-alert',
          facilityId: 'facility-b',
          cameraId: 'cam-a',
          spaceId: 'space-b',
          type: 'fall',
          probability: 0.99,
          detectedAt: new Date('2026-06-13T00:02:00.000Z'),
          idempotencyKey: 'bad-alert',
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
