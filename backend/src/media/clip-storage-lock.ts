import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mapStorageFailure, syncDirectory } from './clip-storage-publish.js';
import {
  CLIP_STORAGE_ERROR_CODES,
  ClipStorageError,
  type ClipPersistRequest,
  type ClipStorageDependencies,
} from './clip-storage.types.js';

export type ClipLock = {
  readonly handle: FileHandle;
  readonly lockPath: string;
};

export async function acquireStorageLock(
  dependencies: ClipStorageDependencies,
): Promise<ClipLock> {
  return acquireLock(
    dependencies,
    path.join(dependencies.config.rootDir, '.locks', '.store.lock'),
  );
}

export async function acquireClipLock(
  dependencies: ClipStorageDependencies,
  request: ClipPersistRequest,
): Promise<ClipLock> {
  const lockDir = path.join(
    dependencies.config.rootDir,
    '.locks',
    request.facilityId,
  );
  await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
  return acquireLock(
    dependencies,
    path.join(lockDir, `${request.clipId}.lock`),
  );
}

export async function releaseClipLock(lock: ClipLock): Promise<void> {
  await lock.handle.close();
  await fs.unlink(lock.lockPath);
  await syncDirectory(path.dirname(lock.lockPath));
}

async function acquireLock(
  dependencies: ClipStorageDependencies,
  lockPath: string,
): Promise<ClipLock> {
  for (
    let attempt = 0;
    attempt <= dependencies.config.lockRetryCount;
    attempt += 1
  ) {
    try {
      const handle = await fs.open(
        lockPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${process.pid}\n`);
      await handle.sync();
      return { handle, lockPath };
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw mapStorageFailure(error);
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
  throw new ClipStorageError(
    CLIP_STORAGE_ERROR_CODES.LOCK_TIMEOUT,
    'storage lock remained busy',
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
