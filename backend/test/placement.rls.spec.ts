import { PrismaClient } from '@prisma/client';
import { cleanupFacilityFixtures } from './helpers/facility-fixture-cleanup.js';

type CountRow = { count: number };

describe('placement RLS tenant isolation', () => {
  const facilityIds = ['rls-a', 'rls-b'] as const;
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

    await cleanupFacilityFixtures(direct, facilityIds);
    await direct.facility.createMany({
      data: [
        { id: 'rls-a', name: 'RLS A' },
        { id: 'rls-b', name: 'RLS B' },
      ],
    });
    await direct.floor.createMany({
      data: [
        {
          id: 'placement-rls-floor-a',
          facilityId: 'rls-a',
          name: 'A Floor',
          orderIndex: 1,
        },
        {
          id: 'placement-rls-floor-b',
          facilityId: 'rls-b',
          name: 'B Floor',
          orderIndex: 1,
        },
      ],
    });
    await direct.space.createMany({
      data: [
        {
          id: 'placement-rls-space-a',
          facilityId: 'rls-a',
          floorId: 'placement-rls-floor-a',
          name: 'A Room',
          type: 'ROOM',
          capacity: 1,
        },
        {
          id: 'placement-rls-space-b',
          facilityId: 'rls-b',
          floorId: 'placement-rls-floor-b',
          name: 'B Room',
          type: 'ROOM',
          capacity: 1,
        },
      ],
    });
    await direct.camera.createMany({
      data: [
        {
          id: 'placement-rls-camera-a',
          facilityId: 'rls-a',
          spaceId: 'placement-rls-space-a',
          label: 'A Camera',
        },
        {
          id: 'placement-rls-camera-b',
          facilityId: 'rls-b',
          spaceId: 'placement-rls-space-b',
          label: 'B Camera',
        },
      ],
    });
    // origin event for alert inserts (alerts.origin_event_id is NOT NULL)
    await direct.event.create({
      data: {
        id: 'placement-event-a',
        facilityId: 'rls-a',
        cameraId: 'placement-rls-camera-a',
        spaceId: 'placement-rls-space-a',
        type: 'fall',
        detectedAt: new Date('2026-07-03T00:00:00.000Z'),
        dedupKey: 'placement-event-a',
      },
    });
  });

  afterAll(async () => {
    await app.$disconnect();
    await cleanupFacilityFixtures(direct, facilityIds);
    await direct.$disconnect();
  });

  it('returns zero rows without app.facility_id', async () => {
    const rows = await app.$queryRaw<Array<CountRow & { table_name: string }>>`
      SELECT table_name, count::int
      FROM (
        SELECT 'floors' AS table_name, COUNT(*) AS count FROM floors
        UNION ALL SELECT 'spaces', COUNT(*) FROM spaces
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
    ]);
  });

  it('cannot read another facility under the wrong GUC', async () => {
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.facility_id', 'rls-a', true)`;
      return tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM floors WHERE facility_id = 'rls-b'
        UNION ALL SELECT id FROM spaces WHERE facility_id = 'rls-b'
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
          VALUES ('space-cross', 'rls-a', 'placement-rls-floor-b', 'Cross Room', 'ROOM', 1)
        `;
      }),
    ).rejects.toThrow();

    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', 'rls-a', true)`;
        await tx.$executeRaw`
          INSERT INTO cameras (id, facility_id, space_id, label)
          VALUES ('camera-cross', 'rls-a', 'placement-rls-space-b', 'Cross Camera')
        `;
      }),
    ).rejects.toThrow();

    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', 'rls-a', true)`;
        await tx.$executeRaw`
          INSERT INTO alerts (id, facility_id, camera_id, space_id, type, probability, detected_at, idempotency_key, origin_event_id)
          VALUES ('alert-cross-space', 'rls-a', 'placement-rls-camera-a', 'placement-rls-space-b', 'fall', 0.9, now(), 'alert-cross-space-key', 'placement-event-a')
        `;
      }),
    ).rejects.toThrow();

    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', 'rls-a', true)`;
        await tx.$executeRaw`
          INSERT INTO alerts (id, facility_id, camera_id, space_id, type, probability, detected_at, idempotency_key, origin_event_id)
          VALUES ('alert-cross-camera', 'rls-a', 'placement-rls-camera-b', 'placement-rls-space-a', 'fall', 0.9, now(), 'alert-cross-camera-key', 'placement-event-a')
        `;
      }),
    ).rejects.toThrow();
  });

  it('rejects a second camera for the same facility space', async () => {
    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', 'rls-a', true)`;
        await tx.$executeRaw`
          INSERT INTO cameras (id, facility_id, space_id, label)
          VALUES ('placement-rls-camera-a1', 'rls-a', 'placement-rls-space-a', 'A Camera 1')
        `;
        await tx.$executeRaw`
          INSERT INTO cameras (id, facility_id, space_id, label)
          VALUES ('placement-rls-camera-a2', 'rls-a', 'placement-rls-space-a', 'A Camera 2')
        `;
      }),
    ).rejects.toThrow();
  });
});
