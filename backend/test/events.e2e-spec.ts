import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SESSION_COOKIE_NAME } from '../src/auth/auth.constants';
import { sign } from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AlertWriterService } from '../src/alerts/alert-writer.service';

import { configureVersionedTestApp } from './helpers/versioned-app';

const TEST_SECRET = 'test-session-secret-minimum-32-characters';
const PREFIX = 'events-pr3-e2e';

describe('Events API (e2e)', () => {
  let app: INestApplication<App>;
  let direct: PrismaClient;
  let appRole: PrismaClient;

  beforeAll(async () => {
    process.env.SESSION_JWT_SECRET = TEST_SECRET;
    process.env.KAKAO_REST_API_KEY = 'test-rest-api-key';
    process.env.KAKAO_REDIRECT_URI =
      'http://localhost:3001/api/v1/auth/kakao/callback';
    process.env.KAKAO_TOKEN_ENC_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.FRONT_ORIGIN = 'http://localhost:3000';

    direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    appRole = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await direct.$connect();
    await appRole.$connect();
  });

  beforeEach(async () => {
    await cleanup();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  afterAll(async () => {
    await appRole.$disconnect();
    await direct.$disconnect();
  });

  it('records a no-HMAC versioned camera heartbeat and rejects unknown cameras', async () => {
    const seeded = await seedFacilityGraph('heartbeat');

    await request(app.getHttpServer())
      .post('/api/v1/events/heartbeat')
      .send({ camera_id: seeded.cameraId })
      .expect(200, { ok: true });

    const camera = await direct.camera.findUniqueOrThrow({
      where: { id: seeded.cameraId },
    });
    expect(camera.online).toBe(true);
    expect(camera.lastSeenAt).toBeInstanceOf(Date);

    await request(app.getHttpServer())
      .post('/api/v1/events/heartbeat')
      .send({ camera_id: `${PREFIX}-missing-heartbeat` })
      .expect(404);
  });
  it('records events idempotently, scopes GET by facility, denies unbound/RLS and UPDATE/DELETE', async () => {
    const first = await seedFacilityGraph('a');
    const second = await seedFacilityGraph('b');
    const firstCookie = await seedSessionCookie(first.facilityId, 'a');
    const secondCookie = await seedSessionCookie(second.facilityId, 'b');
    const body = {
      camera_id: first.cameraId,
      facility_id: second.facilityId,
      type: ' FALL ',
      detected_at: '2026-06-26T01:02:03.456Z',
      confidence: 0.88,
    };

    const created = await request(app.getHttpServer())
      .post('/api/v1/events')
      .send(body)
      .expect(201);
    expect(created.body).toMatchObject({ status: 'created' });

    const duplicate = await request(app.getHttpServer())
      .post('/api/v1/events')
      .send({ ...body, type: 'fall' })
      .expect(201);
    expect(duplicate.body).toEqual({
      id: created.body.id,
      status: 'duplicate',
    });

    await request(app.getHttpServer())
      .post('/api/v1/events')
      .send({
        camera_id: second.cameraId,
        type: 'bed-exit',
        detected_at: '2026-06-26T01:02:04.456Z',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/events')
      .send({
        camera_id: `${PREFIX}-missing`,
        type: 'fall',
        detected_at: '2026-06-26T01:02:03.456Z',
      })
      .expect(404);

    const rows = await direct.event.findMany({
      where: { id: created.body.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      facilityId: first.facilityId,
      cameraId: first.cameraId,
      spaceId: first.spaceId,
      type: 'fall',
      confidence: 0.88,
    });

    const firstList = await request(app.getHttpServer())
      .get('/api/v1/events')
      .set('cookie', firstCookie)
      .expect(200);
    expect(firstList.body.map((event: { id: string }) => event.id)).toEqual([
      created.body.id,
    ]);

    const secondList = await request(app.getHttpServer())
      .get('/api/v1/events')
      .set('cookie', secondCookie)
      .expect(200);
    expect(secondList.body).toHaveLength(1);
    expect(secondList.body[0].id).not.toBe(created.body.id);

    await expect(app.get(PrismaService).db.event.findMany()).rejects.toThrow(
      'without a facility context',
    );

    await expect(
      appRole.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', ${first.facilityId}, true)`;
        await tx.$executeRaw`UPDATE events SET type = 'tampered' WHERE id = ${created.body.id}`;
      }),
    ).rejects.toThrow(/permission denied|privilege/i);

    await expect(
      appRole.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', ${first.facilityId}, true)`;
        await tx.$executeRaw`DELETE FROM events WHERE id = ${created.body.id}`;
      }),
    ).rejects.toThrow(/permission denied|privilege/i);
  });

  it('rejects unsupported event types without persisting an Event row', async () => {
    const seeded = await seedFacilityGraph('invalid-type');
    const before = await direct.event.count({
      where: { facilityId: seeded.facilityId },
    });

    await request(app.getHttpServer())
      .post('/api/v1/events')
      .send({
        camera_id: seeded.cameraId,
        type: 'foo',
        detected_at: '2026-06-26T02:00:00.000Z',
        confidence: 0.5,
      })
      .expect(400);

    await expect(
      direct.event.count({ where: { facilityId: seeded.facilityId } }),
    ).resolves.toBe(before);
  });

  it('accepts detection-lost events', async () => {
    const seeded = await seedFacilityGraph('detection-lost');

    const created = await request(app.getHttpServer())
      .post('/api/v1/events')
      .send({
        camera_id: seeded.cameraId,
        type: 'detection-lost',
        detected_at: '2026-06-26T02:01:00.000Z',
      })
      .expect(201);

    expect(created.body).toMatchObject({ status: 'created' });
    await expect(
      direct.event.count({
        where: { facilityId: seeded.facilityId, type: 'detection-lost' },
      }),
    ).resolves.toBe(1);
  });
  it('dispatches concurrent EVENT_API duplicate first-writes to one Alert and one SSE notification', async () => {
    const seeded = await seedFacilityGraph('dispatch');
    const received: unknown[] = [];
    app
      .get(AlertWriterService)
      .subscribe(seeded.facilityId, (event) => received.push(event));
    const body = {
      camera_id: seeded.cameraId,
      type: 'fall',
      detected_at: '2026-06-26T03:00:00.000Z',
      confidence: 0.92,
    };

    const responses = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/events')
        .send(body)
        .expect(201),
      request(app.getHttpServer())
        .post('/api/v1/events')
        .send(body)
        .expect(201),
    ]);
    const statuses = responses.map((response) => response.body.status).sort();
    expect(statuses).toEqual(['created', 'duplicate']);
    const eventId = responses[0].body.id;

    const alerts = await direct.alert.findMany({
      where: { facilityId: seeded.facilityId },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].originEventId).toBe(eventId);
    expect(responses.map((response) => response.body.id)).toEqual([
      eventId,
      eventId,
    ]);
    expect(received).toHaveLength(1);
  });

  it('emits an Alert for every valid Event (no per-camera ingest-mode suppression)', async () => {
    const first = await seedFacilityGraph('single-path-1');
    const second = await seedFacilityGraph('single-path-2');

    await request(app.getHttpServer())
      .post('/api/v1/events')
      .send({
        camera_id: first.cameraId,
        type: 'fall',
        detected_at: '2026-06-26T03:10:00.000Z',
        confidence: 0.9,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/events')
      .send({
        camera_id: second.cameraId,
        type: 'fall',
        detected_at: '2026-06-26T03:10:01.000Z',
        confidence: 0.9,
      })
      .expect(201);

    expect(
      await direct.event.count({ where: { facilityId: first.facilityId } }),
    ).toBe(1);
    expect(
      await direct.alert.count({ where: { facilityId: first.facilityId } }),
    ).toBe(1);
    expect(
      await direct.alert.count({ where: { facilityId: second.facilityId } }),
    ).toBe(1);
  });

  it('collapses repeated EVENT_API submissions through shared idempotency', async () => {
    const seeded = await seedFacilityGraph('event-idempotency');
    const received: unknown[] = [];
    app
      .get(AlertWriterService)
      .subscribe(seeded.facilityId, (event) => received.push(event));

    const detectedAt = new Date();
    const body = {
      camera_id: seeded.cameraId,
      type: 'fall',
      detected_at: detectedAt.toISOString(),
      confidence: 0.9,
    };

    await request(app.getHttpServer())
      .post('/api/v1/events')
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/events')
      .send(body)
      .expect(201);

    expect(
      await direct.event.count({ where: { facilityId: seeded.facilityId } }),
    ).toBe(1);
    expect(
      await direct.alert.count({ where: { facilityId: seeded.facilityId } }),
    ).toBe(1);
    expect(received).toHaveLength(1);
  });

  async function seedFacilityGraph(suffix: string) {
    const facility = await direct.facility.create({
      data: {
        name: `${PREFIX}-facility-${suffix}`,
        code: `${PREFIX}-${suffix}`,
      },
    });
    const floor = await direct.floor.create({
      data: {
        facilityId: facility.id,
        name: `${PREFIX}-floor-${suffix}`,
        orderIndex: 1,
      },
    });
    const space = await direct.space.create({
      data: {
        facilityId: facility.id,
        floorId: floor.id,
        name: `${PREFIX}-space-${suffix}`,
        type: 'ROOM',
        capacity: 1,
      },
    });
    const camera = await direct.camera.create({
      data: {
        id: `${PREFIX}-camera-${suffix}`,
        facilityId: facility.id,
        spaceId: space.id,
        label: `${PREFIX}-camera-${suffix}`,
      },
    });
    return { facilityId: facility.id, spaceId: space.id, cameraId: camera.id };
  }

  async function seedSessionCookie(facilityId: string, suffix: string) {
    const user = await direct.user.create({
      data: {
        facilityId,
        email: `${PREFIX}-${suffix}@example.test`,
        phone: `010-0000-000${suffix === 'a' ? '1' : '2'}`,
        nickname: `${PREFIX}-user-${suffix}`,
        role: 'ADMIN',
      },
    });
    const secret = app
      .get(ConfigService)
      .getOrThrow<string>('SESSION_JWT_SECRET');
    const token = sign(
      {
        sub: user.id,
        role: user.role,
        facilityId,
        sessionVersion: user.sessionVersion,
      },
      secret,
      { expiresIn: '12h' },
    );
    return `${SESSION_COOKIE_NAME}=${token}`;
  }

  async function cleanup() {
    await direct.alert.deleteMany({
      where: { facility: { name: { startsWith: PREFIX } } },
    });
    await direct.event.deleteMany({
      where: { facility: { name: { startsWith: PREFIX } } },
    });
    await direct.user.deleteMany({
      where: { nickname: { startsWith: PREFIX } },
    });
    await direct.camera.deleteMany({
      where: { label: { startsWith: PREFIX } },
    });
    await direct.space.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await direct.floor.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await direct.facility.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
  }
});
