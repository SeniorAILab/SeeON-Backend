import { Injectable } from '@nestjs/common';
import type { MediaClip } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  bindExactEvents,
  lockClip,
  requireOwnedEvents,
} from './event-media-repository.bindings.js';
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
} from './event-media-repository.helpers.js';

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
      if (current.status === 'READY' || current.status === 'EXPIRED') {
        return preparedReadyClip(current, manifest.sha256);
      }
      // STAGED survives a process crash. Boot reconciliation removes transient
      // or unreferenced files; an exact SHA replay resumes this DB reservation.
      if (current.storageState === 'STAGED') {
        if (current.stagingToken !== manifest.sha256) {
          throw immutableConflict();
        }
        return preparedReadyClip(current, manifest.sha256);
      }
      if (current.storageState !== 'NONE') {
        throw new EventMediaError(
          EVENT_MEDIA_ERROR_CODES.INVALID_TRANSITION,
          'clip storage is not available for READY staging',
        );
      }
      const staged = await tx.mediaClip.update({
        where: { id: current.id },
        data: {
          storageState: 'STAGED',
          stagingToken: manifest.sha256,
          stagedAt: new Date(),
        },
      });
      return preparedReadyClip(staged, manifest.sha256);
    });
  }

  async finalizeReady(
    facilityId: string,
    clipId: string,
    persisted: PersistedReadyClip,
    stagingToken: string,
    expiresAt: Date,
  ): Promise<MediaClip> {
    return this.prisma.withFacilityContext(facilityId, async (tx) => {
      await lockClip(tx, clipId);
      const clip = await tx.mediaClip.findUniqueOrThrow({
        where: { id: clipId },
      });
      if (clip.status === 'READY' || clip.status === 'EXPIRED') {
        if (!matchesPersistedClip(clip, persisted)) throw immutableConflict();
        return clip;
      }
      if (
        clip.status !== 'PENDING' ||
        clip.storageState !== 'STAGED' ||
        clip.stagingToken !== stagingToken
      ) {
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
          stagingToken: null,
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
      if (current.status === 'PENDING' && current.storageState === 'STAGED') {
        throw new EventMediaError(
          EVENT_MEDIA_ERROR_CODES.INVALID_TRANSITION,
          'READY staging owns the clip transition',
        );
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

function preparedReadyClip(
  clip: MediaClip,
  stagingToken: string,
): PreparedReadyClip {
  if (
    clip.status !== 'PENDING' &&
    clip.status !== 'READY' &&
    clip.status !== 'EXPIRED'
  ) {
    throw new EventMediaError(
      EVENT_MEDIA_ERROR_CODES.INVALID_TRANSITION,
      'clip is not a READY lifecycle state',
    );
  }
  return {
    id: clip.id,
    facilityId: clip.facilityId,
    state: clip.status,
    stateVersion: clip.stateVersion,
    stagingToken,
    storageKey: clip.storageKey,
  };
}
