import type { Prisma } from '@prisma/client';

/**
 * Shared Alert read shape + presenter for the product `/api/v1/alerts` surface
 * and the lifecycle writer. Includes lifecycle audit actors so REST list/get/
 * replay carry current status + who/when for SSE-update recovery.
 */
export const alertInclude = {
  resident: { select: { name: true } },
  space: { select: { name: true } },
  ackedBy: { select: { nickname: true } },
  resolvedBy: { select: { nickname: true } },
} satisfies Prisma.AlertInclude;

export type AlertWithContext = Prisma.AlertGetPayload<{
  include: typeof alertInclude;
}>;

export function presentAlert(alert: AlertWithContext) {
  return {
    alertSeq: alert.alertSeq.toString(),
    id: alert.id,
    facilityId: alert.facilityId,
    residentId: alert.residentId,
    cameraId: alert.cameraId,
    spaceId: alert.spaceId,
    room: alert.space.name,
    type: alert.type,
    probability: alert.probability,
    snapshotKey: alert.snapshotKey,
    detectedAt: alert.detectedAt,
    status: alert.status,
    ackedById: alert.ackedById,
    ackedAt: alert.ackedAt,
    ackedBy: alert.ackedBy,
    resolvedById: alert.resolvedById,
    resolvedAt: alert.resolvedAt,
    resolvedBy: alert.resolvedBy,
    resident: alert.resident,
    space: alert.space,
    createdAt: alert.createdAt,
  };
}
