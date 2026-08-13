import { Injectable } from '@nestjs/common';
import {
  EdgeOperationStatus,
  EdgeTopologyEntityKind,
  Prisma,
  ProvisioningSource,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  MutationIdentity,
  StoredOperationResult,
} from './edge-credential.types.js';
import { persistAudit, persistOperation } from './edge-persistence.js';

export type TransferItem = {
  readonly kind: EdgeTopologyEntityKind;
  readonly edgeRef: string;
  readonly canonicalId: string;
  readonly parentCanonicalId: string | null;
};

@Injectable()
export class EdgeAdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  findInstallation(id: string) {
    return this.prisma.db.edgeInstallation.findUnique({
      where: { id },
      include: { facility: true },
    });
  }

  async createValidationGrant(input: {
    readonly edgeInstallationId: string;
    readonly expectedGeneration: number;
    readonly validationRunId: string;
    readonly expiresAt: Date;
    readonly now: Date;
    readonly identity: MutationIdentity;
  }) {
    const installation = await this.findInstallation(input.edgeInstallationId);
    if (
      installation === null ||
      installation.currentGeneration !== input.expectedGeneration
    )
      return null;
    const result: StoredOperationResult = {
      schemaVersion: 1,
      operation: operationSummary(input.identity.operationId, input.now),
      validationRunId: input.validationRunId,
      edgeInstallationId: installation.id,
      enrollmentGeneration: input.expectedGeneration,
      status: 'ACTIVE',
      createdAt: input.now.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    };
    await this.prisma.withFacilityContext(
      installation.facilityId,
      async (tx) => {
        await tx.edgeValidationGrant.create({
          data: {
            id: input.validationRunId,
            facilityId: installation.facilityId,
            edgeInstallationId: installation.id,
            enrollmentGeneration: input.expectedGeneration,
            createdAt: input.now,
            expiresAt: input.expiresAt,
          },
        });
        await persistOperation({
          tx,
          facilityId: installation.facilityId,
          operationType: 'VALIDATION_RUN',
          identity: input.identity,
          result,
          completedAt: input.now,
        });
        await persistAudit({
          tx,
          facilityId: installation.facilityId,
          edgeInstallationId: installation.id,
          enrollmentGeneration: input.expectedGeneration,
          identity: input.identity,
          action: 'VALIDATION_RUN_CREATED',
          occurredAt: input.now,
        });
      },
    );
    return result;
  }

  async validationEvents(edgeInstallationId: string, validationRunId: string) {
    const installation = await this.findInstallation(edgeInstallationId);
    if (installation === null) return null;
    return this.prisma.withFacilityContext(installation.facilityId, (tx) =>
      tx.event.findMany({
        where: { validationRunId },
        orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      }),
    );
  }

  async applyTransfer(input: {
    readonly edgeInstallationId: string;
    readonly generation: number;
    readonly expectedServerRevision: number;
    readonly manifestDigest: string;
    readonly manifest: readonly TransferItem[];
    readonly now: Date;
    readonly identity: MutationIdentity;
  }) {
    const installation = await this.findInstallation(input.edgeInstallationId);
    if (
      installation === null ||
      installation.currentGeneration !== input.generation ||
      installation.facility.topologyRevision !== input.expectedServerRevision
    )
      return null;
    const appliedRevision =
      input.expectedServerRevision + (input.manifest.length > 0 ? 1 : 0);
    const counts = transferCounts(input.manifest);
    const result: StoredOperationResult = {
      schemaVersion: 1,
      operation: operationSummary(input.identity.operationId, input.now),
      edgeInstallationId: installation.id,
      enrollmentGeneration: input.generation,
      serverRevision: appliedRevision,
      transferred: counts,
      appliedAt: input.now.toISOString(),
    };
    await this.prisma.withFacilityContext(
      installation.facilityId,
      async (tx) => {
        await tx.edgeOwnershipTransfer.create({
          data: {
            id: input.identity.operationId,
            facilityId: installation.facilityId,
            edgeInstallationId: installation.id,
            enrollmentGeneration: input.generation,
            expectedServerRevision: input.expectedServerRevision,
            manifestDigest: input.manifestDigest,
            manifest: input.manifest,
            status: EdgeOperationStatus.SUCCEEDED,
            result,
            appliedServerRevision: appliedRevision,
            createdAt: input.now,
            appliedAt: input.now,
          },
        });
        if (input.manifest.length > 0) {
          await tx.facility.update({
            where: { id: installation.facilityId },
            data: { topologyRevision: appliedRevision },
          });
          for (const item of input.manifest)
            await transferItem(tx, installation.id, item);
        }
        await persistOperation({
          tx,
          facilityId: installation.facilityId,
          operationType: 'OWNERSHIP_TRANSFER',
          identity: input.identity,
          result,
          completedAt: input.now,
        });
        await persistAudit({
          tx,
          facilityId: installation.facilityId,
          edgeInstallationId: installation.id,
          enrollmentGeneration: input.generation,
          identity: input.identity,
          action: 'OWNERSHIP_TRANSFERRED',
          occurredAt: input.now,
        });
      },
    );
    return result;
  }
}

async function transferItem(
  tx: Prisma.TransactionClient,
  installationId: string,
  item: TransferItem,
): Promise<void> {
  const data = {
    provisioningSource: ProvisioningSource.EDGE,
    edgeInstallationId: installationId,
    edgeRef: item.edgeRef,
  };
  switch (item.kind) {
    case EdgeTopologyEntityKind.FLOOR:
      await tx.floor.update({ where: { id: item.canonicalId }, data });
      return;
    case EdgeTopologyEntityKind.ROOM:
      await tx.space.update({ where: { id: item.canonicalId }, data });
      return;
    case EdgeTopologyEntityKind.CAMERA:
      await tx.camera.update({ where: { id: item.canonicalId }, data });
      return;
  }
}

function transferCounts(manifest: readonly TransferItem[]) {
  return {
    floors: manifest.filter(
      (item) => item.kind === EdgeTopologyEntityKind.FLOOR,
    ).length,
    rooms: manifest.filter((item) => item.kind === EdgeTopologyEntityKind.ROOM)
      .length,
    cameras: manifest.filter(
      (item) => item.kind === EdgeTopologyEntityKind.CAMERA,
    ).length,
  };
}

function operationSummary(operationId: string, now: Date) {
  return {
    operationId,
    status: 'SUCCEEDED',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}
