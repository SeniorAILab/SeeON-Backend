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
import type { CanonicalSnapshot, TransferItem } from './edge-topology.types.js';

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
    for (const room of floor.rooms) {
      if (room.legacyCanonicalSpaceId !== undefined) {
        await persistLegacyClaim(tx, snapshot, facilityId, floor, room);
      }
    }
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

async function persistLegacyClaim(
  tx: Prisma.TransactionClient,
  snapshot: CanonicalSnapshot,
  facilityId: string,
  floor: CanonicalSnapshot['floors'][number],
  room: CanonicalSnapshot['floors'][number]['rooms'][number],
): Promise<void> {
  const canonical = await tx.space.findFirst({
    where: { id: room.legacyCanonicalSpaceId, facilityId },
    include: { floor: true, camera: true },
  });
  if (
    canonical === null ||
    canonical.provisioningSource !== ProvisioningSource.PRODUCT ||
    canonical.floor.provisioningSource !== ProvisioningSource.PRODUCT ||
    floor.rooms.length !== 1 ||
    room.cameras.length !== (canonical.camera === null ? 0 : 1)
  ) {
    transferConflict();
  }
  const items: TransferItem[] = [
    {
      kind: 'FLOOR',
      edgeRef: floor.edgeRef,
      canonicalId: canonical.floorId,
      parentCanonicalId: null,
    },
    {
      kind: 'ROOM',
      edgeRef: room.edgeRef,
      canonicalId: canonical.id,
      parentCanonicalId: canonical.floorId,
    },
  ];
  if (canonical.camera !== null) {
    const requestedCamera = room.cameras[0];
    items.push({
      kind: 'CAMERA',
      edgeRef: requestedCamera.edgeRef,
      canonicalId: canonical.camera.id,
      parentCanonicalId: canonical.id,
    });
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
