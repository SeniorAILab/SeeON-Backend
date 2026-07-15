import type { MediaClip } from '@prisma/client';
import {
  EVENT_MEDIA_ERROR_CODES,
  EventMediaError,
  type PersistedReadyClip,
  type ReadyClipManifest,
} from './event-media.types.js';

export function matchesReadyManifest(
  clip: MediaClip,
  manifest: ReadyClipManifest,
): boolean {
  return (
    (clip.status === 'PENDING' ||
      clip.status === 'READY' ||
      clip.status === 'EXPIRED') &&
    clip.cameraId === manifest.cameraId &&
    matchesReadyStateVersion(clip, manifest.stateVersion) &&
    clip.contentType === 'video/mp4' &&
    clip.byteSize === BigInt(manifest.sizeBytes) &&
    clip.sha256 === manifest.sha256 &&
    clip.codec === 'h264' &&
    clip.durationMs === manifest.durationMs &&
    sameDate(clip.clipStartAt, manifest.clipStartAt) &&
    sameDate(clip.clipEndAt, manifest.clipEndAt) &&
    sameDate(clip.finalizedAt, manifest.finalizedAt)
  );
}

export function matchesPersistedClip(
  clip: MediaClip,
  persisted: PersistedReadyClip,
  requireStorageKey = true,
): boolean {
  return (
    clip.sha256 === persisted.sha256 &&
    clip.byteSize === BigInt(persisted.sizeBytes) &&
    clip.codec === persisted.codec &&
    clip.durationMs === persisted.durationMs &&
    (!requireStorageKey || clip.storageKey === persisted.storageKey)
  );
}

export function sameOrderedBindings(
  left: readonly { readonly eventId: string; readonly ordinal: number }[],
  right: readonly { readonly eventId: string; readonly ordinal: number }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (binding, index) =>
        binding.eventId === right[index]?.eventId &&
        binding.ordinal === right[index]?.ordinal,
    )
  );
}

export function immutableConflict(): EventMediaError {
  return new EventMediaError(
    EVENT_MEDIA_ERROR_CODES.IMMUTABLE_CONFLICT,
    'clip identity already owns a different immutable payload',
  );
}

function sameDate(left: Date | null, right: Date): boolean {
  return left?.getTime() === right.getTime();
}

function matchesReadyStateVersion(
  clip: MediaClip,
  readyStateVersion: number,
): boolean {
  const expected =
    clip.status === 'EXPIRED' ? readyStateVersion + 1 : readyStateVersion;
  return clip.stateVersion === expected;
}
