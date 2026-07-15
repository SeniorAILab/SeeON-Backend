import type { Readable } from 'node:stream';

export const CLIP_STORAGE_ERROR_CODES = {
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  LENGTH_MISMATCH: 'LENGTH_MISMATCH',
  UNSUPPORTED_MEDIA: 'UNSUPPORTED_MEDIA',
  INSUFFICIENT_STORAGE: 'INSUFFICIENT_STORAGE',
  STORAGE_UNWRITABLE: 'STORAGE_UNWRITABLE',
  IMMUTABLE_CONFLICT: 'IMMUTABLE_CONFLICT',
  SIZE_LIMIT_EXCEEDED: 'SIZE_LIMIT_EXCEEDED',
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  INVALID_INPUT: 'INVALID_INPUT',
} as const;

export type ClipStorageErrorCode =
  (typeof CLIP_STORAGE_ERROR_CODES)[keyof typeof CLIP_STORAGE_ERROR_CODES];

export class ClipStorageError extends Error {
  readonly name = 'ClipStorageError';

  constructor(
    readonly code: ClipStorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type ClipStorageConfig = {
  readonly rootDir: string;
  readonly maximumBytes: number;
  readonly minimumFreeBytes: bigint;
  readonly lockRetryCount: number;
  readonly lockRetryDelayMs: number;
};

export type ClipPersistRequest = {
  readonly facilityId: string;
  readonly clipId: string;
  readonly expectedSha256: string;
  readonly expectedSizeBytes: number;
  readonly source: Readable;
};

export type ClipInspection = {
  readonly codec: 'h264';
  readonly durationMs: number;
};

export type PersistedClip = ClipInspection & {
  readonly storageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly duplicate: boolean;
};

export type ClipStorageReference = {
  readonly storageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
};

export type ClipReconciliationReport = {
  readonly removedTemporaryFiles: readonly string[];
  readonly removedLockFiles: readonly string[];
  readonly removedOrphanFiles: readonly string[];
  readonly missingReferences: readonly string[];
  readonly corruptReferences: readonly string[];
};

export interface ClipInspector {
  inspect(filePath: string): Promise<ClipInspection>;
}

export type ClipStorageDependencies = {
  readonly config: ClipStorageConfig;
  readonly inspector: ClipInspector;
  readonly availableBytes?: () => Promise<bigint>;
};
