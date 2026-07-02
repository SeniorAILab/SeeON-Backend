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

    await direct.residentAssignment.deleteMany();
    await direct.alert.deleteMany();
    await direct.residentStatus.deleteMany();
    await direct.guardian.deleteMany();
    await direct.camera.deleteMany();
    await direct.kakaoIdentity.deleteMany();
    await direct.user.deleteMany();
    await direct.resident.deleteMany();
    await direct.zone.deleteMany();
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
          kakaoId: 'kakao-a',
          nickname: 'Owner A',
        },
        {
          id: 'user-b',
          facilityId: 'facility-b',
          kakaoId: 'kakao-b',
          nickname: 'Owner B',
        },
      ],
    });

    await direct.kakaoIdentity.createMany({
      data: [
        {
          id: 'kid-a',
          userId: 'user-a',
          facilityId: 'facility-a',
          kakaoId: 'kakao-a',
        },
        {
          id: 'kid-b',
          userId: 'user-b',
          facilityId: 'facility-b',
          kakaoId: 'kakao-b',
        },
      ],
    });

    await direct.resident.createMany({
      data: [
        { id: 'res-a', facilityId: 'facility-a', name: 'Resident A' },
        { id: 'res-b', facilityId: 'facility-b', name: 'Resident B' },
        { id: 'res-c', facilityId: 'facility-a', name: 'Resident C' },
      ],
    });

    await direct.guardian.createMany({
      data: [
        {
          id: 'guard-a',
          facilityId: 'facility-a',
          residentId: 'res-a',
          name: 'Guardian A',
          phone: '010-0000-0001',
        },
        {
          id: 'guard-b',
          facilityId: 'facility-b',
          residentId: 'res-b',
          name: 'Guardian B',
          phone: '010-0000-0002',
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
          residentId: 'res-a',
          cameraId: 'cam-a',
          spaceId: 'space-a',
          type: 'fall',
          probability: 0.91,
          detectedAt: new Date('2026-06-13T00:00:00.000Z'),
          idempotencyKey: 'idem-a',
        },
        {
          id: 'alert-b',
          facilityId: 'facility-b',
          residentId: 'res-b',
          cameraId: 'cam-b',
          spaceId: 'space-b',
          type: 'fall',
          probability: 0.92,
          detectedAt: new Date('2026-06-13T00:01:00.000Z'),
          idempotencyKey: 'idem-b',
        },
      ],
    });

    await direct.residentStatus.createMany({
      data: [
        {
          id: 'status-a',
          facilityId: 'facility-a',
          residentId: 'res-a',
          sourceId: 'cam-a',
        },
        {
          id: 'status-b',
          facilityId: 'facility-b',
          residentId: 'res-b',
          sourceId: 'cam-b',
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
    await expect(prisma.db.resident.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(prisma.db.guardian.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(prisma.db.camera.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(prisma.db.alert.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(prisma.db.residentStatus.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(prisma.db.floor.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(prisma.db.space.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    await expect(prisma.db.zone.findMany()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    // KakaoIdentity is NOT in TENANT_MODELS — app-layer gated, not RLS-gated.
    // kakaoIdentity.findMany() does NOT throw MissingTenantContextError.
  });

  it('does not treat an unbound request TenantContext as a set_config-bound database context', async () => {
    await expect(
      TenantContext.run('facility-a', () => prisma.db.resident.findMany()),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('lets Postgres RLS deny unscoped raw SQL issued by the app role', async () => {
    const rows = await prisma.db.$queryRaw<
      Array<CountRow & { table_name: string }>
    >`
      SELECT table_name, count::int
      FROM (
        SELECT 'Resident' AS table_name, COUNT(*) AS count FROM residents
        UNION ALL SELECT 'Guardian', COUNT(*) FROM guardians
        UNION ALL SELECT 'Camera', COUNT(*) FROM cameras
        UNION ALL SELECT 'Alert', COUNT(*) FROM alerts
        UNION ALL SELECT 'ResidentStatus', COUNT(*) FROM resident_statuses
      ) denied_counts
      ORDER BY table_name
    `;

    // KakaoIdentity is excluded from RLS — it is visible without a GUC (app-layer gated).
    expect(rows).toEqual([
      { table_name: 'Alert', count: 0 },
      { table_name: 'Camera', count: 0 },
      { table_name: 'Guardian', count: 0 },
      { table_name: 'Resident', count: 0 },
      { table_name: 'ResidentStatus', count: 0 },
    ]);

    await expect(
      prisma.db.$executeRaw`
        INSERT INTO residents (id, facility_id, name) VALUES ('raw-unscoped', 'facility-a', 'Raw Unscoped')
      `,
    ).rejects.toThrow();
  });

  it('binds app.facility_id with set_config(app.facility_id) and scopes model plus raw queries to that facility', async () => {
    const result = await prisma.withFacilityContext(
      'facility-a',
      async (tx) => {
        const residents = await tx.resident.findMany({
          orderBy: { id: 'asc' },
        });
        const rawResidents = await tx.$queryRaw<IdRow[]>`
        SELECT id FROM residents ORDER BY id
      `;
        const rawCrossFacilityResidents = await tx.$queryRaw<IdRow[]>`
        SELECT id FROM residents WHERE facility_id = 'facility-b'
      `;
        const rawCrossFacilityUpdate = await tx.$executeRaw`
        UPDATE residents SET name = name WHERE facility_id = 'facility-b'
      `;
        return {
          residentIds: residents.map((resident) => resident.id),
          rawResidentIds: rawResidents.map((resident) => resident.id),
          rawCrossFacilityResidentIds: rawCrossFacilityResidents.map(
            (resident) => resident.id,
          ),
          rawCrossFacilityUpdate,
          crossResident: await tx.resident.findUnique({
            where: { id: 'res-b' },
          }),
          crossGuardian: await tx.guardian.findUnique({
            where: { id: 'guard-b' },
          }),
          crossCamera: await tx.camera.findUnique({ where: { id: 'cam-b' } }),
          crossAlert: await tx.alert.findUnique({ where: { id: 'alert-b' } }),
          crossStatus: await tx.residentStatus.findUnique({
            where: { id: 'status-b' },
          }),
          // KakaoIdentity is NOT RLS-protected — excluded from TENANT_MODELS and RLS.
          // crossKakaoIdentity is intentionally omitted here.
        };
      },
    );

    expect(result.residentIds).toEqual(['res-a', 'res-c']);
    expect(result.rawResidentIds).toEqual(['res-a', 'res-c']);
    expect(result.rawCrossFacilityResidentIds).toEqual([]);
    expect(result.rawCrossFacilityUpdate).toBe(0);
    expect(result.crossResident).toBeNull();
    expect(result.crossGuardian).toBeNull();
    expect(result.crossCamera).toBeNull();
    expect(result.crossAlert).toBeNull();
    expect(result.crossStatus).toBeNull();

    const afterTransaction = await prisma.db.$queryRaw<CountRow[]>`
      SELECT COUNT(*)::int AS count FROM residents
    `;
    expect(afterTransaction[0]?.count).toBe(0);
  });

  it('lets Postgres RLS reject scoped raw writes that target a different facility', async () => {
    await expect(
      prisma.withFacilityContext(
        'facility-a',
        async (tx) =>
          tx.$executeRaw`
          INSERT INTO residents (id, facility_id, name) VALUES ('raw-wrong-facility', 'facility-b', 'Raw Wrong Facility')
        `,
      ),
    ).rejects.toThrow();

    const rows = await direct.resident.findMany({
      where: { id: 'raw-wrong-facility' },
    });
    expect(rows).toEqual([]);
  });

  it('keeps concurrent facility-bound transactions isolated', async () => {
    const [facilityAIds, facilityBIds] = await Promise.all([
      prisma.withFacilityContext('facility-a', async (tx) =>
        (await tx.resident.findMany({ orderBy: { id: 'asc' } })).map(
          (resident) => resident.id,
        ),
      ),
      prisma.withFacilityContext('facility-b', async (tx) =>
        (await tx.resident.findMany({ orderBy: { id: 'asc' } })).map(
          (resident) => resident.id,
        ),
      ),
    ]);

    expect(facilityAIds).toEqual(['res-a', 'res-c']);
    expect(facilityBIds).toEqual(['res-b']);
  });

  it('rejects cross-facility composite foreign keys at the database layer', async () => {
    await expectPrismaCode(
      direct.guardian.create({
        data: {
          id: 'bad-guardian',
          facilityId: 'facility-b',
          residentId: 'res-a',
          name: 'Bad Guardian',
          phone: '010-9999-0001',
        },
      }),
      'P2003',
    );

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
          residentId: 'res-b',
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

    await expectPrismaCode(
      direct.residentStatus.create({
        data: {
          id: 'bad-status',
          facilityId: 'facility-b',
          residentId: 'res-c',
        },
      }),
      'P2003',
    );

    await expectPrismaCode(
      direct.residentStatus.create({
        data: {
          id: 'bad-status-source',
          facilityId: 'facility-a',
          residentId: 'res-c',
          sourceId: 'cam-b',
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
