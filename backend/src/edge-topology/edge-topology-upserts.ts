import { ProvisioningSource, type Prisma } from '@prisma/client';
import type {
  CanonicalSnapshot,
  MutationResult,
} from './edge-topology.types.js';

export async function upsertFloor(
  tx: Prisma.TransactionClient,
  snapshot: CanonicalSnapshot,
  facilityId: string,
  floor: CanonicalSnapshot['floors'][number],
  existing:
    | Awaited<ReturnType<Prisma.TransactionClient['floor']['findFirst']>>
    | undefined,
  result: MutationResult,
): Promise<string> {
  if (existing === null || existing === undefined) {
    const created = await tx.floor.create({
      data: {
        facilityId,
        name: floor.name,
        orderIndex: floor.orderIndex,
        provisioningSource: ProvisioningSource.EDGE,
        edgeInstallationId: snapshot.edgeInstallationId,
        edgeRef: floor.edgeRef,
      },
    });
    result.floors.created += 1;
    return created.id;
  }
  const reactivated = !existing.isActive;
  const updated =
    existing.name !== floor.name || existing.orderIndex !== floor.orderIndex;
  if (reactivated || updated) {
    await tx.floor.update({
      where: { id: existing.id },
      data: { name: floor.name, orderIndex: floor.orderIndex, isActive: true },
    });
    if (reactivated) result.floors.reactivated += 1;
    if (updated) result.floors.updated += 1;
  } else result.floors.unchanged += 1;
  return existing.id;
}

export async function upsertRoom(
  tx: Prisma.TransactionClient,
  snapshot: CanonicalSnapshot,
  facilityId: string,
  floorId: string,
  room: CanonicalSnapshot['floors'][number]['rooms'][number],
  existing:
    | Awaited<ReturnType<Prisma.TransactionClient['space']['findFirst']>>
    | undefined,
  result: MutationResult,
): Promise<string> {
  if (existing === null || existing === undefined) {
    const created = await tx.space.create({
      data: {
        facilityId,
        floorId,
        name: room.name,
        type: room.type,
        capacity: room.capacity,
        provisioningSource: ProvisioningSource.EDGE,
        edgeInstallationId: snapshot.edgeInstallationId,
        edgeRef: room.edgeRef,
      },
    });
    result.rooms.created += 1;
    return created.id;
  }
  const reactivated = !existing.isActive;
  const updated =
    existing.floorId !== floorId ||
    existing.name !== room.name ||
    existing.type !== room.type ||
    existing.capacity !== room.capacity;
  if (reactivated || updated) {
    await tx.space.update({
      where: { id: existing.id },
      data: {
        floorId,
        name: room.name,
        type: room.type,
        capacity: room.capacity,
        isActive: true,
      },
    });
    if (reactivated) result.rooms.reactivated += 1;
    if (updated) result.rooms.updated += 1;
  } else result.rooms.unchanged += 1;
  return existing.id;
}

export async function upsertCamera(
  tx: Prisma.TransactionClient,
  snapshot: CanonicalSnapshot,
  facilityId: string,
  spaceId: string,
  camera: CanonicalSnapshot['floors'][number]['rooms'][number]['cameras'][number],
  existing:
    | Awaited<ReturnType<Prisma.TransactionClient['camera']['findFirst']>>
    | undefined,
  result: MutationResult,
): Promise<void> {
  if (existing === null || existing === undefined) {
    await tx.camera.create({
      data: {
        facilityId,
        spaceId,
        label: camera.label,
        provisioningSource: ProvisioningSource.EDGE,
        edgeInstallationId: snapshot.edgeInstallationId,
        edgeRef: camera.edgeRef,
      },
    });
    result.cameras.created += 1;
    return;
  }
  const reactivated = !existing.isActive;
  const updated =
    existing.spaceId !== spaceId || existing.label !== camera.label;
  if (reactivated || updated) {
    await tx.camera.update({
      where: { id: existing.id },
      data: { spaceId, label: camera.label, isActive: true },
    });
    if (reactivated) result.cameras.reactivated += 1;
    if (updated) result.cameras.updated += 1;
  } else result.cameras.unchanged += 1;
}
