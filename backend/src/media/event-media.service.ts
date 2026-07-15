import { Inject, Injectable } from '@nestjs/common';
import type { MediaClipReason, MediaHoldKind } from '@prisma/client';
import { CamerasService } from '../cameras/cameras.service.js';
import { ClipStorageService } from './clip-storage.service.js';
import { retentionExpiry } from './event-media.config.js';
import { EventMediaLifecycleRepository } from './event-media-lifecycle.repository.js';
import { EventMediaRepository } from './event-media.repository.js';
import {
  EVENT_MEDIA_ERROR_CODES,
  EventMediaError,
  type ClipReceipt,
  type EventMediaConfig,
  type ReadyClipUpload,
  type UnavailableClipReport,
} from './event-media.types.js';

export const EVENT_MEDIA_CONFIG = 'EVENT_MEDIA_CONFIG';

@Injectable()
export class EventMediaService {
  constructor(
    private readonly cameras: CamerasService,
    private readonly storage: ClipStorageService,
    private readonly repository: EventMediaRepository,
    private readonly lifecycle: EventMediaLifecycleRepository,
    @Inject(EVENT_MEDIA_CONFIG) private readonly config: EventMediaConfig,
  ) {}

  async capability(cameraId: string): Promise<{
    readonly event_idempotency: 1;
    readonly clip_export: 0 | 1;
  }> {
    await this.cameras.resolveForEventIngest(cameraId.trim());
    if (!this.config.enabled) {
      return { event_idempotency: 1, clip_export: 0 };
    }
    const hasCapacity = await this.storage.canAcceptMaximumClip();
    return { event_idempotency: 1, clip_export: hasCapacity ? 1 : 0 };
  }

  async uploadReady(input: ReadyClipUpload): Promise<ClipReceipt> {
    this.assertEnabled();
    const camera = await this.cameras.resolveForEventIngest(input.cameraId);
    const prepared = await this.repository.prepareReady(
      camera.facilityId,
      input,
    );
    if (prepared.state === 'READY') return readyReceipt(input);

    const persisted = await this.storage.persist({
      facilityId: camera.facilityId,
      clipId: prepared.id,
      expectedSha256: input.sha256,
      expectedSizeBytes: input.sizeBytes,
      source: input.source,
    });
    const clip = await this.repository.finalizeReady(
      camera.facilityId,
      prepared.id,
      persisted,
      retentionExpiry(input.finalizedAt, this.config.retentionDays),
    );
    return {
      clip_id: input.externalClipId,
      state: 'READY',
      state_version: clip.stateVersion,
      sha256: input.sha256,
      size_bytes: input.sizeBytes,
    };
  }

  async reportUnavailable(
    input: Omit<UnavailableClipReport, 'reason'> & {
      readonly reason: MediaClipReason;
    },
  ): Promise<ClipReceipt> {
    this.assertEnabled();
    const camera = await this.cameras.resolveForEventIngest(input.cameraId);
    const clip = await this.repository.reportUnavailable(
      camera.facilityId,
      input,
    );
    return {
      clip_id: input.externalClipId,
      state: 'UNAVAILABLE',
      state_version: clip.stateVersion,
    };
  }

  expireReady(facilityId: string, externalClipId: string, now: Date) {
    return this.lifecycle.expireReady(facilityId, externalClipId, now);
  }

  placeHold(input: {
    readonly facilityId: string;
    readonly externalClipId: string;
    readonly kind: MediaHoldKind;
    readonly reason: string;
    readonly actorUserId?: string;
  }) {
    return this.lifecycle.placeHold(input);
  }

  releaseHold(facilityId: string, holdId: string, actorUserId?: string) {
    return this.lifecycle.releaseHold(facilityId, holdId, actorUserId);
  }

  requestDeletion(facilityId: string, externalClipId: string): Promise<never> {
    return this.lifecycle.assertDeletionBlocked(facilityId, externalClipId);
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new EventMediaError(
        EVENT_MEDIA_ERROR_CODES.DISABLED,
        'event clip export is disabled',
      );
    }
  }
}

function readyReceipt(input: ReadyClipUpload): ClipReceipt {
  return {
    clip_id: input.externalClipId,
    state: 'READY',
    state_version: input.stateVersion,
    sha256: input.sha256,
    size_bytes: input.sizeBytes,
  };
}
