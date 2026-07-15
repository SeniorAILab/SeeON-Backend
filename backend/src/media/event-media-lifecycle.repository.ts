import { Injectable } from '@nestjs/common';
import type { MediaClip, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  EVENT_MEDIA_ERROR_CODES,
  EventMediaError,
  type PlaceMediaHold,
} from './event-media.types.js';

@Injectable()
export class EventMediaLifecycleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async expireReady(
    facilityId: string,
    externalClipId: string,
    now: Date,
  ): Promise<MediaClip> {
    return this.prisma.withFacilityContext(facilityId, async (tx) => {
      const clip = await findExternalClip(tx, facilityId, externalClipId);
      if (
        clip.status !== 'READY' ||
        clip.expiresAt === null ||
        clip.expiresAt.getTime() > now.getTime()
      ) {
        throw new EventMediaError(
          EVENT_MEDIA_ERROR_CODES.INVALID_TRANSITION,
          'clip is not eligible to expire',
        );
      }
      return tx.mediaClip.update({
        where: { id: clip.id },
        data: {
          status: 'EXPIRED',
          reason: 'RETENTION_EXPIRED',
          expiredAt: now,
          stateVersion: { increment: 1 },
        },
      });
    });
  }

  async placeHold(input: PlaceMediaHold) {
    return this.prisma.withFacilityContext(input.facilityId, async (tx) => {
      const clip = await findExternalClip(
        tx,
        input.facilityId,
        input.externalClipId,
      );
      return tx.mediaRetentionHold.create({
        data: {
          facilityId: input.facilityId,
          clipId: clip.id,
          kind: input.kind,
          reason: input.reason,
          createdByUserId: input.actorUserId,
        },
      });
    });
  }

  async releaseHold(
    facilityId: string,
    holdId: string,
    actorUserId?: string,
  ): Promise<void> {
    await this.prisma.withFacilityContext(facilityId, async (tx) => {
      const result = await tx.mediaRetentionHold.updateMany({
        where: { id: holdId, releasedAt: null },
        data: { releasedAt: new Date(), releasedByUserId: actorUserId },
      });
      if (result.count !== 1) {
        throw new EventMediaError(
          EVENT_MEDIA_ERROR_CODES.INVALID_TRANSITION,
          'active media hold not found',
        );
      }
    });
  }

  async assertDeletionBlocked(
    facilityId: string,
    externalClipId: string,
  ): Promise<never> {
    return this.prisma.withFacilityContext(facilityId, async (tx) => {
      const clip = await findExternalClip(tx, facilityId, externalClipId);
      if (clip.status !== 'EXPIRED') {
        throw new EventMediaError(
          EVENT_MEDIA_ERROR_CODES.INVALID_TRANSITION,
          'only expired clips can be considered for deletion',
        );
      }
      const activeHold = await tx.mediaRetentionHold.findFirst({
        where: { clipId: clip.id, releasedAt: null },
        select: { id: true },
      });
      if (activeHold) {
        throw new EventMediaError(
          EVENT_MEDIA_ERROR_CODES.HOLD_ACTIVE,
          'active retention hold prevents deletion',
        );
      }
      throw new EventMediaError(
        EVENT_MEDIA_ERROR_CODES.DELETION_DISABLED,
        'media deletion is disabled in phase one',
      );
    });
  }
}

async function findExternalClip(
  tx: Prisma.TransactionClient,
  facilityId: string,
  externalClipId: string,
): Promise<MediaClip> {
  const clip = await tx.mediaClip.findUnique({
    where: { facilityId_externalClipId: { facilityId, externalClipId } },
  });
  if (!clip) {
    throw new EventMediaError(
      EVENT_MEDIA_ERROR_CODES.EVENT_OWNERSHIP,
      'media clip not found in facility',
    );
  }
  return clip;
}
