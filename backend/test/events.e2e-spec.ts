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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configureVersionedTestApp } from './helpers/versioned-app';

const TEST_SECRET = 'test-session-secret-minimum-32-characters';
const PREFIX = 'events-pr3-e2e';
const EDGE_TOKEN = 'events-pr3-e2e-edge-token';

describe('Events API (e2e)', () => {
  let app: INestApplication<App>;
  let direct: PrismaClient;
  let appRole: PrismaClient;

  beforeAll(async () => {
    process.env.SESSION_JWT_SECRET = TEST_SECRET;
    process.env.FRONT_ORIGIN = 'http://localhost:3000';
    process.env.EDGE_FACILITY_TOKEN = EDGE_TOKEN;

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

    await postHeartbeat({ camera_id: seeded.cameraId }).expect(200, {
      ok: true,
    });

    const camera = await direct.camera.findUniqueOrThrow({
      where: { id: seeded.cameraId },
    });
    expect(camera.online).toBe(true);
    expect(camera.lastSeenAt).toBeInstanceOf(Date);

    await postHeartbeat({
      camera_id: `${PREFIX}-missing-heartbeat`,
    }).expect(404);
  });

  it('rejects unauthenticated event and heartbeat ingest', async () => {
    const seeded = await seedFacilityGraph('unauth');

    await request(app.getHttpServer())
      .post('/api/v1/events/heartbeat')
      .send({ camera_id: seeded.cameraId })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/events')
      .send({
        camera_id: seeded.cameraId,
        type: 'fall',
        detected_at: '2026-06-26T04:00:00.000Z',
        confidence: 0.9,
      })
      .expect(401);

    expect(
      await direct.event.count({ where: { facilityId: seeded.facilityId } }),
    ).toBe(0);
  });

  it('rejects event and heartbeat ingest with a mismatched bearer token', async () => {
    const seeded = await seedFacilityGraph('wrong-token');

    await request(app.getHttpServer())
      .post('/api/v1/events/heartbeat')
      .set('Authorization', 'Bearer wrong-token')
      .send({ camera_id: seeded.cameraId })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/events')
      .set('Authorization', 'Bearer wrong-token')
      .send({
        camera_id: seeded.cameraId,
        type: 'fall',
        detected_at: '2026-06-26T04:00:01.000Z',
        confidence: 0.9,
      })
      .expect(403);
  });
  it('requires the edge ingest token before changing an event snapshot', async () => {
    const seeded = await seedFacilityGraph('snapshot-token');
    const created = await postEvent({
      camera_id: seeded.cameraId,
      type: 'fall',
      detected_at: '2026-06-26T04:00:02.000Z',
      confidence: 0.9,
    }).expect(201);
    const eventId = created.body.id as string;
    const snapshotKey = `${seeded.facilityId}/${eventId}.jpg`;
    const previousSnapshotDir = process.env.SNAPSHOT_DIR;
    const snapshotDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'events-e2e-snapshot-'),
    );
    process.env.SNAPSHOT_DIR = snapshotDir;
    const existingSnapshot = Buffer.from('existing-snapshot');
    const snapshotPath = path.join(snapshotDir, snapshotKey);

    try {
      await fs.promises.mkdir(path.dirname(snapshotPath), { recursive: true });
      await fs.promises.writeFile(snapshotPath, existingSnapshot);
      await direct.event.update({
        where: { id: eventId },
        data: { snapshotKey },
      });

      await request(app.getHttpServer())
        .put(`/api/v1/events/${eventId}/snapshot`)
        .set('Content-Type', 'image/jpeg')
        .send(Buffer.from('unauthorized-snapshot'))
        .expect(401);
      await expect(
        direct.event.findUniqueOrThrow({ where: { id: eventId } }),
      ).resolves.toMatchObject({ snapshotKey });
      await expect(fs.promises.readFile(snapshotPath)).resolves.toEqual(
        existingSnapshot,
      );

      await request(app.getHttpServer())
        .put(`/api/v1/events/${eventId}/snapshot`)
        .set('Authorization', 'Bearer wrong-token')
        .set('Content-Type', 'image/jpeg')
        .send(Buffer.from('wrong-token-snapshot'))
        .expect(403);
      await expect(
        direct.event.findUniqueOrThrow({ where: { id: eventId } }),
      ).resolves.toMatchObject({ snapshotKey });
      await expect(fs.promises.readFile(snapshotPath)).resolves.toEqual(
        existingSnapshot,
      );

      // Snapshots are immutable: an authorized rewrite with different bytes is
      // rejected (409) and the stored bytes stay intact; a byte-identical
      // replay is idempotent (200).
      await putSnapshot(eventId, Buffer.from('authorized-snapshot')).expect(
        409,
      );
      await expect(
        direct.event.findUniqueOrThrow({ where: { id: eventId } }),
      ).resolves.toMatchObject({ snapshotKey });
      await expect(fs.promises.readFile(snapshotPath)).resolves.toEqual(
        existingSnapshot,
      );

      const replayed = await putSnapshot(eventId, existingSnapshot).expect(200);
      expect(replayed.body).toEqual({ snapshotKey });
      await expect(fs.promises.readFile(snapshotPath)).resolves.toEqual(
        existingSnapshot,
      );
    } finally {
      if (previousSnapshotDir === undefined) {
        delete process.env.SNAPSHOT_DIR;
      } else {
        process.env.SNAPSHOT_DIR = previousSnapshotDir;
      }
      await fs.promises.rm(snapshotDir, { recursive: true, force: true });
    }
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

    const created = await postEvent(body).expect(201);
    expect(created.body).toMatchObject({ status: 'created' });

    const duplicate = await postEvent({ ...body, type: 'fall' }).expect(201);
    expect(duplicate.body).toEqual({
      id: created.body.id,
      status: 'duplicate',
    });

    await postEvent({
      camera_id: second.cameraId,
      type: 'bed-exit',
      detected_at: '2026-06-26T01:02:04.456Z',
    }).expect(201);

    await postEvent({
      camera_id: `${PREFIX}-missing`,
      type: 'fall',
      detected_at: '2026-06-26T01:02:03.456Z',
    }).expect(404);

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
    expect(firstList.body.items.map((event: { id: string }) => event.id)).toEqual([
      created.body.id,
    ]);
    expect(firstList.body.nextCursor).toBeNull();

    const secondList = await request(app.getHttpServer())
      .get('/api/v1/events')
      .set('cookie', secondCookie)
      .expect(200);
    expect(secondList.body.items).toHaveLength(1);
    expect(secondList.body.items[0].id).not.toBe(created.body.id);
    expect(secondList.body.nextCursor).toBeNull();

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
  it('paginates event history without overlap and caps explicit limits', async () => {
    const seeded = await seedFacilityGraph('pagination');
    const cookie = await seedSessionCookie(seeded.facilityId, 'pagination');
    const seededCount = 205;
    const baseDetectedAt = new Date('2026-07-01T00:00:00.000Z');

    await direct.event.createMany({
      data: Array.from({ length: seededCount }, (_, index) => ({
        facilityId: seeded.facilityId,
        cameraId: seeded.cameraId,
        spaceId: seeded.spaceId,
        type: 'fall',
        detectedAt: new Date(baseDetectedAt.getTime() + index * 1_000),
        dedupKey: `${PREFIX}-pagination-${index}`,
      })),
    });

    const firstPage = await request(app.getHttpServer())
      .get('/api/v1/events')
      .set('cookie', cookie)
      .expect(200);
    expect(firstPage.body.items).toHaveLength(50);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app.getHttpServer())
      .get('/api/v1/events')
      .query({ cursor: firstPage.body.nextCursor })
      .set('cookie', cookie)
      .expect(200);
    expect(secondPage.body.items).toHaveLength(50);
    expect(
      secondPage.body.items.some((event: { id: string }) =>
        firstPage.body.items.some(
          (firstEvent: { id: string }) => firstEvent.id === event.id,
        ),
      ),
    ).toBe(false);

    const cappedPage = await request(app.getHttpServer())
      .get('/api/v1/events')
      .query({ limit: 500 })
      .set('cookie', cookie)
      .expect(200);
    expect(cappedPage.body.items).toHaveLength(200);

    const retrievedIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await request(app.getHttpServer())
        .get('/api/v1/events')
        .query(cursor ? { cursor } : {})
        .set('cookie', cookie)
        .expect(200);
      retrievedIds.push(...page.body.items.map((event: { id: string }) => event.id));
      cursor = page.body.nextCursor as string | null;
    } while (cursor);

    expect(retrievedIds).toHaveLength(seededCount);
    expect(new Set(retrievedIds).size).toBe(seededCount);
  });
  it('orders equal timestamps by id across cursor pages and rejects malformed cursors', async () => {
    const seeded = await seedFacilityGraph('pagination-ties');
    const cookie = await seedSessionCookie(
      seeded.facilityId,
      'pagination-ties',
    );
    const tieDetectedAt = new Date('2026-07-02T00:00:00.000Z');
    const events = [
      ...Array.from({ length: 55 }, (_, index) => ({
        id: `${PREFIX}-tie-${String(index).padStart(2, '0')}`,
        facilityId: seeded.facilityId,
        cameraId: seeded.cameraId,
        spaceId: seeded.spaceId,
        type: 'fall',
        detectedAt: tieDetectedAt,
        dedupKey: `${PREFIX}-pagination-tie-${index}`,
      })),
      {
        id: `${PREFIX}-newer-a`,
        facilityId: seeded.facilityId,
        cameraId: seeded.cameraId,
        spaceId: seeded.spaceId,
        type: 'fall',
        detectedAt: new Date('2026-07-02T00:01:00.000Z'),
        dedupKey: `${PREFIX}-pagination-tie-newer-a`,
      },
      {
        id: `${PREFIX}-newer-b`,
        facilityId: seeded.facilityId,
        cameraId: seeded.cameraId,
        spaceId: seeded.spaceId,
        type: 'fall',
        detectedAt: new Date('2026-07-02T00:02:00.000Z'),
        dedupKey: `${PREFIX}-pagination-tie-newer-b`,
      },
    ];
    await direct.event.createMany({ data: events });

    const expected = await direct.event.findMany({
      where: { facilityId: seeded.facilityId },
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    const firstPage = await request(app.getHttpServer())
      .get('/api/v1/events')
      .set('cookie', cookie)
      .expect(200);
    expect(firstPage.body.items.map((event: { id: string }) => event.id)).toEqual(
      expected.slice(0, 50).map((event) => event.id),
    );

    const retrievedIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await request(app.getHttpServer())
        .get('/api/v1/events')
        .query(cursor ? { cursor } : {})
        .set('cookie', cookie)
        .expect(200);
      retrievedIds.push(...page.body.items.map((event: { id: string }) => event.id));
      cursor = page.body.nextCursor as string | null;
    } while (cursor);

    expect(retrievedIds).toEqual(expected.map((event) => event.id));
    expect(new Set(retrievedIds).size).toBe(events.length);

    await request(app.getHttpServer())
      .get('/api/v1/events')
      .query({ cursor: '%%%' })
      .set('cookie', cookie)
      .expect(400);
  });

  it('rejects unsupported event types without persisting an Event row', async () => {
    const seeded = await seedFacilityGraph('invalid-type');
    const before = await direct.event.count({
      where: { facilityId: seeded.facilityId },
    });

    await postEvent({
      camera_id: seeded.cameraId,
      type: 'foo',
      detected_at: '2026-06-26T02:00:00.000Z',
      confidence: 0.5,
    }).expect(400);

    await expect(
      direct.event.count({ where: { facilityId: seeded.facilityId } }),
    ).resolves.toBe(before);
  });

  it('rejects non-string detected_at values without persisting an Event row', async () => {
    const seeded = await seedFacilityGraph('bad-detected-at');
    const before = await direct.event.count({
      where: { facilityId: seeded.facilityId },
    });

    await postEvent({
      camera_id: seeded.cameraId,
      type: 'fall',
      detected_at: 1750900923456,
      confidence: 0.5,
    }).expect(400);

    await postEvent({
      camera_id: seeded.cameraId,
      type: 'fall',
      detected_at: true,
      confidence: 0.5,
    }).expect(400);

    await postEvent({
      camera_id: seeded.cameraId,
      type: 'fall',
      detected_at: 'not-a-real-date',
      confidence: 0.5,
    }).expect(400);

    await expect(
      direct.event.count({ where: { facilityId: seeded.facilityId } }),
    ).resolves.toBe(before);
  });

  it('accepts detection-lost events', async () => {
    const seeded = await seedFacilityGraph('detection-lost');

    const created = await postEvent({
      camera_id: seeded.cameraId,
      type: 'detection-lost',
      detected_at: '2026-06-26T02:01:00.000Z',
    }).expect(201);

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
      postEvent(body).expect(201),
      postEvent(body).expect(201),
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

    await postEvent({
      camera_id: first.cameraId,
      type: 'fall',
      detected_at: '2026-06-26T03:10:00.000Z',
      confidence: 0.9,
    }).expect(201);
    await postEvent({
      camera_id: second.cameraId,
      type: 'fall',
      detected_at: '2026-06-26T03:10:01.000Z',
      confidence: 0.9,
    }).expect(201);

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

    await postEvent(body).expect(201);
    await postEvent(body).expect(201);

    expect(
      await direct.event.count({ where: { facilityId: seeded.facilityId } }),
    ).toBe(1);
    expect(
      await direct.alert.count({ where: { facilityId: seeded.facilityId } }),
    ).toBe(1);
    expect(received).toHaveLength(1);
  });

  function postEvent(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/events')
      .set('Authorization', `Bearer ${EDGE_TOKEN}`)
      .send(body);
  }

  function postHeartbeat(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/events/heartbeat')
      .set('Authorization', `Bearer ${EDGE_TOKEN}`)
      .send(body);
  }
  function putSnapshot(eventId: string, body: Buffer) {
    return request(app.getHttpServer())
      .put(`/api/v1/events/${eventId}/snapshot`)
      .set('Authorization', `Bearer ${EDGE_TOKEN}`)
      .set('Content-Type', 'image/jpeg')
      .send(body);
  }

  async function seedFacilityGraph(suffix: string) {
    const facility = await direct.facility.create({
      data: {
        name: `${PREFIX}-facility-${suffix}`,
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
