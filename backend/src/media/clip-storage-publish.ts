import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  CLIP_STORAGE_ERROR_CODES,
  ClipStorageError,
  type ClipPersistRequest,
  type ClipStorageDependencies,
} from './clip-storage.types.js';
import type { StagedClip } from './clip-storage-write.js';

export type PublishedClip = {
  readonly storageKey: string;
  readonly duplicate: boolean;
};

export async function hasPublishedClip(
  dependencies: ClipStorageDependencies,
  request: ClipPersistRequest,
): Promise<boolean> {
  const finalPath = path.join(
    dependencies.config.rootDir,
    request.facilityId,
    request.clipId,
    `${request.expectedSha256}.mp4`,
  );
  try {
    const stat = await fs.lstat(finalPath);
    return stat.isFile();
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw mapStorageFailure(error);
  }
}

export async function publishStagedClip(
  dependencies: ClipStorageDependencies,
  request: ClipPersistRequest,
  staged: StagedClip,
): Promise<PublishedClip> {
  const finalDir = path.join(
    dependencies.config.rootDir,
    request.facilityId,
    request.clipId,
  );
  await fs.mkdir(finalDir, { recursive: true, mode: 0o700 });
  const storageKey = path.posix.join(
    request.facilityId,
    request.clipId,
    `${staged.sha256}.mp4`,
  );
  const finalPath = path.join(dependencies.config.rootDir, storageKey);
  const mediaEntries = (
    await fs.readdir(finalDir, { withFileTypes: true })
  ).filter((entry) => entry.name.endsWith('.mp4'));
  if (
    mediaEntries.length > 1 ||
    (mediaEntries.length === 1 &&
      mediaEntries[0]?.name !== path.basename(finalPath))
  ) {
    throw immutableConflict();
  }

  let duplicate = mediaEntries.length === 1;
  if (!duplicate) {
    try {
      await fs.link(staged.temporaryPath, finalPath);
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw mapStorageFailure(error);
      }
      duplicate = true;
    }
  }

  const actual = await digestRegularFile(finalPath);
  if (
    actual.sha256 !== staged.sha256 ||
    actual.sizeBytes !== staged.sizeBytes
  ) {
    throw immutableConflict();
  }
  const finalHandle = await fs.open(
    finalPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await finalHandle.sync();
  } finally {
    await finalHandle.close();
  }
  await syncDirectory(finalDir);
  return { storageKey, duplicate };
}

export async function digestRegularFile(
  filePath: string,
): Promise<{ readonly sha256: string; readonly sizeBytes: number }> {
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) {
      throw immutableConflict();
    }
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const value: unknown = chunk;
      if (!(value instanceof Uint8Array)) throw immutableConflict();
      hash.update(value);
    }
    return { sha256: hash.digest('hex'), sizeBytes: stat.size };
  } finally {
    await handle.close();
  }
}

export async function removeFileIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw mapStorageFailure(error);
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function mapStorageFailure(error: unknown): Error {
  if (error instanceof ClipStorageError) return error;
  if (hasErrorCode(error, 'ENOSPC')) {
    return new ClipStorageError(
      CLIP_STORAGE_ERROR_CODES.INSUFFICIENT_STORAGE,
      'clip storage volume has insufficient space',
      { cause: error },
    );
  }
  if (
    hasErrorCode(error, 'EROFS') ||
    hasErrorCode(error, 'EACCES') ||
    hasErrorCode(error, 'EPERM')
  ) {
    return new ClipStorageError(
      CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
      'clip storage volume is not writable',
      { cause: error },
    );
  }
  return error instanceof Error
    ? error
    : new ClipStorageError(
        CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
        'clip storage operation failed',
        { cause: error },
      );
}

function immutableConflict(): ClipStorageError {
  return new ClipStorageError(
    CLIP_STORAGE_ERROR_CODES.IMMUTABLE_CONFLICT,
    'clip identity already has different immutable bytes',
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
