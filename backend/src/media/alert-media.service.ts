import { ConflictException, Injectable } from '@nestjs/common';
import type { FileHandle } from 'node:fs/promises';
import type { Role } from '@prisma/client';
import { FacilityScopedNotFoundException } from '../common/domain-errors.js';
import type { AlertMediaAccessAction } from './dto/alert-media-access.dto.js';
import {
  AlertMediaAccessConflictError,
  AlertMediaRepository,
  type AlertMediaClipRecord,
} from './alert-media.repository.js';
import { AlertMediaFileError, openAlertMediaFile } from './alert-media-file.js';
import { readClipStorageConfig } from './clip-storage.config.js';

export type AlertMediaMetadata =
  | {
      readonly status: 'PENDING';
      readonly alertId: string;
      readonly retryAfterSeconds: null;
    }
  | {
      readonly status: 'READY';
      readonly alertId: string;
      readonly clip: {
        readonly contentType: 'video/mp4';
        readonly detectedAt: Date;
        readonly clipStartAt: Date;
        readonly clipEndAt: Date;
        readonly durationSeconds: number;
      };
    }
  | { readonly status: 'UNAVAILABLE'; readonly alertId: string }
  | {
      readonly status: 'EXPIRED';
      readonly alertId: string;
      readonly expiredAt: Date;
    }
  | {
      readonly status: 'DELETED';
      readonly alertId: string;
      readonly deletedAt: Date;
    };

export type OpenedAlertMedia = {
  readonly handle: FileHandle;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly readyAt: Date;
};

@Injectable()
export class AlertMediaService {
  constructor(private readonly repository: AlertMediaRepository) {}

  async metadata(
    facilityId: string,
    alertId: string,
  ): Promise<AlertMediaMetadata> {
    this.requireEnabled();
    const record = await this.repository.findByAlertId(facilityId, alertId);
    if (record === null) throw notFound();
    const clip = record.clip;
    if (clip === null) return pending(record.alertId);

    switch (clip.status) {
      case 'PENDING':
        return pending(record.alertId);
      case 'READY':
        if (!isReadyMetadata(clip)) {
          return { status: 'UNAVAILABLE', alertId: record.alertId };
        }
        return {
          status: 'READY',
          alertId: record.alertId,
          clip: {
            contentType: 'video/mp4',
            detectedAt: record.detectedAt,
            clipStartAt: clip.clipStartAt,
            clipEndAt: clip.clipEndAt,
            durationSeconds: clip.durationMs / 1_000,
          },
        };
      case 'UNAVAILABLE':
        return { status: 'UNAVAILABLE', alertId: record.alertId };
      case 'EXPIRED':
        return clip.expiredAt === null
          ? { status: 'UNAVAILABLE', alertId: record.alertId }
          : {
              status: 'EXPIRED',
              alertId: record.alertId,
              expiredAt: clip.expiredAt,
            };
      case 'DELETED':
        return clip.deletedAt === null
          ? { status: 'UNAVAILABLE', alertId: record.alertId }
          : {
              status: 'DELETED',
              alertId: record.alertId,
              deletedAt: clip.deletedAt,
            };
      default:
        return assertNever(clip.status);
    }
  }

  async recordAccess(input: {
    readonly facilityId: string;
    readonly alertId: string;
    readonly actorUserId: string;
    readonly actorRole: Role;
    readonly action: AlertMediaAccessAction;
    readonly interactionId: string;
  }): Promise<{ readonly accepted: true }> {
    this.requireEnabled();
    const record = await this.repository.findByAlertId(
      input.facilityId,
      input.alertId,
    );
    if (record === null) throw notFound();
    try {
      await this.repository.recordExplicitAccess({
        ...input,
        clipId: record.clip?.id ?? null,
      });
    } catch (error) {
      if (error instanceof AlertMediaAccessConflictError) {
        throw new ConflictException('Interaction id conflict');
      }
      throw error;
    }
    return { accepted: true };
  }

  async openContent(
    facilityId: string,
    alertId: string,
  ): Promise<OpenedAlertMedia> {
    this.requireEnabled();
    const record = await this.repository.findByAlertId(facilityId, alertId);
    if (record === null) throw notFound();
    const clip = record.clip;
    if (clip === null || clip.status === 'PENDING') {
      throw new ConflictException('Media is pending');
    }
    if (!isReadyContent(clip)) throw notFound();
    try {
      const file = await openAlertMediaFile({
        rootDir: readClipStorageConfig().rootDir,
        facilityId,
        storageKey: clip.storageKey,
        sha256: clip.sha256,
        expectedSizeBytes: Number(clip.byteSize),
      });
      return {
        handle: file.handle,
        sizeBytes: file.sizeBytes,
        sha256: clip.sha256,
        readyAt: clip.readyAt,
      };
    } catch (error) {
      if (error instanceof AlertMediaFileError) throw notFound();
      throw error;
    }
  }

  private requireEnabled(): void {
    if (process.env.EVENT_CLIPS_ENABLED !== 'true') throw notFound();
  }
}

function isReadyMetadata(
  clip: AlertMediaClipRecord,
): clip is AlertMediaClipRecord & {
  readonly contentType: 'video/mp4';
  readonly durationMs: number;
  readonly clipStartAt: Date;
  readonly clipEndAt: Date;
} {
  return (
    clip.contentType === 'video/mp4' &&
    clip.durationMs !== null &&
    clip.durationMs > 0 &&
    clip.clipStartAt !== null &&
    clip.clipEndAt !== null
  );
}

function isReadyContent(
  clip: AlertMediaClipRecord,
): clip is AlertMediaClipRecord & {
  readonly status: 'READY';
  readonly storageKey: string;
  readonly byteSize: bigint;
  readonly sha256: string;
  readonly readyAt: Date;
} {
  return (
    clip.status === 'READY' &&
    clip.storageState === 'READY' &&
    clip.storageKey !== null &&
    clip.byteSize !== null &&
    clip.byteSize > 0n &&
    clip.byteSize <= BigInt(Number.MAX_SAFE_INTEGER) &&
    clip.sha256 !== null &&
    /^[a-f0-9]{64}$/.test(clip.sha256) &&
    clip.readyAt !== null
  );
}

function pending(alertId: string): AlertMediaMetadata {
  return { status: 'PENDING', alertId, retryAfterSeconds: null };
}

function notFound(): FacilityScopedNotFoundException {
  return new FacilityScopedNotFoundException('media');
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected media status: ${String(value)}`);
}
