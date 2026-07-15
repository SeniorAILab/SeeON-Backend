import { Injectable } from '@nestjs/common';
import type { Event, MediaClip, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  EVENT_MEDIA_ERROR_CODES,
  EventMediaError,
  type PersistedReadyClip,
  type PreparedReadyClip,
  type ReadyClipManifest,
  type UnavailableClipReport,
} from './event-media.types.js';
import {
  immutableConflict,
  matchesPersistedClip,
  matchesReadyManifest,
  sameSet,
} from './event-media-repository.helpers.js';

type EventIdentity = Pick<Event, 'id' | 'edgeEventId' | 'cameraId'>;

@Injectable()
export class EventMediaRepository {
  constructor(private readonly prisma: PrismaService) {}

  async prepareReady(
    facilityId: string,
    manifest: ReadyClipManifest,
  ): Promise<PreparedReadyClip> {
    return this.prisma.withFacilityContext(facilityId, async (tx) => {
      const events = await requireOwnedEvents(tx, manifest);
      const clip = await tx.mediaClip.upsert({
        where: {
          facilityId_externalClipId: {
            facilityId,
            externalClipId: manifest.externalClipId,
          },
        },
        create: {
          facilityId,
          cameraId: manifest.cameraId,
          externalClipId: manifest.externalClipId,
          stateVersion: manifest.stateVersion,
          contentType: 'video/mp4',
          byteSize: BigInt(manifest.sizeBytes),
          sha256: manifest.sha256,
          codec: 'h264',
          durationMs: manifest.durationMs,
          clipStartAt: manifest.clipStartAt,
          clipEndAt: manifest.clipEndAt,
          finalizedAt: manifest.finalizedAt,
        },
        update: {},
      });
      await lockClip(tx, clip.id);
      const current = await tx.mediaClip.findUniqueOrThrow({
        where: { id: clip.id },
      });
      if (!matchesReadyManifest(current, manifest)) {
        throw immutableConflict();
      }
      await bindExactEvents(tx, facilityId, current.id, events);
      return {
        id: current.id,
        facilityId,
        state: current.status === 'READY' ? 'READY' : 'PENDING',
        storageKey: current.storageKey,
      };
    });
  }

  async finalizeReady(
    facilityId: string,
    clipId: string,
    persisted: PersistedReadyClip,
    expiresAt: Date,
  ): Promise<MediaClip> {
    return this.prisma.withFacilityContext(facilityId, async (tx) => {
      await lockClip(tx, clipId);
      const clip = await tx.mediaClip.findUniqueOrThrow({
        where: { id: clipId },
      });
      if (clip.status === 'READY') {
        if (!matchesPersistedClip(clip, persisted)) throw immutableConflict();
        return clip;
      }
      if (clip.status !== 'PENDING') {
        throw new EventMediaError(
          EVENT_MEDIA_ERROR_CODES.INVALID_TRANSITION,
          'clip cannot transition to READY from its current state',
        );
      }
      if (!matchesPersistedClip(clip, persisted, false)) {
        throw immutableConflict();
      }
      return tx.mediaClip.update({
        where: { id: clip.id },
        data: {
          status: 'READY',
          reason: null,
          storageState: 'READY',
          storageKey: persisted.storageKey,
          readyAt: new Date(),
          expiresAt,
        },
      });
    });
  }

  async reportUnavailable(
    facilityId: string,
    report: UnavailableClipReport,
  ): Promise<MediaClip> {
    return this.prisma.withFacilityContext(facilityId, async (tx) => {
      const events = await requireOwnedEvents(tx, report);
      const clip = await tx.mediaClip.upsert({
        where: {
          facilityId_externalClipId: {
            facilityId,
            externalClipId: report.externalClipId,
          },
        },
        create: {
          facilityId,
          cameraId: report.cameraId,
          externalClipId: report.externalClipId,
          status: 'UNAVAILABLE',
          stateVersion: report.stateVersion,
          reason: report.reason,
        },
        update: {},
      });
      await lockClip(tx, clip.id);
      const current = await tx.mediaClip.findUniqueOrThrow({
        where: { id: clip.id },
      });
      if (
        current.cameraId !== report.cameraId ||
        current.stateVersion !== report.stateVersion ||
        (current.status !== 'PENDING' &&
          (current.status !== 'UNAVAILABLE' ||
            current.reason !== report.reason))
      ) {
        throw immutableConflict();
      }
      await bindExactEvents(tx, facilityId, current.id, events);
      if (current.status === 'UNAVAILABLE') return current;
      return tx.mediaClip.update({
        where: { id: current.id },
        data: { status: 'UNAVAILABLE', reason: report.reason },
      });
    });
  }
}

async function requireOwnedEvents(
  tx: Prisma.TransactionClient,
  input: Pick<ReadyClipManifest, 'cameraId' | 'eventRefs'>,
): Promise<readonly EventIdentity[]> {
  const events = await tx.event.findMany({
    where: { edgeEventId: { in: [...input.eventRefs] } },
    select: { id: true, edgeEventId: true, cameraId: true },
  });
  if (
    events.length !== input.eventRefs.length ||
    events.some(
      (event) =>
        event.edgeEventId === null || event.cameraId !== input.cameraId,
    )
  ) {
    throw new EventMediaError(
      EVENT_MEDIA_ERROR_CODES.EVENT_OWNERSHIP,
      'event references do not belong to the resolved camera facility',
    );
  }
  return events;
}

async function bindExactEvents(
  tx: Prisma.TransactionClient,
  facilityId: string,
  clipId: string,
  events: readonly EventIdentity[],
): Promise<void> {
  const eventIds = events.map((event) => event.id);
  const current = await tx.eventMediaBinding.findMany({
    where: { clipId },
    select: { eventId: true },
  });
  if (
    current.length > 0 &&
    !sameSet(
      current.map((row) => row.eventId),
      eventIds,
    )
  ) {
    throw immutableConflict();
  }
  const occupied = await tx.eventMediaBinding.findMany({
    where: { eventId: { in: eventIds } },
    select: { eventId: true, clipId: true },
  });
  if (occupied.some((row) => row.clipId !== clipId)) throw immutableConflict();
  await tx.eventMediaBinding.createMany({
    data: events.map((event) => ({
      eventId: event.id,
      facilityId,
      clipId,
    })),
    skipDuplicates: true,
  });
  const bound = await tx.eventMediaBinding.findMany({
    where: { clipId },
    select: { eventId: true },
  });
  if (
    !sameSet(
      bound.map((row) => row.eventId),
      eventIds,
    )
  ) {
    throw immutableConflict();
  }
}

async function lockClip(
  tx: Prisma.TransactionClient,
  clipId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM media_clips WHERE id = ${clipId} FOR UPDATE`;
}
