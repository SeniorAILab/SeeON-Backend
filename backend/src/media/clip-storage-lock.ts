import { promises as fs } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  assertContainedFile,
  closeVerifiedDirectory,
  createContainedFile,
  openVerifiedDirectory,
  type ContainedFile,
  type VerifiedDirectory,
} from './clip-storage-containment.js';
import { mapStorageFailure } from './clip-storage-publish.js';
import {
  CLIP_STORAGE_ERROR_CODES,
  ClipStorageError,
  type ClipPersistRequest,
  type ClipStorageDependencies,
} from './clip-storage.types.js';

export type ClipLock = {
  readonly file: ContainedFile;
};

export async function acquireStorageLock(
  dependencies: ClipStorageDependencies,
): Promise<ClipLock> {
  const directory = await openVerifiedDirectory(dependencies.config.rootDir, [
    '.locks',
  ]);
  return acquireLock(dependencies, directory, '.store.lock');
}

export async function acquireClipLock(
  dependencies: ClipStorageDependencies,
  request: ClipPersistRequest,
): Promise<ClipLock> {
  const directory = await openVerifiedDirectory(dependencies.config.rootDir, [
    '.locks',
    request.facilityId,
  ]);
  return acquireLock(dependencies, directory, `${request.clipId}.lock`);
}

export async function releaseClipLock(lock: ClipLock): Promise<void> {
  await removeOwnedLockFile(lock.file, true);
}

async function acquireLock(
  dependencies: ClipStorageDependencies,
  directory: VerifiedDirectory,
  lockName: string,
): Promise<ClipLock> {
  try {
    for (
      let attempt = 0;
      attempt <= dependencies.config.lockRetryCount;
      attempt += 1
    ) {
      try {
        const file = await createContainedFile(directory, lockName);
        try {
          await file.handle.writeFile(`${process.pid}\n`);
          await file.handle.sync();
          await assertContainedFile(file);
          return { file };
        } catch (error) {
          await discardCreatedLock(file, error);
          throw error;
        }
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
        if (attempt === dependencies.config.lockRetryCount) {
          throw new ClipStorageError(
            CLIP_STORAGE_ERROR_CODES.LOCK_TIMEOUT,
            'storage lock remained busy',
            { cause: error },
          );
        }
        await delay(dependencies.config.lockRetryDelayMs);
      }
    }
  } catch (error) {
    await closeDirectoryAfterFailure(directory, error);
    throw mapStorageFailure(error);
  }
  throw new ClipStorageError(
    CLIP_STORAGE_ERROR_CODES.LOCK_TIMEOUT,
    'storage lock remained busy',
  );
}

async function discardCreatedLock(
  file: ContainedFile,
  primaryFailure: unknown,
): Promise<void> {
  try {
    await removeOwnedLockFile(file, false);
  } catch (cleanupFailure) {
    throw new ClipStorageError(
      CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
      'failed to remove an unacquired storage lock',
      { cause: new AggregateError([primaryFailure, cleanupFailure]) },
    );
  }
}

async function removeOwnedLockFile(
  file: ContainedFile,
  closeDirectory: boolean,
): Promise<void> {
  const failures: unknown[] = [];
  let ownsDirectoryEntry = false;
  try {
    await assertContainedFile(file);
    ownsDirectoryEntry = true;
  } catch (error) {
    failures.push(error);
  }
  try {
    await file.handle.close();
  } catch (error) {
    failures.push(error);
  }
  if (ownsDirectoryEntry) {
    try {
      await fs.unlink(file.path);
    } catch (error) {
      failures.push(error);
    }
    try {
      await file.directory.handle.sync();
    } catch (error) {
      failures.push(error);
    }
  }
  if (closeDirectory) {
    try {
      await closeVerifiedDirectory(file.directory);
    } catch (error) {
      failures.push(error);
    }
  }
  throwFailures(failures);
}

async function closeDirectoryAfterFailure(
  directory: VerifiedDirectory,
  primaryFailure: unknown,
): Promise<void> {
  try {
    await closeVerifiedDirectory(directory);
  } catch (cleanupFailure) {
    throw new ClipStorageError(
      CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
      'failed to close a storage lock directory',
      { cause: new AggregateError([primaryFailure, cleanupFailure]) },
    );
  }
}

function throwFailures(failures: readonly unknown[]): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, 'storage lock cleanup failures');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
