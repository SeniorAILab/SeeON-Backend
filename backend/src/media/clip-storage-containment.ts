import { constants, promises as fs } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CLIP_STORAGE_ERROR_CODES,
  ClipStorageError,
} from './clip-storage.types.js';

const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/**
 * Descriptor-relative containment strategy.
 *
 * `proc` is the only strategy that gives atomic fd-anchored path operations:
 * `/proc/${pid}/fd/${fd}` lets every subsequent mkdir/open/readdir traverse
 * through the already-opened directory inode, and `realpath(/proc/self/fd/N)`
 * proves what path an open handle currently resolves to. Linux production runs
 * this strategy exclusively.
 *
 * `devino` is a development-only fallback for platforms without `/proc` fd
 * traversal (macOS: `/dev/fd/<dir-fd>` returns ENOTDIR). It re-derives paths
 * from `expectedPath` and proves object identity with a BigInt (dev, ino, type)
 * comparison between an `lstat` of the namespace path and an `fstat` of the open
 * handle. It CANNOT defend against a transient swap-and-restore race, so the
 * atomic-parent-replacement attack specs are Linux-only (see the specs).
 */
type ContainmentStrategy = 'proc' | 'devino';

let cachedStrategy: ContainmentStrategy | undefined;

/**
 * Resolve the containment strategy once per process. Fail closed: any non-macOS
 * host that cannot traverse an opened directory fd through `/proc` aborts rather
 * than silently downgrading production security to the dev-only fallback.
 */
export async function resolveContainmentStrategy(): Promise<ContainmentStrategy> {
  if (cachedStrategy !== undefined) return cachedStrategy;
  const procTraversable = await probeProcFdTraversal();
  if (procTraversable) {
    cachedStrategy = 'proc';
    return cachedStrategy;
  }
  if (os.platform() !== 'darwin' || process.env.NODE_ENV === 'production') {
    throw new ClipStorageError(
      CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
      'clip storage requires /proc file-descriptor traversal on this platform; ' +
        'the descriptor fallback is restricted to non-production macOS',
    );
  }
  cachedStrategy = 'devino';
  return cachedStrategy;
}

async function probeProcFdTraversal(): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await fs.open(os.tmpdir(), DIRECTORY_FLAGS);
  } catch {
    return false;
  }
  try {
    await fs.readdir(`/proc/${process.pid}/fd/${handle.fd}`);
    return true;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export type VerifiedDirectory = {
  readonly handle: FileHandle;
  readonly expectedPath: string;
  readonly descriptorPath: string;
  readonly strategy: ContainmentStrategy;
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
  const strategy = await resolveContainmentStrategy();
  const expectedRoot = path.resolve(rootDir);
  await fs.mkdir(expectedRoot, { recursive: true, mode: 0o700 });
  let current = directory(
    await fs.open(expectedRoot, DIRECTORY_FLAGS),
    expectedRoot,
    strategy,
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
        strategy,
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
  await assertHandleIdentity(
    value.handle,
    value.expectedPath,
    value.strategy,
    'directory',
  );
}

/**
 * Prove that an open handle still resolves to `expectedPath` as the required
 * type. `proc` keeps the original Linux guarantee: `realpath` through the fd
 * proves path provenance atomically. `devino` (macOS dev-only) instead compares
 * the BigInt (dev, ino) of an `fstat` on the handle against an `lstat` of the
 * namespace path — object identity, not path provenance. Any post-open failure
 * (ENOENT/ELOOP/ENOTDIR/ESTALE/EACCES) is a containment violation, not absence.
 */
async function assertHandleIdentity(
  handle: FileHandle,
  expectedPath: string,
  strategy: ContainmentStrategy,
  requiredType: 'file' | 'directory',
): Promise<void> {
  if (strategy === 'proc') {
    const [actualPath, stat] = await Promise.all([
      fs.realpath(descriptor(handle)),
      handle.stat(),
    ]);
    if (actualPath !== expectedPath || !isType(stat, requiredType)) {
      throw containmentFailure();
    }
    return;
  }
  let handleStat: BigIntStats;
  let pathStat: BigIntStats;
  try {
    [handleStat, pathStat] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(expectedPath, { bigint: true }),
    ]);
  } catch (error) {
    throw containmentFailure({ cause: error });
  }
  if (
    !isType(handleStat, requiredType) ||
    !isType(pathStat, requiredType) ||
    handleStat.dev !== pathStat.dev ||
    handleStat.ino !== pathStat.ino
  ) {
    throw containmentFailure();
  }
}

function isType(
  stat: { isFile(): boolean; isDirectory(): boolean },
  requiredType: 'file' | 'directory',
): boolean {
  return requiredType === 'file' ? stat.isFile() : stat.isDirectory();
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
    if (directoryValue.strategy === 'proc') {
      await fs.unlink(filePath).catch(() => undefined);
    }
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
  await assertHandleIdentity(
    value.handle,
    value.expectedPath,
    value.directory.strategy,
    'file',
  );
  const current = await fs.open(
    value.path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await assertHandleIdentity(
      current,
      value.expectedPath,
      value.directory.strategy,
      'file',
    );
    const [originalStat, currentStat] = await Promise.all([
      value.handle.stat({ bigint: true }),
      current.stat({ bigint: true }),
    ]);
    if (
      currentStat.dev !== originalStat.dev ||
      currentStat.ino !== originalStat.ino
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
  let namespaceOwned = value.directory.strategy === 'proc';
  if (!namespaceOwned) {
    try {
      await assertContainedFile(value);
      namespaceOwned = true;
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await value.handle.close();
  } catch (error) {
    failures.push(error);
  }
  if (namespaceOwned) {
    try {
      await fs.unlink(value.path);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) failures.push(error);
    }
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
  strategy: ContainmentStrategy,
): VerifiedDirectory {
  return {
    handle,
    expectedPath,
    strategy,
    descriptorPath:
      strategy === 'proc'
        ? `/proc/${process.pid}/fd/${handle.fd}`
        : expectedPath,
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

function containmentFailure(options?: ErrorOptions): ClipStorageError {
  return new ClipStorageError(
    CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
    'clip storage parent changed during a write',
    options,
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
