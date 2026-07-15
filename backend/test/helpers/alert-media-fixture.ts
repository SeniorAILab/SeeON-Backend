import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { PrismaClient, type Role } from '@prisma/client';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureVersionedTestApp } from './versioned-app';

const TEST_SECRET = 'test-session-secret-minimum-32-characters';
const FIXTURE_PREFIX = 'alert-media-t15';

export const mediaFixtureIds = {
  facilityA: `${FIXTURE_PREFIX}-facility-a`,
  facilityB: `${FIXTURE_PREFIX}-facility-b`,
  adminA: `${FIXTURE_PREFIX}-admin-a`,
  staffA: `${FIXTURE_PREFIX}-staff-a`,
  revokedA: `${FIXTURE_PREFIX}-revoked-a`,
  superAdmin: `${FIXTURE_PREFIX}-super-admin`,
  alertA: `${FIXTURE_PREFIX}-alert-a`,
  alertB: `${FIXTURE_PREFIX}-alert-b`,
  pendingAlertA: `${FIXTURE_PREFIX}-alert-pending-a`,
  dueAlertA: `${FIXTURE_PREFIX}-alert-due-a`,
  futureAlertA: `${FIXTURE_PREFIX}-alert-future-a`,
  clipA: `${FIXTURE_PREFIX}-clip-a`,
  clipB: `${FIXTURE_PREFIX}-clip-b`,
  dueClipA: `${FIXTURE_PREFIX}-clip-due-a`,
  futureClipA: `${FIXTURE_PREFIX}-clip-future-a`,
} as const;

export const mediaBytes = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00,
  0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x61, 0x76, 0x63, 0x31,
]);
export const mediaSha256 = createHash('sha256')
  .update(mediaBytes)
  .digest('hex');
export const mediaEtag = `"sha256-${mediaSha256}"`;
export const mediaReadyAt = new Date('2026-07-16T00:00:11.000Z');

type SessionUser = {
  readonly id: string;
  readonly facilityId: string | null;
  readonly role: Role;
  readonly sessionVersion: number;
};

export type AlertMediaFixture = {
  readonly app: INestApplication<App>;
  readonly direct: PrismaClient;
  readonly rootDir: string;
  readonly adminCookie: string;
  readonly staffCookie: string;
  readonly revokedCookie: string;
  readonly superAdminCookie: string;
  close(): Promise<void>;
};

