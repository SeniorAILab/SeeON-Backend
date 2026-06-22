import { PrismaClient } from '@prisma/client';

type CountRow = { count: number };

describe('placement RLS tenant isolation', () => {
  let direct: PrismaClient;
  let app: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DIRECT_URL || !process.env.DATABASE_URL) {
      throw new Error(
        'DIRECT_URL and DATABASE_URL are required for placement RLS tests',
      );
    }
    direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    app = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await direct.$connect();
    await app.$connect();

    await direct.alert.deleteMany();
    await direct.residentStatus.deleteMany();
    await direct.residentAssignment.deleteMany();
    await direct.camera.deleteMany();
    await direct.guardian.deleteMany();
    await direct.resident.deleteMany();
    await direct.zone.deleteMany();
    await direct.space.deleteMany();
    await direct.floor.deleteMany();
    await direct.facility.deleteMany({
      where: { id: { in: ['rls-a', 'rls-b'] } },
    });
    await direct.facility.createMany({
      data: [
        { id: 'rls-a', name: 'RLS A', code: 'rls-a' },
        { id: 'rls-b', name: 'RLS B', code: 'rls-b' },
      ],
    });
    await direct.floor.createMany({
      data: [
        { id: 'floor-a', facilityId: 'rls-a', name: 'A Floor', orderIndex: 1 },
        { id: 'floor-b', facilityId: 'rls-b', name: 'B Floor', orderIndex: 1 },
      ],
    });
    await direct.resident.createMany({
      data: [
        { id: 'resident-a', facilityId: 'rls-a', name: 'A Resident' },
        { id: 'resident-b', facilityId: 'rls-b', name: 'B Resident' },
      ],
    });
    await direct.space.createMany({
      data: [
        {
          id: 'space-a',
          facilityId: 'rls-a',
          floorId: 'floor-a',
          name: 'A Room',
          type: 'ROOM',
          capacity: 1,
        },
        {
          id: 'space-b',
          facilityId: 'rls-b',
          floorId: 'floor-b',
          name: 'B Room',
          type: 'ROOM',
          capacity: 1,
        },
      ],
    });
    await direct.camera.createMany({
      data: [
        {
          id: 'camera-a',
          facilityId: 'rls-a',
          spaceId: 'space-a',
          label: 'A Camera',
          ingestKeyId: 'camera-a-key',
          ingestSecretHash: 'secret',
        },
        {
          id: 'camera-b',
          facilityId: 'rls-b',
          spaceId: 'space-b',
          label: 'B Camera',
          ingestKeyId: 'camera-b-key',
          ingestSecretHash: 'secret',
        },
      ],
    });
    await direct.zone.createMany({
      data: [
        {
          id: 'zone-a',
          facilityId: 'rls-a',
          spaceId: 'space-a',
          name: 'A Bed',
          type: 'BED',
          orderIndex: 1,
        },
        {
          id: 'zone-b',
          facilityId: 'rls-b',
          spaceId: 'space-b',
          name: 'B Bed',
          type: 'BED',
          orderIndex: 1,
        },
      ],
    });
  });

  afterAll(async () => {
    await app?.$disconnect();
    await direct?.$disconnect();
  });

  it('returns zero rows without app.facility_id', async () => {
    const rows = await app.$queryRaw<Array<CountRow & { table_name: string }>>`
      SELECT table_name, count::int
      FROM (
        SELECT 'floors' AS table_name, COUNT(*) AS count FROM floors
        UNION ALL SELECT 'spaces', COUNT(*) FROM spaces
        UNION ALL SELECT 'zones', COUNT(*) FROM zones
        UNION ALL SELECT 'cameras', COUNT(*) FROM cameras
        UNION ALL SELECT 'alerts', COUNT(*) FROM alerts
      ) denied_counts
      ORDER BY table_name
    `;
    expect(rows).toEqual([
      { table_name: 'alerts', count: 0 },
      { table_name: 'cameras', count: 0 },
      { table_name: 'floors', count: 0 },
      { table_name: 'spaces', count: 0 },
      { table_name: 'zones', count: 0 },
    ]);
  });

  it('cannot read another facility under the wrong GUC', async () => {
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.facility_id', 'rls-a', true)`;
      return tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM floors WHERE facility_id = 'rls-b'
        UNION ALL SELECT id FROM spaces WHERE facility_id = 'rls-b'
        UNION ALL SELECT id FROM zones WHERE facility_id = 'rls-b'
        UNION ALL SELECT id FROM cameras WHERE facility_id = 'rls-b'
        UNION ALL SELECT id FROM alerts WHERE facility_id = 'rls-b'
      `;
    });
    expect(rows).toEqual([]);
  });

  it('rejects cross-facility composite-FK child inserts', async () => {
    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', 'rls-a', true)`;
        await tx.$executeRaw`
          INSERT INTO spaces (id, facility_id, floor_id, name, type, capacity)
          VALUES ('space-cross', 'rls-a', 'floor-b', 'Cross Room', 'ROOM', 1)
        `;
      }),
    ).rejects.toThrow();

    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', 'rls-a', true)`;
        await tx.$executeRaw`
          INSERT INTO zones (id, facility_id, space_id, name, type, order_index)
          VALUES ('zone-cross', 'rls-a', 'space-b', 'Cross Bed', 'BED', 1)
        `;
      }),
    ).rejects.toThrow();

    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', 'rls-a', true)`;
        await tx.$executeRaw`
          INSERT INTO cameras (id, facility_id, space_id, label, ingest_key_id, ingest_secret_hash)
          VALUES ('camera-cross', 'rls-a', 'space-b', 'Cross Camera', 'camera-cross-key', 'secret')
        `;
      }),
    ).rejects.toThrow();

    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', 'rls-a', true)`;
        await tx.$executeRaw`
          INSERT INTO alerts (id, facility_id, resident_id, camera_id, space_id, type, probability, detected_at, idempotency_key)
          VALUES ('alert-cross-space', 'rls-a', 'resident-a', 'camera-a', 'space-b', 'fall', 0.9, now(), 'alert-cross-space-key')
        `;
      }),
    ).rejects.toThrow();

    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', 'rls-a', true)`;
        await tx.$executeRaw`
          INSERT INTO alerts (id, facility_id, resident_id, camera_id, space_id, type, probability, detected_at, idempotency_key)
          VALUES ('alert-cross-camera', 'rls-a', 'resident-a', 'camera-b', 'space-a', 'fall', 0.9, now(), 'alert-cross-camera-key')
        `;
      }),
    ).rejects.toThrow();
  });

  it('rejects a second camera for the same facility space', async () => {
    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', 'rls-a', true)`;
        await tx.$executeRaw`
          INSERT INTO cameras (id, facility_id, space_id, label, ingest_key_id, ingest_secret_hash)
          VALUES ('camera-a1', 'rls-a', 'space-a', 'A Camera 1', 'camera-a1-key', 'secret')
        `;
        await tx.$executeRaw`
          INSERT INTO cameras (id, facility_id, space_id, label, ingest_key_id, ingest_secret_hash)
          VALUES ('camera-a2', 'rls-a', 'space-a', 'A Camera 2', 'camera-a2-key', 'secret')
        `;
      }),
    ).rejects.toThrow();
  });
});
