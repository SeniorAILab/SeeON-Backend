import { type INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module.js';
import { configureHttpBodyParsing } from '../../src/common/json/strict-json-parser.js';
import { EdgeAdminService } from '../../src/edge-credentials/edge-admin.service.js';
import { readObject } from './json-response.js';
import {
  cleanupTopologyDb,
  resetTopologyDb,
  seedOtherInstallationTopology,
  seedProductTopology,
} from './edge-topology-db-fixture.js';
export {
  FACILITY_ID,
  INSTALLATION_ID,
  OTHER_FACILITY_ID,
  PRODUCT_CAMERA_ID,
  PRODUCT_FLOOR_ID,
  PRODUCT_ROOM_ID,
  SNAPSHOT_ID,
} from './edge-topology-fixture-values.js';
import {
  FACILITY_ID,
  INSTALLATION_ID,
  SNAPSHOT_ID,
  TOKEN,
} from './edge-topology-fixture-values.js';

export type TopologyBody = {
  schemaVersion: 1;
  edgeInstallationId: string;
  enrollmentGeneration: number;
  clientRevision: number;
  expectedServerRevision: number;
  floors: Array<{
    edgeRef: string;
    name: string;
    orderIndex: number;
    rooms: Array<{
      edgeRef: string;
      name: string;
      type: 'ROOM';
      capacity: number;
      legacyCanonicalSpaceId?: string;
      cameras: Array<{ edgeRef: string; label: string }>;
    }>;
  }>;
};

export class EdgeTopologyHarness {
  readonly admin = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  private app?: INestApplication<App>;
  private edgeAdmin?: EdgeAdminService;

  async start(): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    this.app = moduleRef.createNestApplication({ bodyParser: false });
    this.edgeAdmin = moduleRef.get(EdgeAdminService);
    configureHttpBodyParsing(this.app);
    this.app.setGlobalPrefix('api');
    this.app.enableVersioning({ type: VersioningType.URI });
    await this.app.init();
    await this.admin.$connect();
  }

  async stop(): Promise<void> {
    await cleanupTopologyDb(this.admin);
    await this.app?.close();
    await this.admin.$disconnect();
  }

  async reset(): Promise<void> {
    await resetTopologyDb(this.admin, requiredPepper());
  }

  put(body: TopologyBody, snapshotId = SNAPSHOT_ID) {
    return request(this.server())
      .put(`/api/v1/edge/topology-snapshots/${snapshotId}`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);
  }

  putRaw(raw: string, snapshotId = SNAPSHOT_ID) {
    return request(this.server())
      .put(`/api/v1/edge/topology-snapshots/${snapshotId}`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(raw);
  }

  confirm(body: object, snapshotId = SNAPSHOT_ID) {
    return request(this.server())
      .post(`/api/v1/edge/topology-snapshots/${snapshotId}/confirm`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);
  }

  async seedProductTopology(facilityId = FACILITY_ID): Promise<void> {
    await seedProductTopology(this.admin, facilityId);
  }

  async seedOtherInstallationTopology(): Promise<void> {
    await seedOtherInstallationTopology(this.admin);
  }

  async approveTransfer(
    manifestDigest: string,
    manifest: readonly {
      readonly kind: 'FLOOR' | 'ROOM' | 'CAMERA';
      readonly edgeRef: string;
      readonly canonicalId: string;
      readonly parentCanonicalId: string | null;
    }[],
    expectedServerRevision: number,
  ) {
    if (this.edgeAdmin === undefined)
      throw new Error('topology harness is not started');
    return this.edgeAdmin.transfer(
      INSTALLATION_ID,
      {
        schemaVersion: 1,
        expectedEnrollmentGeneration: 1,
        expectedServerRevision,
        manifestDigest,
        manifest,
      },
      { idempotencyKey: uuidV7(90), actorUserId: 'task-10-admin' },
    );
  }

  private server(): App {
    if (this.app === undefined)
      throw new Error('topology harness is not started');
    return this.app.getHttpServer();
  }
}

export function topologyBody(
  clientRevision = 1,
  expectedServerRevision = 0,
): TopologyBody {
  return {
    schemaVersion: 1 as const,
    edgeInstallationId: INSTALLATION_ID,
    enrollmentGeneration: 1,
    clientRevision,
    expectedServerRevision,
    floors: [
      {
        edgeRef: 'floor-2',
        name: '2F Test',
        orderIndex: 2,
        rooms: [
          {
            edgeRef: 'room-201',
            name: 'Room Test',
            type: 'ROOM' as const,
            capacity: 1,
            cameras: [{ edgeRef: 'camera-001', label: 'Camera Test' }],
          },
        ],
      },
    ],
  };
}

export function expectCode(body: unknown, code: string): void {
  const envelope = readObject(body, 'error envelope');
  const error = readObject(envelope.error, 'error');
  expect(envelope.schemaVersion).toBe(1);
  expect(error.code).toBe(code);
  expect(error.retryable).toBe(false);
}

function requiredPepper(): string {
  const pepper = process.env.EDGE_TOKEN_PEPPER;
  if (pepper === undefined || pepper.length === 0) {
    throw new Error('EDGE_TOKEN_PEPPER is required for topology tests');
  }
  return pepper;
}

function uuidV7(sequence: number): string {
  return `0197f671-3a31-7a6c-a6e4-${sequence.toString(16).padStart(12, '0')}`;
}
