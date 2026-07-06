import { PrismaClient } from '@prisma/client';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { configureVersionedTestApp } from './helpers/versioned-app';

type CountRow = { count: number };
type NullableColumnRow = { column_name: string; is_nullable: 'YES' | 'NO' };

describe('room-centric cross-slice regression invariants', () => {
  let direct: PrismaClient;
  let app: PrismaClient;
  let httpApp: INestApplication;

  beforeAll(async () => {
    if (!process.env.DIRECT_URL || !process.env.DATABASE_URL) {
      throw new Error(
        'DIRECT_URL and DATABASE_URL are required for room-centric regression tests',
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
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    httpApp = moduleRef.createNestApplication();
    configureVersionedTestApp(httpApp);
    await httpApp.init();
    await direct.alert.deleteMany();
    await direct.event.deleteMany();
    await direct.camera.deleteMany();
    await direct.space.deleteMany();
    await direct.floor.deleteMany();
    await direct.facility.deleteMany({
      where: { id: { in: ['regression-a', 'regression-b'] } },
    });
    await direct.facility.createMany({
      data: [
        { id: 'regression-a', name: 'Regression A', code: 'regression-a' },
        { id: 'regression-b', name: 'Regression B', code: 'regression-b' },
      ],
    });
    await direct.floor.createMany({
      data: [
        {
          id: 'regression-floor-a',
          facilityId: 'regression-a',
          name: 'A Floor',
          orderIndex: 1,
        },
        {
          id: 'regression-floor-b',
          facilityId: 'regression-b',
          name: 'B Floor',
          orderIndex: 1,
        },
      ],
    });
    await direct.space.createMany({
      data: [
        {
          id: 'regression-space-a',
          facilityId: 'regression-a',
          floorId: 'regression-floor-a',
          name: 'A Room',
          type: 'ROOM',
          capacity: 1,
        },
        {
          id: 'regression-space-b',
          facilityId: 'regression-b',
          floorId: 'regression-floor-b',
          name: 'B Room',
          type: 'ROOM',
          capacity: 1,
        },
      ],
    });
    await direct.camera.createMany({
      data: [
        {
          id: 'regression-camera-a',
          facilityId: 'regression-a',
          spaceId: 'regression-space-a',
          label: 'A Camera',
        },
        {
          id: 'regression-camera-b',
          facilityId: 'regression-b',
          spaceId: 'regression-space-b',
          label: 'B Camera',
        },
      ],
    });
  });

  afterAll(async () => {
    await httpApp.close();
    await app.$disconnect();
    await direct.$disconnect();
  });

  it('does not mount removed space zones routes', async () => {
    await request(httpApp.getHttpServer() as App)
      .get('/api/v1/spaces/regression-space-a/zones')
      .expect(404);
  });

  it('keeps Camera.spaceId and Alert.spaceId as NOT NULL room anchors', async () => {
    const columns = await direct.$queryRaw<NullableColumnRow[]>`
      SELECT table_name || '.' || column_name AS column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'cameras' AND column_name = 'space_id')
          OR (table_name = 'alerts' AND column_name = 'space_id')
        )
      ORDER BY column_name
    `;

    expect(columns).toEqual([
      { column_name: 'alerts.space_id', is_nullable: 'NO' },
      { column_name: 'cameras.space_id', is_nullable: 'NO' },
    ]);
  });

  it('returns zero tenant rows for fall_app without app.facility_id', async () => {
    const rows = await app.$queryRaw<Array<CountRow & { table_name: string }>>`
      SELECT table_name, count::int
      FROM (
        SELECT 'cameras' AS table_name, COUNT(*) AS count FROM cameras
        UNION ALL SELECT 'alerts', COUNT(*) FROM alerts
        UNION ALL SELECT 'spaces', COUNT(*) FROM spaces
      ) denied_counts
      ORDER BY table_name
    `;

    expect(rows).toEqual([
      { table_name: 'alerts', count: 0 },
      { table_name: 'cameras', count: 0 },
      { table_name: 'spaces', count: 0 },
    ]);
  });

  it('rejects cross-facility camera-space and alert space/camera inserts under facility A GUC', async () => {
    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', 'regression-a', true)`;
        await tx.$executeRaw`
          INSERT INTO cameras (id, facility_id, space_id, label)
          VALUES ('regression-camera-cross', 'regression-a', 'regression-space-b', 'Cross Camera')
        `;
      }),
    ).rejects.toThrow();

    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', 'regression-a', true)`;
        await tx.$executeRaw`
          INSERT INTO alerts (id, facility_id, camera_id, space_id, type, probability, detected_at, idempotency_key)
          VALUES ('regression-alert-cross-space', 'regression-a', 'regression-camera-a', 'regression-space-b', 'fall', 0.9, now(), 'regression-alert-cross-space-key')
        `;
      }),
    ).rejects.toThrow();

    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', 'regression-a', true)`;
        await tx.$executeRaw`
          INSERT INTO alerts (id, facility_id, camera_id, space_id, type, probability, detected_at, idempotency_key)
          VALUES ('regression-alert-cross-camera', 'regression-a', 'regression-camera-b', 'regression-space-a', 'fall', 0.9, now(), 'regression-alert-cross-camera-key')
        `;
      }),
    ).rejects.toThrow();
  });

  it('accepts room-anchored alerts and enforces idempotency uniqueness', async () => {
    await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.facility_id', 'regression-a', true)`;
      await tx.$executeRaw`
        INSERT INTO alerts (id, facility_id, camera_id, space_id, type, probability, detected_at, idempotency_key)
        VALUES ('regression-room-alert', 'regression-a', 'regression-camera-a', 'regression-space-a', 'fall', 0.9, now(), 'regression-room-key')
      `;
    });

    const alertCount = await direct.alert.count({
      where: { facilityId: 'regression-a' },
    });
    expect(alertCount).toBe(1);

    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', 'regression-a', true)`;
        await tx.$executeRaw`
          INSERT INTO alerts (id, facility_id, camera_id, space_id, type, probability, detected_at, idempotency_key)
          VALUES ('regression-room-alert-duplicate', 'regression-a', 'regression-camera-a', 'regression-space-a', 'fall', 0.9, now(), 'regression-room-key')
        `;
      }),
    ).rejects.toThrow();
  });
});
