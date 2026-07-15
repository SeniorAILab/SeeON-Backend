import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { isSafeStorageSegment } from './clip-storage-write.js';

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
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== input.expectedSizeBytes) {
      throw new AlertMediaFileError('CORRUPT');
    }
    return { handle, sizeBytes: stat.size };
  } catch (error) {
    await handle.close();
    throw error;
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
