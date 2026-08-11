import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module.js';
import { configureVersionedTestApp } from './versioned-app.js';

export const EDGE_LEGACY_TOKEN = 'edge-legacy-compat-characterization-token';

const PREFIX = 'edge-legacy-compat-t2';
const graph = {
  first: {
    facilityId: `${PREFIX}-facility-a`,
    floorId: `${PREFIX}-floor-a`,
    spaceId: `${PREFIX}-space-a`,
    cameraId: `${PREFIX}-camera-a`,
  },
  second: {
    facilityId: `${PREFIX}-facility-b`,
    floorId: `${PREFIX}-floor-b`,
    spaceId: `${PREFIX}-space-b`,
    cameraId: `${PREFIX}-camera-b`,
  },
} as const;

export type EdgeLegacyGraph = (typeof graph)[keyof typeof graph];

export type EdgeLegacyFixture = {
  readonly app: INestApplication<App>;
  readonly direct: PrismaClient;
  readonly first: EdgeLegacyGraph;
  readonly second: EdgeLegacyGraph;
  close(): Promise<void>;
};

export async function createEdgeLegacyFixture(): Promise<EdgeLegacyFixture> {
  if (!process.env.DIRECT_URL) throw new Error('DIRECT_URL is required');
  process.env.SESSION_JWT_SECRET =
    'edge-legacy-compat-session-secret-32-characters';
  process.env.FRONT_ORIGIN = 'http://localhost:3000';
  process.env.EDGE_FACILITY_TOKEN = EDGE_LEGACY_TOKEN;
  // The guards' legacy shared-token path is fail-closed by default; this
  // fixture exists specifically to characterize the transition-window
  // legacy path, so it must opt in explicitly.
  process.env.EDGE_LEGACY_COMPAT_ENABLED = 'true';
  // The legacy path never trusts a client-supplied x-facility-id; it is
  // always pinned server-side. This fixture pins it to the first facility
  // graph, so any legacy request lands there regardless of what facility id
  // it claims in headers.
  process.env.EDGE_LEGACY_FACILITY_ID = graph.first.facilityId;
  process.env.EVENT_CLIPS_ENABLED = 'true';
  const rootDir = await mkdtemp(join(tmpdir(), `${PREFIX}-`));
  process.env.MEDIA_CLIP_DIR = rootDir;
  process.env.SNAPSHOT_DIR = rootDir;
  const direct = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  await direct.$connect();
  await clearGraph(direct);
  await seedGraph(direct, graph.first);
  await seedGraph(direct, graph.second);
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app: INestApplication<App> = moduleFixture.createNestApplication();
  configureVersionedTestApp(app);
  await app.init();
  return {
    app,
    direct,
    first: graph.first,
    second: graph.second,
    async close(): Promise<void> {
      await app.close();
      await clearGraph(direct);
      await direct.$disconnect();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function seedGraph(
  direct: PrismaClient,
  fixtureGraph: EdgeLegacyGraph,
): Promise<void> {
  await direct.facility.create({
    data: {
      id: fixtureGraph.facilityId,
      name: `${fixtureGraph.facilityId}-name`,
    },
  });
  await direct.floor.create({
    data: {
      id: fixtureGraph.floorId,
      facilityId: fixtureGraph.facilityId,
      name: `${fixtureGraph.floorId}-name`,
      orderIndex: 1,
    },
  });
  await direct.space.create({
    data: {
      id: fixtureGraph.spaceId,
      facilityId: fixtureGraph.facilityId,
      floorId: fixtureGraph.floorId,
      name: `${fixtureGraph.spaceId}-name`,
      type: 'ROOM',
      capacity: 1,
    },
  });
  await direct.camera.create({
    data: {
      id: fixtureGraph.cameraId,
      facilityId: fixtureGraph.facilityId,
      spaceId: fixtureGraph.spaceId,
      label: `${fixtureGraph.cameraId}-label`,
    },
  });
}

async function clearGraph(direct: PrismaClient): Promise<void> {
  const facilityIds = Object.values(graph).map(({ facilityId }) => facilityId);
  await direct.mediaRetentionHold.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await direct.eventMediaBinding.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await direct.mediaClip.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await direct.alert.deleteMany({ where: { facilityId: { in: facilityIds } } });
  await direct.event.deleteMany({ where: { facilityId: { in: facilityIds } } });
  await direct.mlFacilityConfig.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await direct.camera.deleteMany({
    where: { facilityId: { in: facilityIds } },
  });
  await direct.space.deleteMany({ where: { facilityId: { in: facilityIds } } });
  await direct.floor.deleteMany({ where: { facilityId: { in: facilityIds } } });
  await direct.facility.deleteMany({ where: { id: { in: facilityIds } } });
}
