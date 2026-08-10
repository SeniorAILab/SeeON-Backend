import { ProvisioningSource, type Prisma } from '@prisma/client';
import {
  resolveTopologyAliases,
  type PendingAliases,
} from './edge-topology-aliases.js';
import {
  emptyMutationResult,
  type CanonicalSnapshot,
  type MutationResult,
  type OmittedRefs,
  type TransferItem,
} from './edge-topology.types.js';
import {
  upsertCamera,
  upsertFloor,
  upsertRoom,
} from './edge-topology-upserts.js';

export type Reconciliation = {
  readonly result: MutationResult;
  readonly omissions: OmittedRefs;
  readonly transfer: {
    readonly manifestDigest: string;
    readonly items: readonly TransferItem[];
  } | null;
  readonly changed: boolean;
};

export async function reconcileTopology(
  tx: Prisma.TransactionClient,
  snapshot: CanonicalSnapshot,
  facilityId: string,
): Promise<Reconciliation> {
  const aliases = await resolveTopologyAliases(tx, snapshot, facilityId);
  const result = emptyMutationResult();
  const floors = await tx.floor.findMany({
    where: { facilityId, edgeInstallationId: snapshot.edgeInstallationId },
  });
  const rooms = await tx.space.findMany({
    where: { facilityId, edgeInstallationId: snapshot.edgeInstallationId },
  });
  const cameras = await tx.camera.findMany({
    where: { facilityId, edgeInstallationId: snapshot.edgeInstallationId },
  });
  const floorByRef = new Map(floors.map((row) => [row.edgeRef, row]));
  const roomByRef = new Map(rooms.map((row) => [row.edgeRef, row]));
  const cameraByRef = new Map(cameras.map((row) => [row.edgeRef, row]));

  for (const floor of snapshot.floors) {
    if (aliases.floorRefs.has(floor.edgeRef)) {
      result.floors.unchanged += 1;
      countAliasedChildren(result, floor, aliases);
      continue;
    }
    const floorId = await upsertFloor(
      tx,
      snapshot,
      facilityId,
      floor,
      floorByRef.get(floor.edgeRef),
      result,
    );
    for (const room of floor.rooms) {
      if (aliases.roomRefs.has(room.edgeRef)) continue;
      const roomId = await upsertRoom(
        tx,
        snapshot,
        facilityId,
        floorId,
        room,
        roomByRef.get(room.edgeRef),
        result,
      );
      for (const camera of room.cameras) {
        if (aliases.cameraRefs.has(camera.edgeRef)) continue;
        await upsertCamera(
          tx,
          snapshot,
          facilityId,
          roomId,
          camera,
          cameraByRef.get(camera.edgeRef),
          result,
        );
      }
    }
  }
  const omissions = await omissionCandidates(tx, snapshot, facilityId);
  return {
    result,
    omissions,
    transfer: aliases.transfer,
    changed: Object.values(result).some(
      (counts) =>
        counts.created > 0 || counts.updated > 0 || counts.reactivated > 0,
    ),
  };
}

function countAliasedChildren(
  result: MutationResult,
  floor: CanonicalSnapshot['floors'][number],
  aliases: PendingAliases,
): void {
  for (const room of floor.rooms) {
    if (aliases.roomRefs.has(room.edgeRef)) result.rooms.unchanged += 1;
    for (const camera of room.cameras) {
      if (aliases.cameraRefs.has(camera.edgeRef)) result.cameras.unchanged += 1;
    }
  }
}

async function omissionCandidates(
  tx: Prisma.TransactionClient,
  snapshot: CanonicalSnapshot,
  facilityId: string,
): Promise<OmittedRefs> {
  const floorRefs = new Set(snapshot.floors.map((floor) => floor.edgeRef));
  const roomRefs = new Set(
    snapshot.floors.flatMap((floor) => floor.rooms.map((room) => room.edgeRef)),
  );
  const cameraRefs = new Set(
    snapshot.floors.flatMap((floor) =>
      floor.rooms.flatMap((room) =>
        room.cameras.map((camera) => camera.edgeRef),
      ),
    ),
  );
  const owner = {
    facilityId,
    edgeInstallationId: snapshot.edgeInstallationId,
    provisioningSource: ProvisioningSource.EDGE,
    isActive: true,
  };
  const [floors, rooms, cameras] = await Promise.all([
    tx.floor.findMany({ where: owner, select: { edgeRef: true } }),
    tx.space.findMany({ where: owner, select: { edgeRef: true } }),
    tx.camera.findMany({ where: owner, select: { edgeRef: true } }),
  ]);
  return {
    floors: refsNotIn(floors, floorRefs),
    rooms: refsNotIn(rooms, roomRefs),
    cameras: refsNotIn(cameras, cameraRefs),
  };
}

function refsNotIn(
  rows: readonly { readonly edgeRef: string | null }[],
  requested: ReadonlySet<string>,
): readonly string[] {
  return rows
    .flatMap((row) =>
      row.edgeRef === null || requested.has(row.edgeRef) ? [] : [row.edgeRef],
    )
    .sort();
}
