import { constants, promises as fs } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { isSafeStorageSegment } from './clip-storage-write.js';
import { resolveContainmentStrategy } from './clip-storage-containment.js';

export type AlertMediaFile = {
  readonly handle: FileHandle;
  readonly sizeBytes: number;
};

export async function openAlertMediaFile(input: {
  readonly rootDir: string;
  readonly facilityId: string;
  readonly storageKey: string;
  readonly sha256: string;
  readonly expectedSizeBytes: number;
}): Promise<AlertMediaFile> {
  validateStorageKey(input);
  const root = path.resolve(input.rootDir);
  const candidate = path.resolve(root, input.storageKey);
  const relative = path.relative(root, candidate);
  if (
    relative === '' ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new AlertMediaFileError('INVALID_REFERENCE');
  }

  let parentRealPath: string;
  let rootRealPath: string;
  try {
    [parentRealPath, rootRealPath] = await Promise.all([
      fs.realpath(path.dirname(candidate)),
      fs.realpath(root),
    ]);
  } catch (error) {
    throw new AlertMediaFileError('MISSING', { cause: error });
  }
  const parentRelative = path.relative(rootRealPath, parentRealPath);
  if (
    path.isAbsolute(parentRelative) ||
    parentRelative === '..' ||
    parentRelative.startsWith(`..${path.sep}`)
  ) {
    throw new AlertMediaFileError('INVALID_REFERENCE');
  }
  const expectedRealPath = path.join(rootRealPath, input.storageKey);

  let handle: FileHandle;
  try {
    handle = await fs.open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new AlertMediaFileError('MISSING', { cause: error });
  }
  try {
    await assertOpenedFileIdentity(handle, expectedRealPath, parentRealPath);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== input.expectedSizeBytes) {
      throw new AlertMediaFileError('CORRUPT');
    }
    return { handle, sizeBytes: stat.size };
  } catch (error) {
    await handle.close();
    if (error instanceof AlertMediaFileError) throw error;
    throw new AlertMediaFileError('MISSING', { cause: error });
  }
}

/**
 * Prove the opened read handle is exactly `expectedRealPath`. `proc` keeps the
 * original Linux guarantee (`realpath` through the fd proves path provenance).
 * `devino` (macOS dev-only) has no fd path, so it substitutes: the parent was
 * already canonicalised to `parentRealPath`, so require it to equal the expected
 * parent exactly (closes the in-root intermediate-symlink gap that plain lstat
 * misses), then confirm the handle and `lstat(expectedRealPath)` are the same
 * BigInt (dev, ino) regular file.
 */
async function assertOpenedFileIdentity(
  handle: FileHandle,
  expectedRealPath: string,
  parentRealPath: string,
): Promise<void> {
  const strategy = await resolveContainmentStrategy();
  if (strategy === 'proc') {
    let openedRealPath: string;
    try {
      openedRealPath = await fs.realpath(`/proc/self/fd/${handle.fd}`);
    } catch (error) {
      throw new AlertMediaFileError('INVALID_REFERENCE', { cause: error });
    }
    if (openedRealPath !== expectedRealPath) {
      throw new AlertMediaFileError('INVALID_REFERENCE');
    }
    return;
  }
  if (parentRealPath !== path.dirname(expectedRealPath)) {
    throw new AlertMediaFileError('INVALID_REFERENCE');
  }
  let handleStat: BigIntStats;
  let pathStat: BigIntStats;
  try {
    [handleStat, pathStat] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(expectedRealPath, { bigint: true }),
    ]);
  } catch (error) {
    throw new AlertMediaFileError('INVALID_REFERENCE', { cause: error });
  }
  if (
    !handleStat.isFile() ||
    !pathStat.isFile() ||
    handleStat.dev !== pathStat.dev ||
    handleStat.ino !== pathStat.ino
  ) {
    throw new AlertMediaFileError('INVALID_REFERENCE');
  }
}

function validateStorageKey(input: {
  readonly facilityId: string;
  readonly storageKey: string;
  readonly sha256: string;
}): void {
  const segments = input.storageKey.split('/');
  if (
    segments.length !== 3 ||
    segments[0] !== input.facilityId ||
    !segments.every(isSafeStorageSegment) ||
    segments[2] !== `${input.sha256}.mp4`
  ) {
    throw new AlertMediaFileError('INVALID_REFERENCE');
  }
}

export type AlertMediaFileErrorReason =
  | 'INVALID_REFERENCE'
  | 'MISSING'
  | 'CORRUPT';

export class AlertMediaFileError extends Error {
  readonly name = 'AlertMediaFileError';

  constructor(
    readonly reason: AlertMediaFileErrorReason,
    options?: ErrorOptions,
  ) {
    super('alert media file cannot be served', options);
  }
}
