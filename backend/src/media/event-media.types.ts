import type { MediaClipReason, MediaHoldKind } from '@prisma/client';
import type { Readable } from 'node:stream';

export const EVENT_MEDIA_ERROR_CODES = {
  DISABLED: 'DISABLED',
  INVALID_INPUT: 'INVALID_INPUT',
  EVENT_OWNERSHIP: 'EVENT_OWNERSHIP',
  IMMUTABLE_CONFLICT: 'IMMUTABLE_CONFLICT',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  HOLD_ACTIVE: 'HOLD_ACTIVE',
  DELETION_DISABLED: 'DELETION_DISABLED',
} as const;

export type EventMediaErrorCode =
  (typeof EVENT_MEDIA_ERROR_CODES)[keyof typeof EVENT_MEDIA_ERROR_CODES];

export class EventMediaError extends Error {
  readonly name = 'EventMediaError';

  constructor(
    readonly code: EventMediaErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type EventMediaConfig = {
  readonly enabled: boolean;
  readonly retentionDays: number;
};

export type ReadyClipManifest = {
  readonly externalClipId: string;
  readonly cameraId: string;
  readonly eventRefs: readonly string[];
  readonly clipStartAt: Date;
  readonly clipEndAt: Date;
  readonly finalizedAt: Date;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly durationMs: number;
  readonly stateVersion: number;
};

export type ReadyClipUpload = ReadyClipManifest & {
  readonly source: Readable;
};

export type UnavailableClipReport = {
  readonly externalClipId: string;
  readonly cameraId: string;
  readonly eventRefs: readonly string[];
  readonly stateVersion: number;
  readonly reason: MediaClipReason;
};

export type ClipReceipt =
  | {
      readonly clip_id: string;
      readonly state: 'READY';
      readonly state_version: number;
      readonly sha256: string;
      readonly size_bytes: number;
    }
  | {
      readonly clip_id: string;
      readonly state: 'UNAVAILABLE';
      readonly state_version: number;
    };

export type PreparedReadyClip = {
  readonly id: string;
  readonly facilityId: string;
  readonly state: 'PENDING' | 'READY';
  readonly storageKey: string | null;
};

export type PersistedReadyClip = {
  readonly storageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly codec: 'h264';
  readonly durationMs: number;
};

export type PlaceMediaHold = {
  readonly facilityId: string;
  readonly externalClipId: string;
  readonly kind: MediaHoldKind;
  readonly reason: string;
  readonly actorUserId?: string;
};
