import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';
import { SESSION_COOKIE_NAME } from '../src/auth/auth.constants.js';
import { cleanupFacilityFixtures } from './helpers/facility-fixture-cleanup.js';
import { configureVersionedTestApp } from './helpers/versioned-app.js';

const SESSION_SECRET = 'fixture-isolation-session-secret-32-characters';
const SUPER_ADMIN_ID = 'fixture-isolation-super-admin';
const owner = fixtureGraph('owner');
const foreign = fixtureGraph('foreign');
const facilityIds = [owner.facilityId, foreign.facilityId] as const;

describe('database fixture cleanup isolation', () => {
  let app: INestApplication<App>;
  let direct: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DIRECT_URL) throw new Error('DIRECT_URL is required');
    process.env.SESSION_JWT_SECRET = SESSION_SECRET;
    process.env.FRONT_ORIGIN = 'http://localhost:3000';
    direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    await direct.$connect();
    await cleanup();

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await direct.$disconnect();
  });

  it('preserves another suite facility graph and its edge-status endpoint', async () => {
    await seedGraph(direct, owner);
    await seedGraph(direct, foreign);

    await cleanupFacilityFixtures(direct, [owner.facilityId]);
    const adminCookie = await seedSuperAdminCookie();

    await request(app.getHttpServer())
      .get(`/api/v1/facilities/${foreign.facilityId}/edge-status`)
      .set('x-facility-id', foreign.facilityId)
      .set('cookie', adminCookie)
      .expect(200, {
        connectionState: 'NOT_ENROLLED',
        lastHeartbeatAt: null,
        lastSyncedAt: null,
        healthyCameraCount: 0,
        totalCameraCount: 1,
      });

    await expect(
      direct.event.findUnique({ where: { id: foreign.eventId } }),
    ).resolves.toMatchObject({ id: foreign.eventId });
  });

  async function seedSuperAdminCookie(): Promise<string> {
    const user = await direct.user.create({
      data: {
        id: SUPER_ADMIN_ID,
        email: 'fixture-isolation-super-admin@example.test',
        nickname: 'Fixture isolation super admin',
        role: Role.SUPER_ADMIN,
      },
    });
    const secret = app
      .get(ConfigService)
      .getOrThrow<string>('SESSION_JWT_SECRET');
    return `${SESSION_COOKIE_NAME}=${sign(
      {
        sub: user.id,
        role: user.role,
        facilityId: null,
        sessionVersion: user.sessionVersion,
      },
      secret,
      { expiresIn: '12h' },
    )}`;
  }

  async function cleanup(): Promise<void> {
    await cleanupFacilityFixtures(direct, facilityIds);
    await direct.user.deleteMany({ where: { id: SUPER_ADMIN_ID } });
  }
});

function fixtureGraph(suffix: string) {
  const prefix = `fixture-isolation-${suffix}`;
  return {
    facilityId: `${prefix}-facility`,
    floorId: `${prefix}-floor`,
    spaceId: `${prefix}-space`,
    cameraId: `${prefix}-camera`,
    eventId: `${prefix}-event`,
  } as const;
}

async function seedGraph(
  direct: PrismaClient,
  graph: ReturnType<typeof fixtureGraph>,
): Promise<void> {
  await direct.facility.create({
    data: { id: graph.facilityId, name: graph.facilityId },
  });
  await direct.floor.create({
    data: {
      id: graph.floorId,
      facilityId: graph.facilityId,
      name: graph.floorId,
      orderIndex: 1,
    },
  });
  await direct.space.create({
    data: {
      id: graph.spaceId,
      facilityId: graph.facilityId,
      floorId: graph.floorId,
      name: graph.spaceId,
      type: 'ROOM',
      capacity: 1,
    },
  });
  await direct.camera.create({
    data: {
      id: graph.cameraId,
      facilityId: graph.facilityId,
      spaceId: graph.spaceId,
      label: graph.cameraId,
    },
  });
  await direct.event.create({
    data: {
      id: graph.eventId,
      facilityId: graph.facilityId,
      cameraId: graph.cameraId,
      spaceId: graph.spaceId,
      type: 'fall',
      detectedAt: new Date('2026-08-12T00:00:00.000Z'),
      dedupKey: graph.eventId,
    },
  });
}
