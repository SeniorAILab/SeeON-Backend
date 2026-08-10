import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
export class EdgeIssuanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async issue(input: {
    readonly facilityId: string;
    readonly facilityCode: string;
    readonly serverRevision: number;
    readonly credential: GeneratedCredential;
    readonly now: Date;
    readonly identity: MutationIdentity;
  }) {
    const edgeInstallationId = randomUUID();
    const result: StoredOperationResult = {
      schemaVersion: 1,
      operation: {
        operationId: input.identity.operationId,
        status: 'SUCCEEDED',
        createdAt: input.now.toISOString(),
        updatedAt: input.now.toISOString(),
      },
      credential: {
        tokenId: input.credential.tokenId,
        tokenPrefix: `${input.credential.prefix}.[redacted]`,
        facilityId: input.facilityId,
        edgeInstallationId,
        enrollmentGeneration: 1,
        lifecycle: 'ACTIVE',
        issuedAt: input.now.toISOString(),
        expiresAt: null,
        graceExpiresAt: null,
        revokedAt: null,
      },
      installation: {
        edgeInstallationId,
        facilityId: input.facilityId,
        enrollmentGeneration: 1,
        state: 'PENDING_CLAIM',
        clientInstallationRef: null,
        acceptedClientRevision: 0,
        serverRevision: input.serverRevision,
      },
      secretDisplay: 'NOT_AVAILABLE',
    };
    await this.prisma.withFacilityContext(input.facilityId, async (tx) => {
      await tx.facility.update({
        where: { id: input.facilityId },
        data: { edgeCode: input.facilityCode },
      });
      await tx.edgeInstallation.create({
        data: { id: edgeInstallationId, facilityId: input.facilityId },
      });
      await tx.edgeInstallationGeneration.create({
        data: {
          facilityId: input.facilityId,
          edgeInstallationId,
          generation: 1,
        },
      });
      await tx.edgeCredential.create({
        data: credentialCreateData({
          credential: input.credential,
          facilityId: input.facilityId,
          edgeInstallationId,
          enrollmentGeneration: 1,
          issuedAt: input.now,
        }),
      });
      await persistOperation({
        tx,
        facilityId: input.facilityId,
        operationType: 'ISSUE',
        identity: input.identity,
        result,
        completedAt: input.now,
      });
      await persistAudit({
        tx,
        facilityId: input.facilityId,
        edgeInstallationId,
        enrollmentGeneration: 1,
        identity: input.identity,
        action: 'CREDENTIAL_ISSUED',
        occurredAt: input.now,
      });
    });
    return { edgeInstallationId, result };
  }
}
