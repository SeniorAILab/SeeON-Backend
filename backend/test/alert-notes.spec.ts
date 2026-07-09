import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureVersionedTestApp } from './helpers/versioned-app';

const TEST_SECRET = 'test-session-secret-minimum-32-characters';

describe('alert action notes (e2e)', () => {
  let app: INestApplication<App>;
  let direct: PrismaClient;

  beforeAll(async () => {
    process.env.SESSION_JWT_SECRET = TEST_SECRET;
    process.env.FRONT_ORIGIN = 'http://localhost:3000';

    direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    await direct.$connect();
  });

  beforeEach(async () => {
    await direct.alertNote.deleteMany({
      where: { alertId: { in: ['note-alert-a', 'note-alert-b'] } },
    });
    await direct.alert.deleteMany({
      where: { id: { in: ['note-alert-a', 'note-alert-b'] } },
    });
    await direct.camera.deleteMany({
      where: { id: { in: ['note-camera-a', 'note-camera-b'] } },
    });
    await direct.space.deleteMany({
      where: { id: { in: ['note-space-a', 'note-space-b'] } },
    });
    await direct.floor.deleteMany({
      where: { id: { in: ['note-floor-a', 'note-floor-b'] } },
    });
    await direct.user.deleteMany({
      where: {
        email: {
          in: ['alert-note-a@example.test', 'alert-note-b@example.test'],
        },
      },
    });
    await direct.facility.deleteMany({
      where: { code: { in: ['alert-note-a', 'alert-note-b'] } },
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await direct.$disconnect();
  });

  it('creates notes, returns them on alert detail, persists authorRole, and hides other-facility alerts', async () => {
    const facilityA = await registerAndGetFacility(
      app,
      'alert-note-a@example.test',
      'Note Facility A',
    );
    const facilityB = await registerAndGetFacility(
      app,
      'alert-note-b@example.test',
      'Note Facility B',
    );
    await seedAlert(facilityA.facilityId, 'a');
    await seedAlert(facilityB.facilityId, 'b');

    const created = await request(app.getHttpServer())
      .post('/api/v1/alerts/note-alert-a/notes')
      .set('cookie', facilityA.sessionCookie)
      .send({ note: '  checked with floor nurse  ' })
      .expect(201);

    expect(created.body).toEqual({
      id: expect.any(String),
      note: 'checked with floor nurse',
      createdBy: facilityA.userId,
      authorRole: 'ADMIN',
      createdAt: expect.any(String),
    });

    const detail = await request(app.getHttpServer())
      .get('/api/v1/alerts/note-alert-a')
      .set('cookie', facilityA.sessionCookie)
      .expect(200);

    expect(detail.body).toMatchObject({
      id: 'note-alert-a',
      facilityId: facilityA.facilityId,
      notes: [
        {
          id: created.body.id,
          note: 'checked with floor nurse',
          createdBy: facilityA.userId,
          authorRole: 'ADMIN',
          createdAt: created.body.createdAt,
        },
      ],
    });

    await request(app.getHttpServer())
      .post('/api/v1/alerts/note-alert-b/notes')
      .set('cookie', facilityA.sessionCookie)
      .send({ note: 'wrong facility' })
      .expect(404)
      .expect(({ body }) => {
        expect(body).toEqual({ error: 'NOT_FOUND', resource: 'alert' });
      });

    await direct.user.update({
      where: { id: facilityA.userId },
      data: { role: 'STAFF', sessionVersion: { increment: 1 } },
    });
    const stored = await direct.alertNote.findUniqueOrThrow({
      where: { id: created.body.id },
      select: { facilityId: true, authorRole: true },
    });
    expect(stored).toEqual({
      facilityId: facilityA.facilityId,
      authorRole: 'ADMIN',
    });
  });

  async function registerAndGetFacility(
    testApp: INestApplication<App>,
    email: string,
    facilityName: string,
  ) {
    const response = await request(testApp.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        name: facilityName,
        email,
        password: 'care2026',
        phone: '010-0000-0000',
        facilityName,
      })
      .expect(201);
    const sessionCookie = extractSessionCookie(response.headers['set-cookie']);
    return {
      sessionCookie,
      userId: response.body.user.id as string,
      facilityId: response.body.user.facilityId as string,
    };
  }

  async function seedAlert(facilityId: string, suffix: 'a' | 'b') {
    await direct.floor.create({
      data: {
        id: `note-floor-${suffix}`,
        facilityId,
        name: `Note Floor ${suffix}`,
        orderIndex: 1,
      },
    });
    await direct.space.create({
      data: {
        id: `note-space-${suffix}`,
        facilityId,
        floorId: `note-floor-${suffix}`,
        name: `Note Room ${suffix}`,
        type: 'ROOM',
        capacity: 1,
      },
    });
    await direct.camera.create({
      data: {
        id: `note-camera-${suffix}`,
        facilityId,
        spaceId: `note-space-${suffix}`,
        label: `Note Camera ${suffix}`,
      },
    });
    await direct.alert.create({
      data: {
        id: `note-alert-${suffix}`,
        facilityId,
        cameraId: `note-camera-${suffix}`,
        spaceId: `note-space-${suffix}`,
        type: 'fall',
        probability: 0.91,
        detectedAt: new Date('2026-07-03T00:00:00.000Z'),
        idempotencyKey: `note-alert-${suffix}`,
      },
    });
  }
});

function extractSessionCookie(setCookie: unknown): string {
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const sessionCookie = cookies
    .filter((value): value is string => typeof value === 'string')
    .find((value) => value.startsWith('app_session='));
  if (!sessionCookie) throw new Error('Missing app_session cookie');
  return sessionCookie;
}
