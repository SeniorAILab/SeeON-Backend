import {
  EdgeOmissionPreviewStatus,
  EdgeTopologySnapshotStatus,
  Prisma,
  type Prisma as PrismaTypes,
} from '@prisma/client';
import { Injectable } from '@nestjs/common';
import {
  bodyHash,
  uuidV7,
} from '../edge-credentials/edge-credential-crypto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  TOPOLOGY_ERROR_CODES,
  TopologyDomainError,
  type TopologyErrorCode,
} from './edge-topology.errors.js';
import { reconcileTopology } from './edge-topology-reconciler.js';
import { presentMutationResult } from './edge-topology-response.js';
import type { ApplySnapshotInput, OmittedRefs } from './edge-topology.types.js';

type RevisionRow = { readonly topology_revision: number };

@Injectable()
export class EdgeTopologyRepository {
  constructor(private readonly prisma: PrismaService) {}

  apply(input: ApplySnapshotInput) {
    return this.prisma.withFacilityContext(input.principal.facilityId, (tx) =>
      this.applyLocked(tx, input),
    );
  }

  private async applyLocked(
    tx: PrismaTypes.TransactionClient,
    input: ApplySnapshotInput,
  ) {
    const revision = await lockRevision(tx, input.principal.facilityId);
    const existing = await tx.edgeTopologySnapshot.findFirst({
      where: { id: input.snapshotId, facilityId: input.principal.facilityId },
    });
    if (existing !== null) {
      if (
        existing.edgeInstallationId !== input.principal.edgeInstallationId ||
        existing.enrollmentGeneration !==
          input.principal.enrollmentGeneration ||
        existing.bodyHash !== input.bodyHash
      ) {
        conflict(TOPOLOGY_ERROR_CODES.IDEMPOTENCY_CONFLICT);
      }
      if (existing.result === null) {
        conflict(TOPOLOGY_ERROR_CODES.TOPOLOGY_CONFLICT);
      }
      return existing.result;
    }
    const generation = await tx.edgeInstallationGeneration.findFirst({
      where: {
        facilityId: input.principal.facilityId,
        edgeInstallationId: input.principal.edgeInstallationId,
        generation: input.principal.enrollmentGeneration,
        installation: {
          currentGeneration: input.principal.enrollmentGeneration,
        },
      },
    });
    if (generation === null) {
      conflict(TOPOLOGY_ERROR_CODES.STALE_GENERATION);
    }
    if (
      input.snapshot.clientRevision !==
      generation.acceptedClientRevision + 1
    ) {
      conflict(TOPOLOGY_ERROR_CODES.CLIENT_REVISION);
    }
    if (input.snapshot.expectedServerRevision !== revision) {
      conflict(TOPOLOGY_ERROR_CODES.STALE_REVISION);
    }
    await tx.edgeOmissionPreview.updateMany({
      where: {
        facilityId: input.principal.facilityId,
        edgeInstallationId: input.principal.edgeInstallationId,
        enrollmentGeneration: input.principal.enrollmentGeneration,
        status: EdgeOmissionPreviewStatus.PENDING,
      },
      data: {
        status: EdgeOmissionPreviewStatus.INVALIDATED,
        invalidatedAt: input.now,
      },
    });
    const reconciliation = await reconcileTopology(
      tx,
      input.snapshot,
      input.principal.facilityId,
    );
    const serverRevision = revision + (reconciliation.changed ? 1 : 0);
    if (reconciliation.changed) {
      await advanceTopologyVersion(
        tx,
        input.principal.facilityId,
        serverRevision,
      );
    }
    await tx.edgeInstallationGeneration.update({
      where: { id: generation.id },
      data: { acceptedClientRevision: input.snapshot.clientRevision },
    });
    await tx.edgeTopologySnapshot.create({
      data: {
        id: input.snapshotId,
        facilityId: input.principal.facilityId,
        edgeInstallationId: input.principal.edgeInstallationId,
        enrollmentGeneration: input.principal.enrollmentGeneration,
        clientRevision: input.snapshot.clientRevision,
        expectedServerRevision: input.snapshot.expectedServerRevision,
        serverRevision,
        bodyHash: input.bodyHash,
        canonicalBody: input.snapshot,
        createdAt: input.now,
      },
    });
    const omissions = await createPreview(
      tx,
      input,
      serverRevision,
      reconciliation.omissions,
    );
    const response = {
      schemaVersion: 1,
      snapshotId: input.snapshotId,
      clientRevision: input.snapshot.clientRevision,
      serverRevision,
      result: presentMutationResult(reconciliation.result),
      omissions,
      ...(reconciliation.transfer === null
        ? {}
        : { ownershipTransferRequired: reconciliation.transfer }),
    };
    await tx.edgeTopologySnapshot.update({
      where: { id: input.snapshotId },
      data: {
        status: EdgeTopologySnapshotStatus.APPLIED,
        result: response,
        completedAt: input.now,
      },
    });
    await tx.edgeProvisioningAudit.create({
      data: {
        facilityId: input.principal.facilityId,
        edgeInstallationId: input.principal.edgeInstallationId,
        enrollmentGeneration: input.principal.enrollmentGeneration,
        action: 'TOPOLOGY_SNAPSHOT_APPLIED',
        outcome: 'SUCCEEDED',
        requestId: input.snapshotId,
        detail: {
          clientRevision: input.snapshot.clientRevision,
          serverRevision,
        },
        occurredAt: input.now,
      },
    });
    return response;
  }
}

