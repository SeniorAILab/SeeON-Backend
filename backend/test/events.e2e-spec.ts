import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SESSION_COOKIE_NAME } from '../src/auth/auth.constants';
import { createSignedSessionToken } from '../src/auth/signed-token';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AlertWriterService } from '../src/alerts/alert-writer.service';
import { IngestAlertService } from '../src/ingest/ingest-alert.service';
import type { AlertEventType } from '../src/alerts/dto/alert-events.dto';
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
    process.env.KAKAO_REDIRECT_URI = 'http://localhost:3001/auth/kakao/callback';
    process.env.KAKAO_TOKEN_ENC_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.FRONT_ORIGIN = 'http://localhost:3000';

    direct = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    appRole = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await direct.$connect();
    await appRole.$connect();
  });

  beforeEach(async () => {
    await cleanup();
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    expect(duplicate.body).toEqual({ id: created.body.id, status: 'duplicate' });

    await request(app.getHttpServer())
      .post('/api/v1/events')
      .send({ camera_id: second.cameraId, type: 'bed-exit', detected_at: '2026-06-26T01:02:04.456Z' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/events')
      .send({ camera_id: `${PREFIX}-missing`, type: 'fall', detected_at: '2026-06-26T01:02:03.456Z' })
      .expect(404);

    const rows = await direct.event.findMany({ where: { id: created.body.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      facilityId: first.facilityId,
      cameraId: first.cameraId,
      spaceId: first.spaceId,
      type: 'FALL',
      confidence: 0.88,
    });

    const firstList = await request(app.getHttpServer())
      .get('/api/v1/events')
      .set('cookie', firstCookie)
      .expect(200);
    expect(firstList.body.map((event: { id: string }) => event.id)).toEqual([created.body.id]);

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


  it('dispatches concurrent EVENT_API duplicate first-writes to one Alert and one SSE notification', async () => {
    const seeded = await seedFacilityGraph('dispatch', 'EVENT_API');
    const received: unknown[] = [];
    app.get(AlertWriterService).subscribe(seeded.facilityId, (event) => received.push(event));
    const body = {
      camera_id: seeded.cameraId,
      type: 'fall',
      detected_at: '2026-06-26T03:00:00.000Z',
      confidence: 0.92,
    };

    const responses = await Promise.all([
      request(app.getHttpServer()).post('/api/v1/events').send(body).expect(201),
      request(app.getHttpServer()).post('/api/v1/events').send(body).expect(201),
    ]);
    const statuses = responses.map((response) => response.body.status).sort();
    expect(statuses).toEqual(['created', 'duplicate']);
    const eventId = responses[0].body.id;

    const alerts = await direct.alert.findMany({ where: { facilityId: seeded.facilityId } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].originEventId).toBe(eventId);
    expect(responses.map((response) => response.body.id)).toEqual([
      eventId,
      eventId,
    ]);
    expect(received).toHaveLength(1);
  });

  it('keeps LEGACY_ALERTS events event-only and blocks legacy alert writes for EVENT_API cameras', async () => {
    const legacy = await seedFacilityGraph('legacy-event-only', 'LEGACY_ALERTS');
    const eventApi = await seedFacilityGraph('event-api-block-legacy', 'EVENT_API');

    await request(app.getHttpServer())
      .post('/api/v1/events')
      .send({ camera_id: legacy.cameraId, type: 'fall', detected_at: '2026-06-26T03:10:00.000Z', confidence: 0.9 })
      .expect(201);
    await expect(legacyIngest(eventApi, new Date(), 'fall')).rejects.toMatchObject({ response: { statusCode: 409 } });

    expect(await direct.event.count({ where: { facilityId: legacy.facilityId } })).toBe(1);
    expect(await direct.alert.count({ where: { facilityId: legacy.facilityId } })).toBe(0);
    expect(await direct.alert.count({ where: { facilityId: eventApi.facilityId } })).toBe(0);
  });

  it('collapses dual-submit in both orders through shared idempotency', async () => {
    const legacyFirst = await seedFacilityGraph('dual-legacy-first', 'LEGACY_ALERTS');
    const eventFirst = await seedFacilityGraph('dual-event-first', 'EVENT_API');
    const writer = app.get(AlertWriterService);
    const receivedLegacyFirst: unknown[] = [];
    const receivedEventFirst: unknown[] = [];
    writer.subscribe(legacyFirst.facilityId, (event) => receivedLegacyFirst.push(event));
    writer.subscribe(eventFirst.facilityId, (event) => receivedEventFirst.push(event));

    const detectedAtA = new Date();
    await legacyIngest(legacyFirst, detectedAtA, 'fall');
    await direct.camera.update({ where: { id: legacyFirst.cameraId }, data: { ingestMode: 'EVENT_API' } });
    await request(app.getHttpServer())
      .post('/api/v1/events')
      .send({ camera_id: legacyFirst.cameraId, type: 'fall', detected_at: detectedAtA.toISOString(), confidence: 0.9 })
      .expect(201);

    const detectedAtB = new Date(detectedAtA.getTime() + 1000);
    await request(app.getHttpServer())
      .post('/api/v1/events')
      .send({ camera_id: eventFirst.cameraId, type: 'fall', detected_at: detectedAtB.toISOString(), confidence: 0.9 })
      .expect(201);
    await direct.camera.update({ where: { id: eventFirst.cameraId }, data: { ingestMode: 'LEGACY_ALERTS' } });
    await legacyIngest(eventFirst, detectedAtB, 'fall', 'LEGACY_ALERTS');

    expect(await direct.alert.count({ where: { facilityId: legacyFirst.facilityId } })).toBe(1);
    expect(await direct.alert.count({ where: { facilityId: eventFirst.facilityId } })).toBe(1);
    expect(receivedLegacyFirst).toHaveLength(1);
    expect(receivedEventFirst).toHaveLength(1);
  });

  async function seedFacilityGraph(suffix: string, ingestMode: 'LEGACY_ALERTS' | 'EVENT_API' = 'LEGACY_ALERTS') {
    const facility = await direct.facility.create({
      data: { name: `${PREFIX}-facility-${suffix}`, code: `${PREFIX}-${suffix}` },
    });
    const floor = await direct.floor.create({
      data: { facilityId: facility.id, name: `${PREFIX}-floor-${suffix}`, orderIndex: 1 },
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
        ingestKeyId: `${PREFIX}-key-${suffix}`,
        ingestSecretHash: `${PREFIX}-secret-hash-${suffix}`,
        ingestMode,
      },
    });
    return { facilityId: facility.id, spaceId: space.id, cameraId: camera.id, ingestKeyId: camera.ingestKeyId, ingestMode };
  }

  async function legacyIngest(
    seeded: Awaited<ReturnType<typeof seedFacilityGraph>>,
    detectedAt: Date,
    type: string,
    ingestMode: 'LEGACY_ALERTS' | 'EVENT_API' = seeded.ingestMode,
  ) {
    return app.get(IngestAlertService).ingestAlert(
      {
        id: seeded.cameraId,
        facilityId: seeded.facilityId,
        spaceId: seeded.spaceId,
        ingestKeyId: seeded.ingestKeyId,
        ingestMode,
      },
      {
        resident_id: null,
        facility_id: seeded.facilityId,
        type: type as AlertEventType,
        probability: 0.9,
        detectedAt,
      },
    );
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
    const session = await direct.serverSession.create({
      data: {
        userId: user.id,
        facilityId,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
    const secret = app.get(ConfigService).getOrThrow<string>('SESSION_JWT_SECRET');
    const now = Math.floor(Date.now() / 1000);
    const token = createSignedSessionToken(
      { sessionId: session.id, userId: user.id, facilityId, sessionVersion: 0, iat: now, exp: now + 1800 },
      secret,
    );
    return `${SESSION_COOKIE_NAME}=${token}`;
  }

  async function cleanup() {
    await direct.alert.deleteMany({ where: { facility: { name: { startsWith: PREFIX } } } });
    await direct.event.deleteMany({ where: { facility: { name: { startsWith: PREFIX } } } });
    await direct.serverSession.deleteMany({ where: { user: { nickname: { startsWith: PREFIX } } } });
    await direct.user.deleteMany({ where: { nickname: { startsWith: PREFIX } } });
    await direct.camera.deleteMany({ where: { label: { startsWith: PREFIX } } });
    await direct.space.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await direct.floor.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await direct.facility.deleteMany({ where: { name: { startsWith: PREFIX } } });
  }
});
