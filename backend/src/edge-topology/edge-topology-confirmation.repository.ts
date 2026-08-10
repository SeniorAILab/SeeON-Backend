import {
  EdgeOmissionPreviewStatus,
  ProvisioningSource,
  type Prisma,
} from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  TOPOLOGY_ERROR_CODES,
  TopologyDomainError,
} from './edge-topology.errors.js';
import {
  advanceTopologyVersion,
  lockRevision,
} from './edge-topology.repository.js';
import { confirmationMutationResult } from './edge-topology-response.js';
import type { ConfirmSnapshotInput } from './edge-topology.types.js';

@Injectable()
export class EdgeTopologyConfirmationRepository {
  constructor(private readonly prisma: PrismaService) {}

  confirm(input: ConfirmSnapshotInput) {
    return this.prisma.withFacilityContext(input.principal.facilityId, (tx) =>
      this.confirmLocked(tx, input),
    );
  }

  private async confirmLocked(
    tx: Prisma.TransactionClient,
    input: ConfirmSnapshotInput,
  ) {
    const revision = await lockRevision(tx, input.principal.facilityId);
    const snapshot = await tx.edgeTopologySnapshot.findFirst({
      where: { id: input.snapshotId, facilityId: input.principal.facilityId },
      include: { omissionPreview: true },
    });
    if (snapshot === null) stale();
    const preview = snapshot.omissionPreview;
    if (
      preview === null ||
      snapshot.edgeInstallationId !== input.principal.edgeInstallationId ||
      snapshot.enrollmentGeneration !== input.principal.enrollmentGeneration ||
      preview.id !== input.confirmationId ||
      preview.digest !== input.digest ||
      preview.serverRevision !== input.expectedServerRevision
    ) {
      stale();
    }
    if (
      preview.status === EdgeOmissionPreviewStatus.CONFIRMED &&
      preview.result !== null
    ) {
      return preview.result;
    }
    if (
      preview.status !== EdgeOmissionPreviewStatus.PENDING ||
      revision !== preview.serverRevision
    ) {
      stale();
    }
    if (input.now >= preview.expiresAt) {
      throw new TopologyDomainError(
        410,
        TOPOLOGY_ERROR_CODES.CONFIRMATION_EXPIRED,
      );
    }
    const refs = {
      floors: readRefs(preview.omittedFloorRefs),
      rooms: readRefs(preview.omittedRoomRefs),
      cameras: readRefs(preview.omittedCameraRefs),
    };
    await assertExactCandidates(tx, input, refs);
    const owner = {
      facilityId: input.principal.facilityId,
      edgeInstallationId: input.principal.edgeInstallationId,
      provisioningSource: ProvisioningSource.EDGE,
      isActive: true,
    };
    const cameras = await tx.camera.updateMany({
      where: { ...owner, edgeRef: { in: refs.cameras } },
      data: { isActive: false },
    });
    const rooms = await tx.space.updateMany({
      where: { ...owner, edgeRef: { in: refs.rooms } },
      data: { isActive: false },
    });
    const floors = await tx.floor.updateMany({
      where: { ...owner, edgeRef: { in: refs.floors } },
      data: { isActive: false },
    });
    const total = cameras.count + rooms.count + floors.count;
    const serverRevision = revision + (total > 0 ? 1 : 0);
    if (total > 0) {
      await advanceTopologyVersion(
        tx,
        input.principal.facilityId,
        serverRevision,
      );
    }
    const result = confirmationMutationResult({
      floors: floors.count,
      rooms: rooms.count,
      cameras: cameras.count,
    });
    const response = {
      schemaVersion: 1,
      snapshotId: snapshot.id,
      clientRevision: snapshot.clientRevision,
      serverRevision,
      result,
      omissions: null,
    };
    await tx.edgeOmissionPreview.update({
      where: { id: preview.id },
      data: {
        status: EdgeOmissionPreviewStatus.CONFIRMED,
        result: response,
        confirmedAt: input.now,
      },
    });
    await tx.edgeProvisioningAudit.create({
      data: {
        facilityId: input.principal.facilityId,
        edgeInstallationId: input.principal.edgeInstallationId,
        enrollmentGeneration: input.principal.enrollmentGeneration,
        action: 'TOPOLOGY_OMISSIONS_CONFIRMED',
        outcome: 'SUCCEEDED',
        requestId: input.snapshotId,
        detail: { confirmationId: input.confirmationId, serverRevision },
        occurredAt: input.now,
      },
    });
    return response;
  }
}

async function assertExactCandidates(
  tx: Prisma.TransactionClient,
  input: ConfirmSnapshotInput,
  refs: {
    readonly floors: string[];
    readonly rooms: string[];
    readonly cameras: string[];
  },
): Promise<void> {
  const owner = {
    facilityId: input.principal.facilityId,
    edgeInstallationId: input.principal.edgeInstallationId,
    provisioningSource: ProvisioningSource.EDGE,
    isActive: true,
  };
  const [floors, rooms, cameras] = await Promise.all([
    tx.floor.count({ where: { ...owner, edgeRef: { in: refs.floors } } }),
    tx.space.count({ where: { ...owner, edgeRef: { in: refs.rooms } } }),
    tx.camera.count({ where: { ...owner, edgeRef: { in: refs.cameras } } }),
  ]);
  if (
    floors !== refs.floors.length ||
    rooms !== refs.rooms.length ||
    cameras !== refs.cameras.length
  ) {
    stale();
  }
}

function readRefs(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) stale();
  const refs: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') stale();
    refs.push(item);
  }
  return refs;
}

function stale(): never {
  throw new TopologyDomainError(409, TOPOLOGY_ERROR_CODES.CONFIRMATION_STALE);
}
