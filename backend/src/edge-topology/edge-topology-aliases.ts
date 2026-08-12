import {
  EdgeTopologyEntityKind,
  ProvisioningSource,
  type Prisma,
} from '@prisma/client';
import { bodyHash } from '../edge-credentials/edge-credential-crypto.js';
import {
  TOPOLOGY_ERROR_CODES,
  TopologyDomainError,
} from './edge-topology.errors.js';
import type {
  CanonicalFloor,
  CanonicalRoom,
  CanonicalSnapshot,
  TransferItem,
} from './edge-topology.types.js';

export type PendingAliases = {
  readonly floorRefs: ReadonlySet<string>;
  readonly roomRefs: ReadonlySet<string>;
  readonly cameraRefs: ReadonlySet<string>;
  readonly transfer: {
    readonly manifestDigest: string;
    readonly items: readonly TransferItem[];
  } | null;
};

export async function resolveTopologyAliases(
  tx: Prisma.TransactionClient,
  snapshot: CanonicalSnapshot,
  facilityId: string,
): Promise<PendingAliases> {
  for (const floor of snapshot.floors) {
    const claiming = floor.rooms.filter(
      (room) => room.legacyCanonicalSpaceId !== undefined,
    );
    if (claiming.length === 0) {
      continue;
    }
    await persistLegacyClaims(tx, snapshot, facilityId, floor, claiming);
  }
  const aliases = await tx.edgeTopologyAlias.findMany({
    where: {
      facilityId,
      edgeInstallationId: snapshot.edgeInstallationId,
      enrollmentGeneration: snapshot.enrollmentGeneration,
    },
    orderBy: [{ kind: 'asc' }, { edgeRef: 'asc' }],
  });
  const pending: TransferItem[] = [];
  for (const alias of aliases) {
    if (await remainsProductOwned(tx, alias.kind, alias.canonicalId)) {
      pending.push({
        kind: alias.kind,
        edgeRef: alias.edgeRef,
        canonicalId: alias.canonicalId,
        parentCanonicalId: alias.parentCanonicalId,
      });
    }
  }
  return {
    floorRefs: refSet(pending, 'FLOOR'),
    roomRefs: refSet(pending, 'ROOM'),
    cameraRefs: refSet(pending, 'CAMERA'),
    transfer:
      pending.length === 0
        ? null
        : { manifestDigest: bodyHash(pending), items: pending },
  };
}

async function persistLegacyClaims(
  tx: Prisma.TransactionClient,
  snapshot: CanonicalSnapshot,
  facilityId: string,
  floor: CanonicalFloor,
  claiming: readonly CanonicalRoom[],
): Promise<void> {
  // A floor alias must be unambiguous: the reconciler silently drops
  // non-aliased rooms on an aliased floor, so a partial claim is rejected.
  if (claiming.length !== floor.rooms.length) {
    transferConflict();
  }
  const resolved = await Promise.all(
    claiming.map(async (room) => ({
      room,
      canonical: await resolveClaimedSpace(tx, facilityId, room),
    })),
  );
  const floorIds = new Set(resolved.map(({ canonical }) => canonical.floorId));
  if (floorIds.size !== 1) {
    transferConflict();
  }
  const spaceIds = new Set(resolved.map(({ canonical }) => canonical.id));
  if (spaceIds.size !== resolved.length) {
    transferConflict();
  }
  const commonFloorId = resolved[0].canonical.floorId;
  const items: TransferItem[] = [
    {
      kind: 'FLOOR',
      edgeRef: floor.edgeRef,
      canonicalId: commonFloorId,
      parentCanonicalId: null,
    },
  ];
  for (const { room, canonical } of resolved) {
    items.push({
      kind: 'ROOM',
      edgeRef: room.edgeRef,
      canonicalId: canonical.id,
      parentCanonicalId: commonFloorId,
    });
    if (canonical.camera !== null) {
      const requestedCamera = room.cameras[0];
      items.push({
        kind: 'CAMERA',
        edgeRef: requestedCamera.edgeRef,
        canonicalId: canonical.camera.id,
        parentCanonicalId: canonical.id,
      });
    }
  }
  const existing = await tx.edgeTopologyAlias.findMany({
    where: {
      facilityId,
      edgeInstallationId: snapshot.edgeInstallationId,
      enrollmentGeneration: snapshot.enrollmentGeneration,
      OR: items.map((item) => ({ kind: item.kind, edgeRef: item.edgeRef })),
    },
  });
  if (existing.length > 0) {
    if (
      existing.length !== items.length ||
      items.some(
        (item) =>
          !existing.some(
            (alias) =>
              alias.kind === item.kind &&
              alias.edgeRef === item.edgeRef &&
              alias.canonicalId === item.canonicalId &&
              alias.parentCanonicalId === item.parentCanonicalId,
          ),
      )
    ) {
      transferConflict();
    }
    return;
  }
  await tx.edgeTopologyAlias.createMany({
    data: items.map((item) => ({
      facilityId,
      edgeInstallationId: snapshot.edgeInstallationId,
      enrollmentGeneration: snapshot.enrollmentGeneration,
      kind: EdgeTopologyEntityKind[item.kind],
      edgeRef: item.edgeRef,
      canonicalId: item.canonicalId,
      parentCanonicalId: item.parentCanonicalId,
    })),
  });
}

async function resolveClaimedSpace(
  tx: Prisma.TransactionClient,
  facilityId: string,
  room: CanonicalRoom,
) {
  const canonical = await tx.space.findFirst({
    where: { id: room.legacyCanonicalSpaceId, facilityId },
    include: { floor: true, camera: true },
  });
  if (
    canonical === null ||
    canonical.provisioningSource !== ProvisioningSource.PRODUCT ||
    canonical.floor.provisioningSource !== ProvisioningSource.PRODUCT ||
    room.cameras.length !== (canonical.camera === null ? 0 : 1)
  ) {
    transferConflict();
  }
  return canonical;
}

async function remainsProductOwned(
  tx: Prisma.TransactionClient,
  kind: EdgeTopologyEntityKind,
  canonicalId: string,
): Promise<boolean> {
  switch (kind) {
    case EdgeTopologyEntityKind.FLOOR:
      return (
        (await tx.floor.findUnique({ where: { id: canonicalId } }))
          ?.provisioningSource === ProvisioningSource.PRODUCT
      );
    case EdgeTopologyEntityKind.ROOM:
      return (
        (await tx.space.findUnique({ where: { id: canonicalId } }))
          ?.provisioningSource === ProvisioningSource.PRODUCT
      );
    case EdgeTopologyEntityKind.CAMERA:
      return (
        (await tx.camera.findUnique({ where: { id: canonicalId } }))
          ?.provisioningSource === ProvisioningSource.PRODUCT
      );
  }
}

function refSet(
  items: readonly TransferItem[],
  kind: TransferItem['kind'],
): ReadonlySet<string> {
  return new Set(
    items.filter((item) => item.kind === kind).map((item) => item.edgeRef),
  );
}

function transferConflict(): never {
  throw new TopologyDomainError(409, TOPOLOGY_ERROR_CODES.TRANSFER_CONFLICT);
}