async function createPreview(
  tx: PrismaTypes.TransactionClient,
  input: ApplySnapshotInput,
  serverRevision: number,
  refs: OmittedRefs,
) {
  if (refs.cameras.length + refs.rooms.length + refs.floors.length === 0)
    return null;
  const expiresAt = new Date(input.now.getTime() + 15 * 60 * 1000);
  const digest = bodyHash({
    facilityId: input.principal.facilityId,
    edgeInstallationId: input.principal.edgeInstallationId,
    enrollmentGeneration: input.principal.enrollmentGeneration,
    serverRevision,
    sortedOmittedEdgeRefs: refs,
    expiresAt: expiresAt.toISOString(),
  });
  const confirmationId = uuidV7(input.now.getTime());
  await tx.edgeOmissionPreview.create({
    data: {
      id: confirmationId,
      snapshotId: input.snapshotId,
      facilityId: input.principal.facilityId,
      edgeInstallationId: input.principal.edgeInstallationId,
      enrollmentGeneration: input.principal.enrollmentGeneration,
      serverRevision,
      digest,
      omittedFloorRefs: refs.floors,
      omittedRoomRefs: refs.rooms,
      omittedCameraRefs: refs.cameras,
      createdAt: input.now,
      expiresAt,
    },
  });
  return {
    confirmationId,
    digest,
    expiresAt: expiresAt.toISOString(),
    ...refs,
  };
}

export async function lockRevision(
  tx: PrismaTypes.TransactionClient,
  facilityId: string,
): Promise<number> {
  const rows = await tx.$queryRaw<RevisionRow[]>(Prisma.sql`
    SELECT topology_revision
    FROM facilities
    WHERE id = ${facilityId}
    FOR UPDATE
  `);
  if (rows.length === 0) conflict(TOPOLOGY_ERROR_CODES.STALE_GENERATION);
  return rows[0].topology_revision;
}

export async function advanceTopologyVersion(
  tx: PrismaTypes.TransactionClient,
  facilityId: string,
  serverRevision: number,
): Promise<void> {
  await tx.facility.update({
    where: { id: facilityId },
    data: { topologyRevision: serverRevision },
  });
  await tx.mlFacilityConfig.upsert({
    where: { facilityId },
    create: { facilityId, configVersion: 1 },
    update: { configVersion: { increment: 1 } },
  });
}

function conflict(code: TopologyErrorCode): never {
  throw new TopologyDomainError(409, code);
}
