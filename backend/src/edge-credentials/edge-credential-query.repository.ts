import { Injectable } from '@nestjs/common';
import { EdgeInstallationState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CredentialBinding,
  EdgeAuthenticatedRequest,
  EdgeCredentialLifecycleName,
  EdgePrincipal,
} from './edge-credential.types.js';

@Injectable()
export class EdgeCredentialQueryRepository {
  constructor(private readonly prisma: PrismaService) {}

  findOperation(idempotencyKey: string) {
    return this.prisma.db.edgeAdminOperation.findUnique({
      where: { idempotencyKey },
    });
  }

  findOperationById(id: string) {
    return this.prisma.db.edgeAdminOperation.findUnique({ where: { id } });
  }

  findFacility(facilityId: string) {
    return this.prisma.db.facility.findUnique({ where: { id: facilityId } });
  }

  async facilityCodeExists(edgeCode: string): Promise<boolean> {
    return (
      (await this.prisma.db.facility.findUnique({
        where: { edgeCode },
        select: { id: true },
      })) !== null
    );
  }

  async expireCredential(tokenId: string, now: Date): Promise<void> {
    await this.prisma.db.edgeCredential.updateMany({
      where: {
        tokenId,
        lifecycle: { in: ['ACTIVE', 'GRACE'] },
      },
      data: { lifecycle: 'EXPIRED', revokedAt: now },
    });
  }

  list(facilityId?: string, lifecycle?: EdgeCredentialLifecycleName) {
    return this.prisma.db.edgeCredential.findMany({
      where: { facilityId, lifecycle },
      orderBy: { issuedAt: 'desc' },
    });
  }

  async findCredential(tokenId: string): Promise<CredentialBinding | null> {
    const credential = await this.prisma.db.edgeCredential.findUnique({
      where: { tokenId },
      include: {
        installationGeneration: {
          include: { installation: { include: { facility: true } } },
        },
      },
    });
    if (credential === null) return null;
    const generation = credential.installationGeneration;
    return {
      tokenId: credential.tokenId,
      tokenDigest: credential.tokenDigest,
      lifecycle: credential.lifecycle,
      expiresAt: credential.expiresAt,
      graceExpiresAt: credential.graceExpiresAt,
      facilityId: credential.facilityId,
      facilityCode: generation.installation.facility.edgeCode,
      facilityName: generation.installation.facility.name,
      serverRevision: generation.installation.facility.topologyRevision,
      edgeInstallationId: credential.edgeInstallationId,
      enrollmentGeneration: credential.enrollmentGeneration,
      currentGeneration: generation.installation.currentGeneration,
      installationDeactivatedAt: generation.installation.deactivatedAt,
      generationState: generation.state,
      clientInstallationRef: generation.clientInstallationRef,
    };
  }

  async claim(
    binding: CredentialBinding,
    clientInstallationRef: string,
    now: Date,
  ) {
    return this.prisma.withFacilityContext(binding.facilityId, async (tx) => {
      const key = {
        facilityId: binding.facilityId,
        edgeInstallationId: binding.edgeInstallationId,
        generation: binding.enrollmentGeneration,
      };
      const current = await tx.edgeInstallationGeneration.findUniqueOrThrow({
        where: { facilityId_edgeInstallationId_generation: key },
      });
      if (current.state === EdgeInstallationState.CLAIMED) return current;
      const expectedRef = current.clientInstallationRef;
      if (expectedRef !== null && expectedRef !== clientInstallationRef)
        return current;
      const result = await tx.edgeInstallationGeneration.updateMany({
        where: {
          ...key,
          state: EdgeInstallationState.PENDING_CLAIM,
          clientInstallationRef: expectedRef,
        },
        data: {
          state: EdgeInstallationState.CLAIMED,
          clientInstallationRef,
          claimedAt: now,
        },
      });
      if (result.count !== 1) {
        return tx.edgeInstallationGeneration.findUniqueOrThrow({
          where: { facilityId_edgeInstallationId_generation: key },
        });
      }
      return {
        ...current,
        state: EdgeInstallationState.CLAIMED,
        clientInstallationRef,
      };
    });
  }

  async activeValidationGrant(
    principal: EdgePrincipal,
    validationRunId: string,
    now: Date,
  ) {
    return this.prisma.withFacilityContext(principal.facilityId, (tx) =>
      tx.edgeValidationGrant.findFirst({
        where: {
          id: validationRunId,
          edgeInstallationId: principal.edgeInstallationId,
          enrollmentGeneration: principal.enrollmentGeneration,
          status: 'ACTIVE',
          expiresAt: { gt: now },
        },
      }),
    );
  }

  async requestResourcesBelongTo(
    request: EdgeAuthenticatedRequest,
    principal: EdgePrincipal,
  ): Promise<boolean> {
    const body = record(request.body);
    const cameraId =
      string(body?.camera_id) ??
      string(request.query?.camera_id) ??
      header(request.headers['x-edge-camera-id']);
    const eventId = request.params?.eventId ?? null;
    const spaceId = string(body?.spaceId);
    if (cameraId === null && eventId === null && spaceId === null) return true;
    return this.prisma.withFacilityContext(principal.facilityId, async (tx) => {
      if (cameraId !== null) {
        const camera = await tx.camera.findFirst({
          where: { OR: [{ id: cameraId }, { edgeRef: cameraId }] },
          select: { id: true },
        });
        if (camera === null) return false;
      }
      if (eventId !== null) {
        const event = await tx.event.findFirst({
          where: { id: eventId },
          select: { id: true },
        });
        if (event === null) return false;
      }
      if (spaceId !== null) {
        const space = await tx.space.findFirst({
          where: { id: spaceId },
          select: { id: true },
        });
        if (space === null) return false;
      }
      return true;
    });
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function header(value: string | string[] | undefined): string | null {
  return string(Array.isArray(value) ? value[0] : value);
}
