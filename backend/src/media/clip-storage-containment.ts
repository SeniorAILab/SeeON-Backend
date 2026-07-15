import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import {
  CLIP_STORAGE_ERROR_CODES,
  ClipStorageError,
} from './clip-storage.types.js';

const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export type VerifiedDirectory = {
  readonly handle: FileHandle;
  readonly expectedPath: string;
  readonly descriptorPath: string;
};

export type ContainedFile = {
  readonly directory: VerifiedDirectory;
  readonly handle: FileHandle;
  readonly name: string;
  readonly path: string;
  readonly expectedPath: string;
};

export async function openVerifiedDirectory(
  rootDir: string,
  segments: readonly string[],
): Promise<VerifiedDirectory> {
  const expectedRoot = path.resolve(rootDir);
  await fs.mkdir(expectedRoot, { recursive: true, mode: 0o700 });
  let current = directory(
    await fs.open(expectedRoot, DIRECTORY_FLAGS),
    expectedRoot,
  );
  try {
    await assertVerifiedDirectory(current);
    for (const segment of segments) {
      assertSegment(segment);
      const expectedPath = path.join(current.expectedPath, segment);
      const descriptorPath = path.join(current.descriptorPath, segment);
      try {
        await fs.mkdir(descriptorPath, { mode: 0o700 });
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
      }
      const child = directory(
        await fs.open(descriptorPath, DIRECTORY_FLAGS),
        expectedPath,
      );
      try {
        await assertVerifiedDirectory(current);
        await assertVerifiedDirectory(child);
      } catch (error) {
        await child.handle.close().catch(() => undefined);
        throw error;
      }
      await current.handle.close();
      current = child;
    }
    return current;
  } catch (error) {
    await current.handle.close().catch(() => undefined);
    throw error;
  }
}

export async function assertVerifiedDirectory(
  value: VerifiedDirectory,
): Promise<void> {
  const [actualPath, stat] = await Promise.all([
    fs.realpath(descriptor(value.handle)),
    value.handle.stat(),
  ]);
  if (actualPath !== value.expectedPath || !stat.isDirectory()) {
    throw containmentFailure();
  }
}

export async function createContainedFile(
  directoryValue: VerifiedDirectory,
  name: string,
): Promise<ContainedFile> {
  assertSegment(name);
  await assertVerifiedDirectory(directoryValue);
  const filePath = path.join(directoryValue.descriptorPath, name);
  const handle = await fs.open(
    filePath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  const value = containedFile(directoryValue, handle, name);
  try {
    await assertContainedFile(value);
    return value;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(filePath).catch(() => undefined);
    throw error;
  }
}

export async function openContainedFile(
  directoryValue: VerifiedDirectory,
  name: string,
): Promise<ContainedFile> {
  assertSegment(name);
  await assertVerifiedDirectory(directoryValue);
  const handle = await fs.open(
    path.join(directoryValue.descriptorPath, name),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const value = containedFile(directoryValue, handle, name);
  try {
    await assertContainedFile(value);
    return value;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function assertContainedFile(value: ContainedFile): Promise<void> {
  await assertVerifiedDirectory(value.directory);
  const [actualPath, stat] = await Promise.all([
    fs.realpath(descriptor(value.handle)),
    value.handle.stat(),
  ]);
  if (actualPath !== value.expectedPath || !stat.isFile()) {
    throw containmentFailure();
  }
  const current = await fs.open(
    value.path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const [currentPath, currentStat] = await Promise.all([
      fs.realpath(descriptor(current)),
      current.stat(),
    ]);
    if (
      currentPath !== value.expectedPath ||
      !currentStat.isFile() ||
      currentStat.dev !== stat.dev ||
      currentStat.ino !== stat.ino
    ) {
      throw containmentFailure();
    }
  } finally {
    await current.close();
  }
}

export async function cleanupContainedFile(
  value: ContainedFile,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await value.handle.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await fs.unlink(value.path);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) failures.push(error);
  }
  try {
    await value.directory.handle.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 0) return;
  const cause =
    failures.length === 1
      ? failures[0]
      : new AggregateError(failures, 'contained file cleanup failures');
  throw new ClipStorageError(
    CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
    'failed to remove a staged clip',
    { cause },
  );
}

export async function closeContainedFile(value: ContainedFile): Promise<void> {
  await value.handle.close();
}

export async function closeVerifiedDirectory(
  value: VerifiedDirectory,
): Promise<void> {
  await value.handle.close();
}

export function containedPath(
  directoryValue: VerifiedDirectory,
  name: string,
): string {
  assertSegment(name);
  return path.join(directoryValue.descriptorPath, name);
}

function directory(
  handle: FileHandle,
  expectedPath: string,
): VerifiedDirectory {
  return {
    handle,
    expectedPath,
    descriptorPath: `/proc/${process.pid}/fd/${handle.fd}`,
  };
}

function containedFile(
  directoryValue: VerifiedDirectory,
  handle: FileHandle,
  name: string,
): ContainedFile {
  return {
    directory: directoryValue,
    handle,
    name,
    path: path.join(directoryValue.descriptorPath, name),
    expectedPath: path.join(directoryValue.expectedPath, name),
  };
}

function descriptor(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`;
}

function assertSegment(value: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    path.basename(value) !== value
  ) {
    throw containmentFailure();
  }
}

function containmentFailure(): ClipStorageError {
  return new ClipStorageError(
    CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
    'clip storage parent changed during a write',
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
