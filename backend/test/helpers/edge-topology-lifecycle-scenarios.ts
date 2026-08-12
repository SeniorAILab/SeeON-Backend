import type { EdgeTopologyHarness } from './edge-topology-harness.js';
import {
  FACILITY_ID,
  INSTALLATION_ID,
  MULTI_PRODUCT_CAMERA_ID_1,
  MULTI_PRODUCT_CAMERA_ID_2,
  MULTI_PRODUCT_FLOOR_ID,
  MULTI_PRODUCT_ROOM_ID_1,
  MULTI_PRODUCT_ROOM_ID_2,
  PRODUCT_CAMERA_ID,
  PRODUCT_FLOOR_ID,
  PRODUCT_ROOM_ID,
  expectCode,
  topologyBody,
} from './edge-topology-harness.js';
import {
  readArrayField,
  readNumber,
  readObject,
  readObjectField,
  readString,
} from './json-response.js';
import { aliasSnapshot } from './edge-topology-transfer-fixture.js';

export function registerTopologyLifecycleTests(
  harness: EdgeTopologyHarness,
): void {
  it('confirms once, soft-deactivates in place, and exactly replays', async () => {
    await harness.put(topologyBody()).expect(200);
    const camera = await harness.admin.camera.findFirstOrThrow({
      where: { edgeRef: 'camera-001' },
    });
    const room = await harness.admin.space.findFirstOrThrow({
      where: { edgeRef: 'room-201' },
    });
    const event = await harness.admin.event.create({
      data: {
        facilityId: FACILITY_ID,
        cameraId: camera.id,
        spaceId: room.id,
        type: 'fall',
        detectedAt: new Date(),
        dedupKey: 'task-10-history',
      },
    });
    const preview = responsePreview(
      (await harness.put(emptyTopology(2, 1), uuidV7(5)).expect(200)).body,
    );
    const confirmation = confirmationBody(preview);
    const first = await harness.confirm(confirmation, uuidV7(5)).expect(200);
    const replay = await harness.confirm(confirmation, uuidV7(5)).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(
      readNumber(
        readObject(first.body, 'confirmation').serverRevision,
        'serverRevision',
      ),
    ).toBe(preview.serverRevision + 1);
    const deactivated = await harness.admin.camera.findFirstOrThrow({
      where: { edgeRef: 'camera-001' },
    });
    expect(deactivated.isActive).toBe(false);
    expect(deactivated.edgeInstallationId).toBe(INSTALLATION_ID);
    await expect(
      harness.admin.event.findUnique({ where: { id: event.id } }),
    ).resolves.not.toBeNull();
  });

  it('rejects changed, expired, and revision-stale confirmations with zero writes', async () => {
    await harness.put(topologyBody()).expect(200);
    const preview = responsePreview(
      (await harness.put(emptyTopology(2, 1), uuidV7(6)).expect(200)).body,
    );
    const base = confirmationBody(preview);
    expectCode(
      (
        await harness
          .confirm({ ...base, digest: 'b'.repeat(64) }, uuidV7(6))
          .expect(409)
      ).body,
      'CONFIRMATION_STALE',
    );
    expectCode(
      (
        await harness
          .confirm({ ...base, expectedServerRevision: 99 }, uuidV7(6))
          .expect(409)
      ).body,
      'CONFIRMATION_STALE',
    );
    await harness.admin.edgeOmissionPreview.update({
      where: { id: preview.confirmationId },
      data: { createdAt: new Date(-1), expiresAt: new Date(0) },
    });
    expectCode(
      (await harness.confirm(base, uuidV7(6)).expect(410)).body,
      'CONFIRMATION_EXPIRED',
    );
    expect(
      (
        await harness.admin.camera.findFirstOrThrow({
          where: { edgeRef: 'camera-001' },
        })
      ).isActive,
    ).toBe(true);
  });

  it('reactivates the same canonical identities when refs reappear', async () => {
    await harness.put(topologyBody()).expect(200);
    const cameraId = (
      await harness.admin.camera.findFirstOrThrow({
        where: { edgeRef: 'camera-001' },
      })
    ).id;
    const preview = responsePreview(
      (await harness.put(emptyTopology(2, 1), uuidV7(7)).expect(200)).body,
    );
    await harness.confirm(confirmationBody(preview), uuidV7(7)).expect(200);
    const response = await harness
      .put(topologyBody(3, preview.serverRevision + 1), uuidV7(8))
      .expect(200);
    const result = readObjectField(
      readObject(response.body, 'reactivation'),
      'result',
    );
    const cameras = readObjectField(result, 'cameras');
    expect(readNumber(cameras.reactivated, 'reactivated')).toBe(1);
    const camera = await harness.admin.camera.findFirstOrThrow({
      where: { edgeRef: 'camera-001' },
    });
    expect(camera.id).toBe(cameraId);
    expect(camera.isActive).toBe(true);
  });

  it('persists same-facility aliases without claiming PRODUCT ownership', async () => {
    const transfer = await aliasSnapshot(harness);
    expect(transfer.items).toHaveLength(3);
    expect(
      await harness.admin.edgeTopologyAlias.count({
        where: { facilityId: FACILITY_ID },
      }),
    ).toBe(3);
    expect(
      (
        await harness.admin.space.findUniqueOrThrow({
          where: { id: PRODUCT_ROOM_ID },
        })
      ).provisioningSource,
    ).toBe('PRODUCT');
  });

  it('claims multiple rooms on one PRODUCT floor via opaque legacy ids in a single batch', async () => {
    await harness.seedMultiRoomProductTopology();
    const body = multiRoomClaimBody();
    const response = await harness.put(body).expect(200);
    const items = readArrayField(
      readObjectField(
        readObject(response.body, 'multiroom claim'),
        'ownershipTransferRequired',
      ),
      'items',
    ).map((value) => readObject(value, 'transfer item'));
    expect(items).toHaveLength(5);
    const byKind = (kind: string) => items.filter((item) => item.kind === kind);
    expect(byKind('FLOOR')).toHaveLength(1);
    expect(
      readString(byKind('FLOOR')[0].canonicalId, 'floor canonicalId'),
    ).toBe(MULTI_PRODUCT_FLOOR_ID);
    expect(
      byKind('ROOM')
        .map((item) => readString(item.canonicalId, 'room canonicalId'))
        .sort(),
    ).toEqual([MULTI_PRODUCT_ROOM_ID_1, MULTI_PRODUCT_ROOM_ID_2].sort());
    expect(
      byKind('CAMERA')
        .map((item) => readString(item.canonicalId, 'camera canonicalId'))
        .sort(),
    ).toEqual([MULTI_PRODUCT_CAMERA_ID_1, MULTI_PRODUCT_CAMERA_ID_2].sort());

    const replay = await harness.put(body).expect(200);
    expect(replay.body).toEqual(response.body);
  });

  it('rejects a partial legacy claim on a floor with a non-claiming room', async () => {
    await harness.seedMultiRoomProductTopology();
    const body = multiRoomClaimBody();
    delete body.floors[0].rooms[1].legacyCanonicalSpaceId;
    expectCode(
      (await harness.put(body).expect(409)).body,
      'TOPOLOGY_TRANSFER_CONFLICT',
    );
  });

  it('rejects two rooms on the same floor claiming the same legacy canonical space id', async () => {
    await harness.seedMultiRoomProductTopology();
    const body = multiRoomClaimBody();
    body.floors[0].rooms[1].legacyCanonicalSpaceId = MULTI_PRODUCT_ROOM_ID_1;
    expectCode(
      (await harness.put(body).expect(409)).body,
      'TOPOLOGY_TRANSFER_CONFLICT',
    );
  });

  it('rejects a snapshot floor whose claimed rooms resolve to different PRODUCT floors', async () => {
    await harness.seedProductTopology();
    await harness.seedMultiRoomProductTopology();
    const body = multiRoomClaimBody();
    body.floors[0].rooms[1].legacyCanonicalSpaceId = PRODUCT_ROOM_ID;
    expectCode(
      (await harness.put(body).expect(409)).body,
      'TOPOLOGY_TRANSFER_CONFLICT',
    );
  });

  it('converges approved aliases on the same canonical IDs before omissions apply', async () => {
    const transfer = await aliasSnapshot(harness);
    await harness.approveTransfer(transfer.digest, transfer.items, 0);
    const applied = readObject(
      (await harness.put(topologyBody(2, 1), uuidV7(10)).expect(200)).body,
      'transferred snapshot',
    );
    expect(applied.ownershipTransferRequired).toBeUndefined();
    expect(
      (
        await harness.admin.floor.findUniqueOrThrow({
          where: { id: PRODUCT_FLOOR_ID },
        })
      ).edgeRef,
    ).toBe('floor-2');
    expect(
      (
        await harness.admin.camera.findUniqueOrThrow({
          where: { id: PRODUCT_CAMERA_ID },
        })
      ).label,
    ).toBe('Camera Test');
  });

  it('rolls back every row when duplicate camera labels conflict mid-transaction', async () => {
    const body = topologyBody();
    body.floors.push({
      edgeRef: 'floor-3',
      name: '3F Test',
      orderIndex: 3,
      rooms: [
        {
          edgeRef: 'room-301',
          name: 'Room 301',
          type: 'ROOM',
          capacity: 1,
          cameras: [{ edgeRef: 'camera-002', label: 'Camera Test' }],
        },
      ],
    });
    expectCode((await harness.put(body).expect(409)).body, 'TOPOLOGY_CONFLICT');
    await expect(
      harness.admin.floor.count({ where: { facilityId: FACILITY_ID } }),
    ).resolves.toBe(0);
    await expect(harness.admin.edgeTopologySnapshot.count()).resolves.toBe(0);
  });
}

