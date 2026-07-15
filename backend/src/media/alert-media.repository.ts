import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  MediaAccessAction,
  MediaClipStatus,
  MediaStorageState,
  Prisma,
  Role,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

export type AlertMediaClipRecord = {
  readonly id: string;
  readonly status: MediaClipStatus;
  readonly storageState: MediaStorageState;
  readonly storageKey: string | null;
  readonly contentType: string | null;
  readonly byteSize: bigint | null;
  readonly sha256: string | null;
  readonly durationMs: number | null;
  readonly clipStartAt: Date | null;
  readonly clipEndAt: Date | null;
  readonly readyAt: Date | null;
  readonly expiredAt: Date | null;
  readonly deletedAt: Date | null;
};

export type AlertMediaRecord = {
  readonly alertId: string;
  readonly detectedAt: Date;
  readonly clip: AlertMediaClipRecord | null;
};

type AccessInput = {
  readonly facilityId: string;
  readonly actorUserId: string;
  readonly actorRole: Role;
  readonly alertId: string;
  readonly clipId: string | null;
  readonly action: MediaAccessAction;
  readonly interactionId: string;
};

const clipSelect = {
  id: true,
  status: true,
  storageState: true,
  storageKey: true,
  contentType: true,
  byteSize: true,
  sha256: true,
  durationMs: true,
  clipStartAt: true,
  clipEndAt: true,
  readyAt: true,
  expiredAt: true,
  deletedAt: true,
} satisfies Prisma.MediaClipSelect;

@Injectable()
export class AlertMediaRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByAlertId(
    facilityId: string,
    alertId: string,
  ): Promise<AlertMediaRecord | null> {
    return this.prisma.withFacilityContext(facilityId, async (tx) => {
      const alert = await tx.alert.findUnique({
        where: { id: alertId },
        select: {
          id: true,
          detectedAt: true,
          originEvent: {
            select: {
              mediaBinding: {
                select: { clip: { select: clipSelect } },
              },
            },
          },
        },
      });
      if (alert === null) return null;
      return {
        alertId: alert.id,
        detectedAt: alert.detectedAt,
        clip: alert.originEvent?.mediaBinding?.clip ?? null,
      };
    });
  }

  async recordExplicitAccess(input: AccessInput): Promise<void> {
    await this.prisma.withFacilityContext(input.facilityId, async (tx) => {
      await tx.mediaAccessLog.createMany({
        data: [
          {
            facilityId: input.facilityId,
            actorUserId: input.actorUserId,
            actorRole: input.actorRole,
            clipId: input.clipId,
            alertId: input.alertId,
            targetAlertHash: createHash('sha256')
              .update(input.alertId)
              .digest('hex'),
            action: input.action,
            outcome: 'ALLOWED',
            httpStatus: 201,
            requestId: randomUUID(),
            interactionId: input.interactionId,
          },
        ],
        skipDuplicates: true,
      });
      const stored = await tx.mediaAccessLog.findFirst({
        where: {
          actorUserId: input.actorUserId,
          interactionId: input.interactionId,
        },
        select: { alertId: true, clipId: true, action: true },
      });
      if (
        stored?.alertId !== input.alertId ||
        stored.clipId !== input.clipId ||
        stored.action !== input.action
      ) {
        throw new AlertMediaAccessConflictError(input.interactionId);
      }
    });
  }
}

export class AlertMediaAccessConflictError extends Error {
  readonly name = 'AlertMediaAccessConflictError';

  constructor(readonly interactionId: string) {
    super('media interaction id is already bound to another action');
  }
}
