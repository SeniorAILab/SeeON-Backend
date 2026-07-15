import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { App } from 'supertest/types';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { ClipStorageService } from '../../src/media/clip-storage.service.js';
import {
  EVENT_MEDIA_CONFIG,
  EventMediaService,
} from '../../src/media/event-media.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { configureVersionedTestApp } from './versioned-app.js';

export const EVENT_MEDIA_TEST_PREFIX = 'event-media-t14';
export const EVENT_MEDIA_EDGE_TOKEN = 'event-media-t14-edge-token';

export class EventMediaHarness {
  readonly direct: PrismaClient;
  readonly appRole: PrismaClient;
  private runningApp: INestApplication<App> | null = null;
  readonly canAcceptMaximumClip = jest.fn<Promise<boolean>, []>();
  readonly persist = jest.fn<
    ReturnType<ClipStorageService['persist']>,
    Parameters<ClipStorageService['persist']>
  >();

  constructor() {
    if (!process.env.DIRECT_URL || !process.env.DATABASE_URL) {
      throw new Error('DIRECT_URL and DATABASE_URL are required');
    }
    this.direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    this.appRole = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
  }

  async connect(): Promise<void> {
    await this.direct.$connect();
    await this.appRole.$connect();
  }

  async disconnect(): Promise<void> {
    await this.appRole.$disconnect();
    await this.direct.$disconnect();
  }

  async start(
    storageOverride?: Pick<
      ClipStorageService,
      'canAcceptMaximumClip' | 'persist' | 'reconcile'
    >,
  ): Promise<void> {
    process.env.SESSION_JWT_SECRET =
      'event-media-test-session-secret-32-characters';
    process.env.FRONT_ORIGIN = 'http://localhost:3000';
    process.env.EDGE_FACILITY_TOKEN = EVENT_MEDIA_EDGE_TOKEN;
    process.env.EVENT_CLIPS_ENABLED = 'false';
    this.canAcceptMaximumClip.mockReset().mockResolvedValue(true);
    this.persist.mockReset().mockImplementation((input) =>
      Promise.resolve({
        storageKey: `${input.facilityId}/${input.clipId}/${input.expectedSha256}.mp4`,
        sha256: input.expectedSha256,
        sizeBytes: input.expectedSizeBytes,
        codec: 'h264',
        durationMs: 1_000,
        duplicate: false,
      }),
    );
    const storage = {
      canAcceptMaximumClip: this.canAcceptMaximumClip,
      persist: this.persist,
      reconcile: jest.fn().mockResolvedValue({}),
    };
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ClipStorageService)
      .useValue(storageOverride ?? storage)
      .overrideProvider(EVENT_MEDIA_CONFIG)
      .useValue({ enabled: true, retentionDays: 60 })
      .compile();
    this.runningApp = moduleFixture.createNestApplication();
    const app = this.app;
    configureVersionedTestApp(app);
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
  }

  async stop(): Promise<void> {
    await this.app.close();
    this.runningApp = null;
  }

  get app(): INestApplication<App> {
    if (this.runningApp === null) throw new Error('test app is not running');
    return this.runningApp;
  }

  mediaService(): EventMediaService {
    return this.app.get(EventMediaService);
  }

  prismaService(): PrismaService {
    return this.app.get(PrismaService);
  }

  async seedGraph(suffix: string) {
    const facility = await this.direct.facility.create({
      data: { name: `${EVENT_MEDIA_TEST_PREFIX}-facility-${suffix}` },
    });
    const floor = await this.direct.floor.create({
      data: {
        facilityId: facility.id,
        name: `${EVENT_MEDIA_TEST_PREFIX}-floor-${suffix}`,
        orderIndex: 1,
      },
    });
    const space = await this.direct.space.create({
      data: {
        facilityId: facility.id,
        floorId: floor.id,
        name: `${EVENT_MEDIA_TEST_PREFIX}-space-${suffix}`,
        type: 'ROOM',
        capacity: 1,
      },
    });
    const camera = await this.direct.camera.create({
      data: {
        id: `${EVENT_MEDIA_TEST_PREFIX}-camera-${suffix}`,
        facilityId: facility.id,
        spaceId: space.id,
        label: `${EVENT_MEDIA_TEST_PREFIX}-camera-${suffix}`,
      },
    });
    return {
      facilityId: facility.id,
      cameraId: camera.id,
      spaceId: space.id,
    };
  }

  postEvent(input: {
    readonly cameraId: string;
    readonly edgeEventId: string;
    readonly detectedAt: string;
    readonly type?: string;
  }) {
    return request(this.app.getHttpServer())
      .post('/api/v1/events')
      .set('Authorization', `Bearer ${EVENT_MEDIA_EDGE_TOKEN}`)
      .send({
        camera_id: input.cameraId,
        edge_event_id: input.edgeEventId,
        type: input.type ?? 'fall',
        detected_at: input.detectedAt,
        confidence: 0.91,
      });
  }

  uploadReady(input: {
    readonly clipId: string;
    readonly cameraId: string;
    readonly eventRefs: readonly string[];
    readonly sha256: string;
    readonly body: Buffer;
    readonly declaredSizeBytes?: number;
    readonly durationMs?: number;
    readonly stateVersion?: number;
  }) {
    return request(this.app.getHttpServer())
      .put(`/api/v1/events/clips/${input.clipId}`)
      .set('Authorization', `Bearer ${EVENT_MEDIA_EDGE_TOKEN}`)
      .set('Content-Type', 'video/mp4')
      .set('x-edge-camera-id', input.cameraId)
      .set('x-edge-event-refs', JSON.stringify(input.eventRefs))
      .set('x-clip-start-at', '2026-07-16T00:00:00.000Z')
      .set('x-clip-end-at', '2026-07-16T00:00:01.000Z')
      .set('x-clip-finalized-at', '2026-07-16T00:00:02.000Z')
      .set('x-clip-sha256', input.sha256)
      .set(
        'x-clip-size-bytes',
        String(input.declaredSizeBytes ?? input.body.length),
      )
      .set('x-clip-duration-ms', String(input.durationMs ?? 1_000))
      .set('x-clip-state-version', String(input.stateVersion ?? 1))
      .send(input.body);
  }

  async cleanup(): Promise<void> {
    const facilities = await this.direct.facility.findMany({
      where: { name: { startsWith: EVENT_MEDIA_TEST_PREFIX } },
      select: { id: true },
    });
    const ids = facilities.map((facility) => facility.id);
    if (ids.length === 0) return;
    await this.direct.mediaRetentionHold.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.eventMediaBinding.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.mediaClip.deleteMany({
      where: { facilityId: { in: ids } },
    });
    await this.direct.alert.deleteMany({ where: { facilityId: { in: ids } } });
    await this.direct.event.deleteMany({ where: { facilityId: { in: ids } } });
    await this.direct.camera.deleteMany({ where: { facilityId: { in: ids } } });
    await this.direct.space.deleteMany({ where: { facilityId: { in: ids } } });
    await this.direct.floor.deleteMany({ where: { facilityId: { in: ids } } });
    await this.direct.user.deleteMany({ where: { facilityId: { in: ids } } });
    await this.direct.facility.deleteMany({ where: { id: { in: ids } } });
  }
}