type Preview = {
  readonly confirmationId: string;
  readonly digest: string;
  readonly serverRevision: number;
};

function responsePreview(value: unknown): Preview {
  const response = readObject(value, 'preview response');
  const omissions = readObjectField(response, 'omissions');
  return {
    confirmationId: readString(omissions.confirmationId, 'confirmationId'),
    digest: readString(omissions.digest, 'digest'),
    serverRevision: readNumber(response.serverRevision, 'serverRevision'),
  };
}

function confirmationBody(preview: Preview) {
  return {
    schemaVersion: 1,
    confirmationId: preview.confirmationId,
    digest: preview.digest,
    expectedServerRevision: preview.serverRevision,
  };
}

function emptyTopology(clientRevision: number, serverRevision: number) {
  return { ...topologyBody(clientRevision, serverRevision), floors: [] };
}

function multiRoomClaimBody() {
  const body = topologyBody();
  body.floors[0].rooms = [
    {
      edgeRef: 'room-201',
      name: 'Room 201',
      type: 'ROOM',
      capacity: 1,
      legacyCanonicalSpaceId: MULTI_PRODUCT_ROOM_ID_1,
      cameras: [{ edgeRef: 'camera-201', label: 'Camera 201' }],
    },
    {
      edgeRef: 'room-202',
      name: 'Room 202',
      type: 'ROOM',
      capacity: 1,
      legacyCanonicalSpaceId: MULTI_PRODUCT_ROOM_ID_2,
      cameras: [{ edgeRef: 'camera-202', label: 'Camera 202' }],
    },
  ];
  return body;
}

function uuidV7(sequence: number): string {
  return `0197f671-3a31-7a6c-a6e4-${sequence.toString(16).padStart(12, '0')}`;
}
