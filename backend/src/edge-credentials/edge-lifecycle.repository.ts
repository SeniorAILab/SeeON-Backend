import { Injectable } from '@nestjs/common';
import { EdgeCredentialLifecycle } from '@prisma/client';
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
export class EdgeLifecycleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async rotate(input: {
    readonly tokenId: string;
    readonly replacement: GeneratedCredential;
    readonly now: Date;
    readonly graceEndsAt: Date;
    readonly identity: MutationIdentity;
  }) {
    const prior = await this.prisma.db.edgeCredential.findUnique({
      where: { tokenId: input.tokenId },
    });
    if (prior === null || prior.lifecycle !== EdgeCredentialLifecycle.ACTIVE)
      return null;
    const result: StoredOperationResult = {
      schemaVersion: 1,
      operationId: input.identity.operationId,
      edgeInstallationId: prior.edgeInstallationId,
      enrollmentGeneration: prior.enrollmentGeneration,
      prior: {
        tokenId: prior.tokenId,
        lifecycle: 'GRACE',
        graceEndsAt: input.graceEndsAt.toISOString(),
      },
      replacement: { lifecycle: 'ACTIVE' },
      oneTimeDisplay: {
        redacted: true,
        tokenId: input.replacement.tokenId,
        prefix: input.replacement.prefix,
      },
    };
    await this.prisma.withFacilityContext(prior.facilityId, async (tx) => {
      await tx.edgeCredential.update({
        where: { tokenId: prior.tokenId },
        data: {
          lifecycle: EdgeCredentialLifecycle.GRACE,
          graceExpiresAt: input.graceEndsAt,
        },
      });
      await tx.edgeCredential.create({
        data: credentialCreateData({
          credential: input.replacement,
          facilityId: prior.facilityId,
          edgeInstallationId: prior.edgeInstallationId,
          enrollmentGeneration: prior.enrollmentGeneration,
          issuedAt: input.now,
        }),
      });
      await persistOperation({
        tx,
        facilityId: prior.facilityId,
        operationType: 'ROTATE',
        identity: input.identity,
        result,
        completedAt: input.now,
      });
      await persistAudit({
        tx,
        facilityId: prior.facilityId,
        edgeInstallationId: prior.edgeInstallationId,
        enrollmentGeneration: prior.enrollmentGeneration,
        identity: input.identity,
        action: 'CREDENTIAL_ROTATED',
        occurredAt: input.now,
      });
    });
    return { prior, result };
  }

  async revoke(input: {
    readonly tokenId: string;
    readonly expectedLifecycle: EdgeCredentialLifecycle;
    readonly reason: string;
    readonly now: Date;
    readonly identity: MutationIdentity;
  }) {
    const credential = await this.prisma.db.edgeCredential.findUnique({
      where: { tokenId: input.tokenId },
    });
    if (credential === null || credential.lifecycle !== input.expectedLifecycle)
      return null;
    const result: StoredOperationResult = {
      schemaVersion: 1,
      operationId: input.identity.operationId,
      tokenId: credential.tokenId,
      lifecycle: 'REVOKED',
      revokedAt: input.now.toISOString(),
    };
    await this.prisma.withFacilityContext(credential.facilityId, async (tx) => {
      await tx.edgeCredential.update({
        where: { tokenId: credential.tokenId },
        data: {
          lifecycle: EdgeCredentialLifecycle.REVOKED,
          revokedAt: input.now,
          revokedReason: input.reason,
          graceExpiresAt: null,
        },
      });
      await persistOperation({
        tx,
        facilityId: credential.facilityId,
        operationType: 'REVOKE',
        identity: input.identity,
        result,
        completedAt: input.now,
      });
      await persistAudit({
        tx,
        facilityId: credential.facilityId,
        edgeInstallationId: credential.edgeInstallationId,
        enrollmentGeneration: credential.enrollmentGeneration,
        identity: input.identity,
        action: 'CREDENTIAL_REVOKED',
        occurredAt: input.now,
      });
    });
    return result;
  }

  async recover(input: {
    readonly lostTokenId: string;
    readonly replacement: GeneratedCredential;
    readonly now: Date;
    readonly identity: MutationIdentity;
  }) {
    const lost = await this.prisma.db.edgeCredential.findUnique({
      where: { tokenId: input.lostTokenId },
    });
    if (lost === null || lost.lifecycle === EdgeCredentialLifecycle.REVOKED)
      return null;
    const result: StoredOperationResult = {
      schemaVersion: 1,
      operation: operationSummary(input.identity.operationId, input.now),
      edgeInstallationId: lost.edgeInstallationId,
      enrollmentGeneration: lost.enrollmentGeneration,
      revokedTokenId: lost.tokenId,
      replacement: {
        tokenId: input.replacement.tokenId,
        prefix: input.replacement.prefix,
        lifecycle: 'ACTIVE',
      },
      oneTimeDisplay: {
        redacted: true,
        tokenId: input.replacement.tokenId,
        prefix: input.replacement.prefix,
      },
      replay: {
        redacted: true,
        tokenId: input.replacement.tokenId,
        prefix: input.replacement.prefix,
      },
    };
    await this.prisma.withFacilityContext(lost.facilityId, async (tx) => {
      const revoked = await tx.edgeCredential.updateMany({
        where: {
          tokenId: lost.tokenId,
          lifecycle: { not: EdgeCredentialLifecycle.REVOKED },
        },
        data: {
          lifecycle: EdgeCredentialLifecycle.REVOKED,
          revokedAt: input.now,
          revokedReason: 'SECRET_RECOVERY',
          graceExpiresAt: null,
        },
      });
      if (revoked.count !== 1) return;
      await tx.edgeCredential.create({
        data: credentialCreateData({
          credential: input.replacement,
          facilityId: lost.facilityId,
          edgeInstallationId: lost.edgeInstallationId,
          enrollmentGeneration: lost.enrollmentGeneration,
          issuedAt: input.now,
        }),
      });
      await persistOperation({
        tx,
        facilityId: lost.facilityId,
        operationType: 'RECOVER_SECRET',
        identity: input.identity,
        result,
        completedAt: input.now,
      });
      await persistAudit({
        tx,
        facilityId: lost.facilityId,
        edgeInstallationId: lost.edgeInstallationId,
        enrollmentGeneration: lost.enrollmentGeneration,
        identity: input.identity,
        action: 'SECRET_RECOVERED',
        occurredAt: input.now,
      });
    });
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