export async function createAlertMediaFixture(): Promise<AlertMediaFixture> {
  process.env.SESSION_JWT_SECRET = TEST_SECRET;
  process.env.EVENT_CLIPS_ENABLED = 'true';
  process.env.AUTH_COOKIE_SECURE = 'false';
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alert-media-t15-'));
  process.env.MEDIA_CLIP_DIR = rootDir;

  const direct = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  await direct.$connect();
  await cleanupFixtureRows(direct);

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app: INestApplication<App> = moduleFixture.createNestApplication();
  configureVersionedTestApp(app);
  await app.init();
  await seedFixture(direct, rootDir);

  const jwt = new JwtService({ secret: TEST_SECRET });
  const adminCookie = sessionCookie(jwt, {
    id: mediaFixtureIds.adminA,
    facilityId: mediaFixtureIds.facilityA,
    role: 'ADMIN',
    sessionVersion: 0,
  });
  const staffCookie = sessionCookie(jwt, {
    id: mediaFixtureIds.staffA,
    facilityId: mediaFixtureIds.facilityA,
    role: 'STAFF',
    sessionVersion: 0,
  });
  const revokedCookie = sessionCookie(jwt, {
    id: mediaFixtureIds.revokedA,
    facilityId: mediaFixtureIds.facilityA,
    role: 'ADMIN',
    sessionVersion: 0,
  });
  const superAdminCookie = sessionCookie(jwt, {
    id: mediaFixtureIds.superAdmin,
    facilityId: null,
    role: 'SUPER_ADMIN',
    sessionVersion: 0,
  });

  return {
    app,
    direct,
    rootDir,
    adminCookie,
    staffCookie,
    revokedCookie,
    superAdminCookie,
    async close(): Promise<void> {
      await app.close();
      await cleanupFixtureRows(direct);
      await direct.$disconnect();
      await fs.rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function seedFixture(
  direct: PrismaClient,
  rootDir: string,
): Promise<void> {
  await direct.facility.createMany({
    data: [
      { id: mediaFixtureIds.facilityA, name: 'Alert Media Facility A' },
      { id: mediaFixtureIds.facilityB, name: 'Alert Media Facility B' },
    ],
  });
  await direct.user.createMany({
    data: [
      user(mediaFixtureIds.adminA, mediaFixtureIds.facilityA, 'ADMIN', 0),
      user(mediaFixtureIds.staffA, mediaFixtureIds.facilityA, 'STAFF', 0),
      user(mediaFixtureIds.revokedA, mediaFixtureIds.facilityA, 'ADMIN', 1),
      user(mediaFixtureIds.superAdmin, null, 'SUPER_ADMIN', 0),
    ],
  });
  for (const suffix of ['a', 'b'] as const) {
    const facilityId =
      suffix === 'a' ? mediaFixtureIds.facilityA : mediaFixtureIds.facilityB;
    const clipId =
      suffix === 'a' ? mediaFixtureIds.clipA : mediaFixtureIds.clipB;
    await seedFacilityGraph(direct, facilityId, suffix);
    const storageKey = `${facilityId}/${clipId}/${mediaSha256}.mp4`;
    const filePath = path.join(rootDir, storageKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(filePath, mediaBytes, { mode: 0o600 });
  }
  for (const clipId of [
    mediaFixtureIds.dueClipA,
    mediaFixtureIds.futureClipA,
  ]) {
    const storageKey = `${mediaFixtureIds.facilityA}/${clipId}/${mediaSha256}.mp4`;
    const filePath = path.join(rootDir, storageKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(filePath, mediaBytes, { mode: 0o600 });
  }
}

async function seedFacilityGraph(
  direct: PrismaClient,
  facilityId: string,
  suffix: 'a' | 'b',
): Promise<void> {
  const upper = suffix === 'a' ? 'A' : 'B';
  const floorId = `${FIXTURE_PREFIX}-floor-${suffix}`;
  const spaceId = `${FIXTURE_PREFIX}-space-${suffix}`;
  const cameraId = `${FIXTURE_PREFIX}-camera-${suffix}`;
  const eventId = `${FIXTURE_PREFIX}-event-${suffix}`;
  const alertId = mediaFixtureIds[`alert${upper}`];
  const clipId = mediaFixtureIds[`clip${upper}`];
  await direct.floor.create({
    data: { id: floorId, facilityId, name: `Floor ${upper}`, orderIndex: 1 },
  });
  await direct.space.create({
    data: {
      id: spaceId,
      facilityId,
      floorId,
      name: `Room ${upper}`,
      type: 'ROOM',
      capacity: 1,
    },
  });
  await direct.camera.create({
    data: { id: cameraId, facilityId, spaceId, label: `Camera ${upper}` },
  });
  await direct.event.create({
    data: {
      id: eventId,
      facilityId,
      cameraId,
      spaceId,
      type: 'fall',
      confidence: 0.97,
      detectedAt: new Date('2026-07-15T23:59:55.000Z'),
      dedupKey: eventId,
    },
  });
  await direct.alert.create({
    data: {
      id: alertId,
      facilityId,
      cameraId,
      spaceId,
      type: 'fall',
      probability: 0.97,
      detectedAt: new Date('2026-07-15T23:59:55.000Z'),
      idempotencyKey: alertId,
      originEventId: eventId,
    },
  });
  const storageKey = `${facilityId}/${clipId}/${mediaSha256}.mp4`;
  await direct.mediaClip.create({
    data: {
      id: clipId,
      facilityId,
      cameraId,
      externalClipId: `edge-${clipId}`,
      status: 'READY',
      storageState: 'READY',
      storageKey,
      contentType: 'video/mp4',
      byteSize: BigInt(mediaBytes.length),
      sha256: mediaSha256,
      codec: 'h264',
      durationMs: 20_000,
      finalizedAt: mediaReadyAt,
      clipStartAt: new Date('2026-07-15T23:59:50.000Z'),
      clipEndAt: new Date('2026-07-16T00:00:10.000Z'),
      readyAt: mediaReadyAt,
    },
  });
  await direct.eventMediaBinding.create({
    data: { eventId, facilityId, clipId, ordinal: 0 },
  });
  if (suffix === 'a') {
    await direct.alert.create({
      data: {
        id: mediaFixtureIds.pendingAlertA,
        facilityId,
        cameraId,
        spaceId,
        type: 'fall',
        probability: 0.8,
        detectedAt: new Date('2026-07-16T00:01:00.000Z'),
        idempotencyKey: mediaFixtureIds.pendingAlertA,
      },
    });
    await seedExpiryGraph(direct, {
      facilityId,
      cameraId,
      spaceId,
      key: 'due',
      alertId: mediaFixtureIds.dueAlertA,
      clipId: mediaFixtureIds.dueClipA,
      expiresAt: new Date('2026-07-15T00:00:00.000Z'),
    });
    await seedExpiryGraph(direct, {
      facilityId,
      cameraId,
      spaceId,
      key: 'future',
      alertId: mediaFixtureIds.futureAlertA,
      clipId: mediaFixtureIds.futureClipA,
      expiresAt: new Date('2099-07-16T00:00:00.000Z'),
    });
  }
}

async function seedExpiryGraph(
  direct: PrismaClient,
  input: {
    readonly facilityId: string;
    readonly cameraId: string;
    readonly spaceId: string;
    readonly key: 'due' | 'future';
    readonly alertId: string;
    readonly clipId: string;
    readonly expiresAt: Date;
  },
): Promise<void> {
  const eventId = `${FIXTURE_PREFIX}-event-${input.key}-a`;
  const detectedAt = new Date('2026-07-16T00:02:00.000Z');
  await direct.event.create({
    data: {
      id: eventId,
      facilityId: input.facilityId,
      cameraId: input.cameraId,
      spaceId: input.spaceId,
      type: 'fall',
      confidence: 0.93,
      detectedAt,
      dedupKey: eventId,
    },
  });
  await direct.alert.create({
    data: {
      id: input.alertId,
      facilityId: input.facilityId,
      cameraId: input.cameraId,
      spaceId: input.spaceId,
      type: 'fall',
      probability: 0.93,
      detectedAt,
      idempotencyKey: input.alertId,
      originEventId: eventId,
    },
  });
  const storageKey = `${input.facilityId}/${input.clipId}/${mediaSha256}.mp4`;
  await direct.mediaClip.create({
    data: {
      id: input.clipId,
      facilityId: input.facilityId,
      cameraId: input.cameraId,
      externalClipId: `edge-${input.clipId}`,
      status: 'READY',
      storageState: 'READY',
      storageKey,
      contentType: 'video/mp4',
      byteSize: BigInt(mediaBytes.length),
      sha256: mediaSha256,
      codec: 'h264',
      durationMs: 20_000,
      finalizedAt: mediaReadyAt,
      clipStartAt: new Date('2026-07-15T23:59:50.000Z'),
      clipEndAt: new Date('2026-07-16T00:00:10.000Z'),
      readyAt: mediaReadyAt,
      expiresAt: input.expiresAt,
    },
  });
  await direct.eventMediaBinding.create({
    data: {
      eventId,
      facilityId: input.facilityId,
      clipId: input.clipId,
      ordinal: 0,
    },
  });
}

function user(
  id: string,
  facilityId: string | null,
  role: Role,
  sessionVersion: number,
) {
  return {
    id,
    facilityId,
    role,
    sessionVersion,
    nickname: id,
    email: `${id}@example.test`,
  };
}

function sessionCookie(jwt: JwtService, user: SessionUser): string {
  const token = jwt.sign({
    sub: user.id,
    role: user.role,
    facilityId: user.facilityId,
    sessionVersion: user.sessionVersion,
  });
  return `app_session=${token}`;
}

async function cleanupFixtureRows(direct: PrismaClient): Promise<void> {
  const facilityIds = [mediaFixtureIds.facilityA, mediaFixtureIds.facilityB];
  await direct.mediaAccessLog.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await direct.eventMediaBinding.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await direct.mediaRetentionHold.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await direct.mediaClip.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await direct.alert.deleteMany({ where: { facilityId: { in: facilityIds } } });
  await direct.event.deleteMany({ where: { facilityId: { in: facilityIds } } });
  await direct.camera.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await direct.space.deleteMany({ where: { facilityId: { in: facilityIds } } });
  await direct.floor.deleteMany({ where: { facilityId: { in: facilityIds } } });
  await direct.user.deleteMany({
    where: { id: { startsWith: FIXTURE_PREFIX } },
  });
  await direct.facility.deleteMany({ where: { id: { in: facilityIds } } });
}
