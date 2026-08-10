import { Injectable } from '@nestjs/common';
import { EdgeCredentialLifecycle, EdgeInstallationState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  GeneratedCredential,
  MutationIdentity,
  StoredOperationResult,
} from './edge-credential.types.js';
import {
  credentialCreateData,
  persistAudit,
  persistOperation,
} from './edge-persistence.js';

@Injectable()
export class EdgeReplacementRepository {
  constructor(private readonly prisma: PrismaService) {}

  async replace(input: {
    readonly edgeInstallationId: string;
    readonly expectedGeneration: number;
    readonly newClientInstallationRef: string;
    readonly credential: GeneratedCredential;
    readonly now: Date;
    readonly identity: MutationIdentity;
  }) {
    const installation = await this.prisma.db.edgeInstallation.findUnique({
      where: { id: input.edgeInstallationId },
    });
    if (
      installation === null ||
      installation.currentGeneration !== input.expectedGeneration
    ) {
      return null;
    }
    const nextGeneration = input.expectedGeneration + 1;
    const result: StoredOperationResult = {
      schemaVersion: 1,
      operation: operationSummary(input.identity.operationId, input.now),
      edgeInstallationId: installation.id,
      previousEnrollmentGeneration: input.expectedGeneration,
      enrollmentGeneration: nextGeneration,
      installationState: 'PENDING_CLAIM',
      oneTimeDisplay: {
        redacted: true,
        tokenId: input.credential.tokenId,
        prefix: input.credential.prefix,
      },
    };
    await this.prisma.withFacilityContext(
      installation.facilityId,
      async (tx) => {
        await tx.edgeOmissionPreview.updateMany({
          where: {
            edgeInstallationId: installation.id,
            status: 'PENDING',
          },
          data: { status: 'INVALIDATED', invalidatedAt: input.now },
        });
        await tx.edgeCredential.updateMany({
          where: {
            edgeInstallationId: installation.id,
            enrollmentGeneration: input.expectedGeneration,
            lifecycle: { in: ['ACTIVE', 'GRACE'] },
          },
          data: {
            lifecycle: EdgeCredentialLifecycle.REVOKED,
            revokedAt: input.now,
            revokedReason: 'INSTALLATION_REPLACED',
            graceExpiresAt: null,
          },
        });
        await tx.edgeInstallationGeneration.update({
          where: {
            facilityId_edgeInstallationId_generation: {
              facilityId: installation.facilityId,
              edgeInstallationId: installation.id,
              generation: input.expectedGeneration,
            },
          },
          data: {
            state: EdgeInstallationState.REPLACED,
            replacedAt: input.now,
          },
        });
        await tx.edgeInstallationGeneration.create({
          data: {
            facilityId: installation.facilityId,
            edgeInstallationId: installation.id,
            generation: nextGeneration,
            clientInstallationRef: input.newClientInstallationRef,
          },
        });
        await tx.edgeInstallation.update({
          where: { id: installation.id },
          data: { currentGeneration: nextGeneration },
        });
        await tx.edgeCredential.create({
          data: credentialCreateData({
            credential: input.credential,
            facilityId: installation.facilityId,
            edgeInstallationId: installation.id,
            enrollmentGeneration: nextGeneration,
            issuedAt: input.now,
          }),
        });
        await persistOperation({
          tx,
          facilityId: installation.facilityId,
          operationType: 'REPLACE',
          identity: input.identity,
          result,
          completedAt: input.now,
        });
        await persistAudit({
          tx,
          facilityId: installation.facilityId,
          edgeInstallationId: installation.id,
          enrollmentGeneration: nextGeneration,
          identity: input.identity,
          action: 'INSTALLATION_REPLACED',
          occurredAt: input.now,
        });
      },
    );
    return result;
  }
}

function operationSummary(operationId: string, now: Date) {
  return {
    operationId,
    status: 'SUCCEEDED',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}
