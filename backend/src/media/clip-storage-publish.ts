import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  assertContainedFile,
  assertVerifiedDirectory,
  closeContainedFile,
  closeVerifiedDirectory,
  containedPath,
  openContainedFile,
  openVerifiedDirectory,
  type ContainedFile,
} from './clip-storage-containment.js';
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
  const finalDirectory = await openVerifiedDirectory(
    dependencies.config.rootDir,
    [request.facilityId, request.clipId],
  );
  try {
    const file = await openContainedFile(
      finalDirectory,
      `${request.expectedSha256}.mp4`,
    );
    await closeContainedFile(file);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw mapStorageFailure(error);
  } finally {
    await closeVerifiedDirectory(finalDirectory);
  }
}

export async function publishStagedClip(
  dependencies: ClipStorageDependencies,
  request: ClipPersistRequest,
  staged: StagedClip,
): Promise<PublishedClip> {
  const finalDirectory = await openVerifiedDirectory(
    dependencies.config.rootDir,
    [request.facilityId, request.clipId],
  );
  const storageKey = path.posix.join(
    request.facilityId,
    request.clipId,
    `${staged.sha256}.mp4`,
  );
  const finalName = `${staged.sha256}.mp4`;
  const finalPath = containedPath(finalDirectory, finalName);
  let finalFile: ContainedFile | undefined;
  let createdFinal = false;
  try {
    await assertVerifiedDirectory(finalDirectory);
    const mediaEntries = (
      await fs.readdir(finalDirectory.descriptorPath, {
        withFileTypes: true,
      })
    ).filter((entry) => entry.name.endsWith('.mp4'));
    await assertVerifiedDirectory(finalDirectory);
    if (
      mediaEntries.length > 1 ||
      (mediaEntries.length === 1 && mediaEntries[0]?.name !== finalName)
    ) {
      throw immutableConflict();
    }

    let duplicate = mediaEntries.length === 1;
    if (!duplicate) {
      try {
        await assertContainedFile(staged.temporaryFile);
        await assertVerifiedDirectory(finalDirectory);
        await fs.link(staged.temporaryFile.path, finalPath);
        createdFinal = true;
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) {
          throw mapStorageFailure(error);
        }
        duplicate = true;
      }
    }

    await assertVerifiedDirectory(finalDirectory);
    finalFile = await openContainedFile(finalDirectory, finalName);
    const actual = await digestFileHandle(finalFile);
    if (
      actual.sha256 !== staged.sha256 ||
      actual.sizeBytes !== staged.sizeBytes
    ) {
      throw immutableConflict();
    }
    await finalFile.handle.sync();
    await assertContainedFile(finalFile);
    await finalDirectory.handle.sync();
    await assertVerifiedDirectory(finalDirectory);
    return { storageKey, duplicate };
  } catch (error) {
    if (createdFinal) {
      try {
        await fs.unlink(finalPath);
      } catch (cleanupError) {
        if (!hasErrorCode(cleanupError, 'ENOENT')) {
          throw new ClipStorageError(
            CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
            'failed to remove a rejected published clip',
            { cause: new AggregateError([error, cleanupError]) },
          );
        }
      }
    }
    throw error;
  } finally {
    if (finalFile !== undefined) {
      await closeContainedFile(finalFile).catch(() => undefined);
    }
    await closeVerifiedDirectory(finalDirectory).catch(() => undefined);
  }
}

async function digestFileHandle(
  file: ContainedFile,
): Promise<{ readonly sha256: string; readonly sizeBytes: number }> {
  await assertContainedFile(file);
  const stat = await file.handle.stat();
  if (!Number.isSafeInteger(stat.size)) throw immutableConflict();
  const hash = createHash('sha256');
  for await (const chunk of file.handle.createReadStream({
    autoClose: false,
  })) {
    const value: unknown = chunk;
    if (!(value instanceof Uint8Array)) throw immutableConflict();
    hash.update(value);
  }
  await assertContainedFile(file);
  return { sha256: hash.digest('hex'), sizeBytes: stat.size };
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
    hasErrorCode(error, 'EPERM') ||
    hasErrorCode(error, 'ELOOP') ||
    hasErrorCode(error, 'ENOTDIR') ||
    hasErrorCode(error, 'ESTALE')
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
