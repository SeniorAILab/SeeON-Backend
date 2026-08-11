import type { EdgeTopologyHarness } from './edge-topology-harness.js';
import {
  FACILITY_ID,
  INSTALLATION_ID,
  OTHER_FACILITY_ID,
  PRODUCT_CAMERA_ID,
  SNAPSHOT_ID,
  expectCode,
  topologyBody,
} from './edge-topology-harness.js';
import {
  readNumber,
  readObject,
  readObjectField,
  readString,
} from './json-response.js';

export function registerTopologySnapshotTests(
  harness: EdgeTopologyHarness,
): void {
  it('rejects duplicate JSON keys at nested depths before applying topology', async () => {
    const raw = JSON.stringify(topologyBody()).replace(
      '"label":"Camera Test"',
      '"label":"Camera Test","label":"Changed"',
    );
    const response = await harness.putRaw(raw).expect(400);
    expectCode(response.body, 'INVALID_SCHEMA');
    await expect(harness.admin.edgeTopologySnapshot.count()).resolves.toBe(0);
  });

  it('applies one transaction and exactly replays the same snapshot hash', async () => {
    const first = await harness.put(topologyBody()).expect(200);
    const replay = await harness.put(topologyBody()).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(first.body).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        snapshotId: SNAPSHOT_ID,
        clientRevision: 1,
        serverRevision: 1,
        result: {
          floors: { created: 1, updated: 0, unchanged: 0 },
          rooms: { created: 1, updated: 0, unchanged: 0 },
          cameras: { created: 1, updated: 0, unchanged: 0 },
        },
        omissions: null,
      }),
    );
  });

  it('stamps lastSyncedAt on the EdgeInstallation inside the same transaction as the apply', async () => {
    const before = await harness.admin.edgeInstallation.findUniqueOrThrow({
      where: { id: INSTALLATION_ID },
    });
    expect(before.lastSyncedAt).toBeNull();

    const beforePut = new Date();
    await harness.put(topologyBody()).expect(200);

    const after = await harness.admin.edgeInstallation.findUniqueOrThrow({
      where: { id: INSTALLATION_ID },
    });
    expect(after.lastSyncedAt).not.toBeNull();
    expect(after.lastSyncedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
      beforePut.getTime(),
    );
  });

  it('conflicts when a snapshot ID is rebound to another semantic hash', async () => {
    await harness.put(topologyBody()).expect(200);
    const changed = topologyBody();
    changed.floors[0].name = 'Changed';
    expectCode(
      (await harness.put(changed).expect(409)).body,
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('enforces generation, server CAS, and exact client revision sequence', async () => {
    expectCode(
      (
        await harness
          .put({ ...topologyBody(), enrollmentGeneration: 2 })
          .expect(409)
      ).body,
      'STALE_ENROLLMENT_GENERATION',
    );
    expectCode(
      (await harness.put(topologyBody(1, 3)).expect(409)).body,
      'STALE_SERVER_REVISION',
    );
    expectCode(
      (await harness.put(topologyBody(2, 0)).expect(409)).body,
      'CLIENT_REVISION_OUT_OF_SEQUENCE',
    );
    await expect(
      harness.admin.floor.count({ where: { facilityId: FACILITY_ID } }),
    ).resolves.toBe(0);
  });

  it('advances a semantically identical next client revision without a server revision', async () => {
    await harness.put(topologyBody()).expect(200);
    const response = await harness
      .put(topologyBody(2, 1), uuidV7(2))
      .expect(200);
    const body = readObject(response.body, 'no-op response');
    expect(readNumber(body.serverRevision, 'serverRevision')).toBe(1);
    expect(body.omissions).toBeNull();
    const generation =
      await harness.admin.edgeInstallationGeneration.findFirstOrThrow({
        where: { edgeInstallationId: INSTALLATION_ID, generation: 1 },
      });
    expect(generation.acceptedClientRevision).toBe(2);
  });

  it('renames stable refs without ID churn', async () => {
    await harness.put(topologyBody()).expect(200);
    const before = await harness.admin.camera.findFirstOrThrow({
      where: { edgeRef: 'camera-001' },
    });
    const renamed = topologyBody(2, 1);
    renamed.floors[0].rooms[0].cameras[0].label = 'Renamed Camera';
    const response = await harness.put(renamed, uuidV7(3)).expect(200);
    expect(
      readNumber(
        readObject(response.body, 'rename').serverRevision,
        'revision',
      ),
    ).toBe(2);
    const after = await harness.admin.camera.findFirstOrThrow({
      where: { edgeRef: 'camera-001' },
    });
    expect(after.id).toBe(before.id);
    expect(after.label).toBe('Renamed Camera');
  });

  it('previews only active EDGE omissions owned by the same installation', async () => {
    await harness.put(topologyBody()).expect(200);
    await harness.seedProductTopology();
    await harness.seedOtherInstallationTopology();
    const response = await harness
      .put({ ...topologyBody(2, 1), floors: [] }, uuidV7(4))
      .expect(200);
    const omissions = readObjectField(
      readObject(response.body, 'preview'),
      'omissions',
    );
    expect(omissions).toEqual(
      expect.objectContaining({
        cameras: ['camera-001'],
        rooms: ['room-201'],
        floors: ['floor-2'],
      }),
    );
    expect(readString(omissions.expiresAt, 'expiresAt')).toMatch(/Z$/);
    expect(
      Date.parse(readString(omissions.expiresAt, 'expiresAt')) - Date.now(),
    ).toBeGreaterThan(14 * 60 * 1000);
    expect(
      (
        await harness.admin.camera.findUniqueOrThrow({
          where: { id: PRODUCT_CAMERA_ID },
        })
      ).isActive,
    ).toBe(true);
    expect(
      (
        await harness.admin.camera.findFirstOrThrow({
          where: { edgeRef: 'other-camera' },
        })
      ).isActive,
    ).toBe(true);
  });

  it('rejects duplicate refs and cross-facility aliases atomically', async () => {
    const duplicate = topologyBody();
    duplicate.floors.push({ ...duplicate.floors[0] });
    expectCode(
      (await harness.put(duplicate).expect(409)).body,
      'TOPOLOGY_CONFLICT',
    );
    await harness.seedProductTopology(OTHER_FACILITY_ID);
    const alias = topologyBody();
    alias.floors[0].rooms[0].legacyCanonicalSpaceId =
      'a2222222-2222-4222-8222-222222222222';
    expectCode(
      (await harness.put(alias, uuidV7(9)).expect(409)).body,
      'TOPOLOGY_TRANSFER_CONFLICT',
    );
    await expect(harness.admin.edgeTopologySnapshot.count()).resolves.toBe(0);
  });
}

function uuidV7(sequence: number): string {
  return `0197f671-3a31-7a6c-a6e4-${sequence.toString(16).padStart(12, '0')}`;
}
