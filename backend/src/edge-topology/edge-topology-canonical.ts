import { bodyHash } from '../edge-credentials/edge-credential-crypto.js';
import type { EdgeTopologySnapshotRequestDto } from './dto/edge-topology.dto.js';
import {
  TOPOLOGY_ERROR_CODES,
  TopologyDomainError,
} from './edge-topology.errors.js';
import type { CanonicalSnapshot } from './edge-topology.types.js';

export function canonicalSnapshot(
  body: EdgeTopologySnapshotRequestDto,
): CanonicalSnapshot {
  const floors = body.floors
    .map((floor) => ({
      edgeRef: floor.edgeRef,
      name: floor.name,
      orderIndex: floor.orderIndex,
      rooms: floor.rooms
        .map((room) => ({
          edgeRef: room.edgeRef,
          name: room.name,
          type: room.type,
          capacity: room.capacity,
          ...(room.legacyCanonicalSpaceId === undefined
            ? {}
            : { legacyCanonicalSpaceId: room.legacyCanonicalSpaceId }),
          cameras: room.cameras
            .map((camera) => ({
              edgeRef: camera.edgeRef,
              label: camera.label,
            }))
            .sort(compareRef),
        }))
        .sort(compareRef),
    }))
    .sort(compareRef);
  const snapshot = {
    schemaVersion: 1,
    edgeInstallationId: body.edgeInstallationId,
    enrollmentGeneration: body.enrollmentGeneration,
    clientRevision: body.clientRevision,
    expectedServerRevision: body.expectedServerRevision,
    floors,
  } satisfies CanonicalSnapshot;
  assertUniqueTopology(snapshot);
  return snapshot;
}

export function snapshotHash(snapshot: CanonicalSnapshot): string {
  return bodyHash(snapshot);
}

function assertUniqueTopology(snapshot: CanonicalSnapshot): void {
  const floorRefs = new Set<string>();
  const roomRefs = new Set<string>();
  const cameraRefs = new Set<string>();
  const cameraLabels = new Set<string>();
  for (const floor of snapshot.floors) {
    addUnique(floorRefs, floor.edgeRef);
    for (const room of floor.rooms) {
      addUnique(roomRefs, room.edgeRef);
      for (const camera of room.cameras) {
        addUnique(cameraRefs, camera.edgeRef);
        addUnique(cameraLabels, camera.label);
      }
    }
  }
}

function addUnique(values: Set<string>, value: string): void {
  if (values.has(value)) {
    throw new TopologyDomainError(409, TOPOLOGY_ERROR_CODES.TOPOLOGY_CONFLICT);
  }
  values.add(value);
}

function compareRef<T extends { readonly edgeRef: string }>(left: T, right: T) {
  return left.edgeRef < right.edgeRef
    ? -1
    : left.edgeRef > right.edgeRef
      ? 1
      : 0;
}
