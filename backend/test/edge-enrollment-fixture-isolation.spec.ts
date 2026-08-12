import { PrismaClient } from '@prisma/client';
import {
  CLOUD_EDGE_FIXTURE_IDS,
  CloudEdgeDbFixture,
  FACILITY_ID as CLOUD_FACILITY_ID,
} from './helpers/cloud-edge-db-fixture.js';
import {
  CLOUD_EDGE_IDEMPOTENCY_KEY_PREFIX,
  cloudEdgeUuidV7,
} from './helpers/cloud-edge-http-client.js';
import {
  cleanupEdgeEnrollmentFixtures,
  edgeEnrollmentUuidV7,
  EDGE_ENROLLMENT_FIXTURE_IDS,
  EDGE_ENROLLMENT_IDEMPOTENCY_KEY_PREFIX,
} from './helpers/edge-enrollment-db-fixture.js';
import {
  cleanupTopologyDb,
  resetTopologyDb,
} from './helpers/edge-topology-db-fixture.js';
import {
  EDGE_TOPOLOGY_COUNTER_PREFIX,
  EDGE_TOPOLOGY_FIXTURE_IDS,
  edgeTopologyUuidV7,
  FACILITY_ID as TOPOLOGY_FACILITY_ID,
} from './helpers/edge-topology-fixture-values.js';

describe('edge enrollment fixture isolation', () => {
  let direct: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DIRECT_URL) throw new Error('DIRECT_URL is required');
    direct = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
    await direct.$connect();
    await cleanupEdgeEnrollmentFixtures(direct);
    await cleanupTopologyDb(direct);
  });

  afterEach(async () => {
    await cleanupEdgeEnrollmentFixtures(direct);
    await cleanupTopologyDb(direct);
  });

  afterAll(async () => {
    await cleanupEdgeEnrollmentFixtures(direct);
    await cleanupTopologyDb(direct);
    await direct.$disconnect();
  });

  it('keeps suite-owned IDs and counter prefixes pairwise disjoint', () => {
    const allIds = [
      ...EDGE_ENROLLMENT_FIXTURE_IDS,
      ...EDGE_TOPOLOGY_FIXTURE_IDS,
      ...CLOUD_EDGE_FIXTURE_IDS,
    ];
    expect(new Set(allIds).size).toBe(allIds.length);

    const prefixes = [
      EDGE_ENROLLMENT_IDEMPOTENCY_KEY_PREFIX,
      EDGE_TOPOLOGY_COUNTER_PREFIX,
      CLOUD_EDGE_IDEMPOTENCY_KEY_PREFIX,
    ];
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(
      new Set([
        edgeEnrollmentUuidV7(1),
        edgeTopologyUuidV7(1),
        cloudEdgeUuidV7(1),
      ]).size,
    ).toBe(3);
  });

  it('preserves the topology graph and operation when enrollment cleans its graph', async () => {
    const pepper = process.env.EDGE_TOKEN_PEPPER;
    if (!pepper) throw new Error('EDGE_TOKEN_PEPPER is required');
    const operationId = edgeTopologyUuidV7(200);
    const idempotencyKey = edgeTopologyUuidV7(201);
    await resetTopologyDb(direct, pepper);
    await direct.edgeAdminOperation.create({
      data: {
        id: operationId,
        facilityId: TOPOLOGY_FACILITY_ID,
        idempotencyKey,
        operationType: 'FIXTURE_PROBE',
        bodyHash: 'a'.repeat(64),
      },
    });

    await cleanupEdgeEnrollmentFixtures(direct);

    await expect(
      direct.facility.findUnique({ where: { id: TOPOLOGY_FACILITY_ID } }),
    ).resolves.toMatchObject({ id: TOPOLOGY_FACILITY_ID });
    await expect(
      direct.edgeAdminOperation.findUnique({ where: { idempotencyKey } }),
    ).resolves.toMatchObject({ facilityId: TOPOLOGY_FACILITY_ID });
  });

  it('preserves the cloud graph and operation when enrollment cleans its graph', async () => {
    const cloud = new CloudEdgeDbFixture();
    await cloud.start();
    try {
      const operationId = cloudEdgeUuidV7(200);
      const idempotencyKey = cloudEdgeUuidV7(201);
      await cloud.direct.edgeAdminOperation.create({
        data: {
          id: operationId,
          facilityId: CLOUD_FACILITY_ID,
          idempotencyKey,
          operationType: 'FIXTURE_PROBE',
          bodyHash: 'b'.repeat(64),
        },
      });

      await cleanupEdgeEnrollmentFixtures(direct);

      await expect(
        cloud.direct.facility.findUnique({ where: { id: CLOUD_FACILITY_ID } }),
      ).resolves.toMatchObject({ id: CLOUD_FACILITY_ID });
      await expect(
        cloud.direct.edgeAdminOperation.findUnique({
          where: { idempotencyKey },
        }),
      ).resolves.toMatchObject({ facilityId: CLOUD_FACILITY_ID });
    } finally {
      await cloud.cleanup();
      await cloud.disconnect();
    }
  });
});
