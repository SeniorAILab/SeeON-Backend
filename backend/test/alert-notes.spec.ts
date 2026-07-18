import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureVersionedTestApp } from './helpers/versioned-app';

const TEST_SECRET = 'test-session-secret-minimum-32-characters';

// 스코프 픽스처 id는 단일 빌더에서만 유도한다 — 시드/클린업/라우트/단언이 같은
// 리터럴의 수기 일치에 의존하지 않게 한다 (test/AGENTS.md 컨벤션).
type FixtureSuffix = 'a' | 'b';
const SUFFIXES: readonly FixtureSuffix[] = ['a', 'b'];
const fixtureSlug = (s: FixtureSuffix) => `alert-note-${s}`;
const alertId = (s: FixtureSuffix) => `note-alert-${s}`;
const eventId = (s: FixtureSuffix) => `note-event-${s}`;
const cameraId = (s: FixtureSuffix) => `note-camera-${s}`;
const spaceId = (s: FixtureSuffix) => `note-space-${s}`;
const floorId = (s: FixtureSuffix) => `note-floor-${s}`;
const userEmail = (s: FixtureSuffix) => `${fixtureSlug(s)}@example.test`;
const facilityName = (s: FixtureSuffix) => `Note Facility ${s.toUpperCase()}`;

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
      where: { alertId: { in: SUFFIXES.map(alertId) } },
    });
    await direct.alert.deleteMany({
      where: { id: { in: SUFFIXES.map(alertId) } },
    });
    // Fixture events must go after the alerts that reference them and before
    // the cameras they reference, or a rerun trips the events->cameras FK.
    await direct.event.deleteMany({
      where: { id: { in: SUFFIXES.map(eventId) } },
    });
    await direct.camera.deleteMany({
      where: { id: { in: SUFFIXES.map(cameraId) } },
    });
    await direct.space.deleteMany({
      where: { id: { in: SUFFIXES.map(spaceId) } },
    });
    await direct.floor.deleteMany({
      where: { id: { in: SUFFIXES.map(floorId) } },
    });
    await direct.user.deleteMany({
      where: { email: { in: SUFFIXES.map(userEmail) } },
    });
    await direct.facility.deleteMany({
      where: { name: { in: SUFFIXES.map(facilityName) } },
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
      userEmail('a'),
      facilityName('a'),
    );
    const facilityB = await registerAndGetFacility(
      app,
      userEmail('b'),
      facilityName('b'),
    );
    await seedAlert(facilityA.facilityId, 'a');
    await seedAlert(facilityB.facilityId, 'b');

    const created = await request(app.getHttpServer())
      .post(`/api/v1/alerts/${alertId('a')}/notes`)
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
      .get(`/api/v1/alerts/${alertId('a')}`)
      .set('cookie', facilityA.sessionCookie)
      .expect(200);

    expect(detail.body).toMatchObject({
      id: alertId('a'),
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
      .post(`/api/v1/alerts/${alertId('b')}/notes`)
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

  async function seedAlert(facilityId: string, suffix: FixtureSuffix) {
    await direct.floor.create({
      data: {
        id: floorId(suffix),
        facilityId,
        name: `Note Floor ${suffix}`,
        orderIndex: 1,
      },
    });
    await direct.space.create({
      data: {
        id: spaceId(suffix),
        facilityId,
        floorId: floorId(suffix),
        name: `Note Room ${suffix}`,
        type: 'ROOM',
        capacity: 1,
      },
    });
    await direct.camera.create({
      data: {
        id: cameraId(suffix),
        facilityId,
        spaceId: spaceId(suffix),
        label: `Note Camera ${suffix}`,
      },
    });
    await direct.event.create({
      data: {
        id: eventId(suffix),
        facilityId,
        cameraId: cameraId(suffix),
        spaceId: spaceId(suffix),
        type: 'fall',
        detectedAt: new Date('2026-07-03T00:00:00.000Z'),
        dedupKey: eventId(suffix),
      },
    });
    await direct.alert.create({
      data: {
        id: alertId(suffix),
        facilityId,
        cameraId: cameraId(suffix),
        spaceId: spaceId(suffix),
        type: 'fall',
        probability: 0.91,
        detectedAt: new Date('2026-07-03T00:00:00.000Z'),
        idempotencyKey: alertId(suffix),
        originEventId: eventId(suffix),
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
