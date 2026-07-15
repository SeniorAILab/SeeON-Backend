import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  assertContainedFile,
  cleanupContainedFile,
  closeVerifiedDirectory,
  createContainedFile,
  openVerifiedDirectory,
  type ContainedFile,
  type VerifiedDirectory,
} from './clip-storage-containment.js';
import {
  CLIP_STORAGE_ERROR_CODES,
  ClipStorageError,
  type ClipInspection,
  type ClipPersistRequest,
  type ClipStorageDependencies,
} from './clip-storage.types.js';
import { mapStorageFailure } from './clip-storage-publish.js';

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type StagedClip = ClipInspection & {
  readonly temporaryFile: ContainedFile;
  readonly sha256: string;
  readonly sizeBytes: number;
};

export function validatePersistRequest(
  request: ClipPersistRequest,
  maximumBytes: number,
): void {
  if (
    !isSafeStorageSegment(request.facilityId) ||
    !isSafeStorageSegment(request.clipId) ||
    !SHA256_PATTERN.test(request.expectedSha256) ||
    !Number.isSafeInteger(request.expectedSizeBytes) ||
    request.expectedSizeBytes <= 0 ||
    !Number.isSafeInteger(request.expectedDurationMs) ||
    request.expectedDurationMs <= 0 ||
    request.expectedDurationMs > 120_000
  ) {
    throw new ClipStorageError(
      CLIP_STORAGE_ERROR_CODES.INVALID_INPUT,
      'clip storage input is invalid',
    );
  }
  if (request.expectedSizeBytes > maximumBytes) {
    throw new ClipStorageError(
      CLIP_STORAGE_ERROR_CODES.SIZE_LIMIT_EXCEEDED,
      'clip exceeds the configured byte limit',
    );
  }
}

export function isSafeStorageSegment(
  value: string | undefined,
): value is string {
  return (
    value !== undefined &&
    value !== '.' &&
    value !== '..' &&
    SEGMENT_PATTERN.test(value)
  );
}

export async function ensureStorageLayout(rootDir: string): Promise<void> {
  const staging = await openVerifiedDirectory(rootDir, ['.staging']);
  await closeVerifiedDirectory(staging);
  const locks = await openVerifiedDirectory(rootDir, ['.locks']);
  await closeVerifiedDirectory(locks);
}

export async function readAvailableBytes(rootDir: string): Promise<bigint> {
  const stats = await fs.statfs(rootDir, { bigint: true });
  return stats.bavail * stats.bsize;
}

export async function stageClip(
  dependencies: ClipStorageDependencies,
  request: ClipPersistRequest,
): Promise<StagedClip> {
  let temporaryDirectory: VerifiedDirectory | undefined;
  let temporaryFile: ContainedFile | undefined;
  try {
    temporaryDirectory = await openVerifiedDirectory(
      dependencies.config.rootDir,
      ['.staging', request.facilityId, request.clipId],
    );
    temporaryFile = await createContainedFile(
      temporaryDirectory,
      `${randomUUID()}.part`,
    );
    const hash = createHash('sha256');
    let sizeBytes = 0;
    let overflow = false;

    try {
      for await (const chunk of request.source) {
        const value: unknown = chunk;
        const bytes = toBuffer(value);
        if (!overflow) {
          const nextSize = sizeBytes + bytes.length;
          if (nextSize > request.expectedSizeBytes) {
            overflow = true;
          } else {
            sizeBytes = nextSize;
            await writeAll(temporaryFile.handle, bytes);
            hash.update(bytes);
          }
        }
      }
      await temporaryFile.handle.sync();
    } catch (error) {
      throw mapStorageFailure(error);
    }

    if (overflow) {
      throw new ClipStorageError(
        CLIP_STORAGE_ERROR_CODES.LENGTH_MISMATCH,
        'clip stream exceeded declared length',
      );
    }
    if (sizeBytes !== request.expectedSizeBytes) {
      throw new ClipStorageError(
        CLIP_STORAGE_ERROR_CODES.LENGTH_MISMATCH,
        'clip stream ended before declared length',
      );
    }
    const sha256 = hash.digest('hex');
    if (sha256 !== request.expectedSha256) {
      throw new ClipStorageError(
        CLIP_STORAGE_ERROR_CODES.CHECKSUM_MISMATCH,
        'clip checksum does not match declared checksum',
      );
    }
    await assertContainedFile(temporaryFile);
    const inspection = await dependencies.inspector.inspect(temporaryFile.path);
    await assertContainedFile(temporaryFile);
    if (inspection.durationMs !== request.expectedDurationMs) {
      throw new ClipStorageError(
        CLIP_STORAGE_ERROR_CODES.DURATION_MISMATCH,
        'clip duration does not match declared duration',
      );
    }
    return { temporaryFile, sha256, sizeBytes, ...inspection };
  } catch (error) {
    if (temporaryFile === undefined) {
      await temporaryDirectory?.handle.close().catch(() => undefined);
      throw error;
    }
    try {
      await cleanupContainedFile(temporaryFile);
    } catch (cleanupError) {
      throw new ClipStorageError(
        CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
        'failed to remove a rejected staged clip',
        { cause: new AggregateError([error, cleanupError]) },
      );
    }
    throw error;
  }
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    offset += result.bytesWritten;
  }
}

function toBuffer(value: unknown): Buffer {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new ClipStorageError(
    CLIP_STORAGE_ERROR_CODES.INVALID_INPUT,
    'clip stream emitted an unsupported chunk',
  );
}
