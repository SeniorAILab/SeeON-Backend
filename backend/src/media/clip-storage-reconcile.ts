import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  ClipReconciliationReport,
  ClipStorageConfig,
  ClipStorageReference,
} from './clip-storage.types.js';
import {
  digestRegularFile,
  removeFileIfPresent,
  syncDirectory,
} from './clip-storage-publish.js';
import {
  ensureStorageLayout,
  isSafeStorageSegment,
} from './clip-storage-write.js';

const STORAGE_KEY_PATTERN =
  /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[a-f0-9]{64}\.mp4$/;

export async function reconcileClipStorage(
  config: ClipStorageConfig,
  references: readonly ClipStorageReference[],
): Promise<ClipReconciliationReport> {
  await ensureStorageLayout(config.rootDir);
  const removedTemporaryFiles = await resetTransientDirectory(
    config.rootDir,
    '.staging',
  );
  const removedLockFiles = await resetTransientDirectory(
    config.rootDir,
    '.locks',
  );
  const removedOrphanFiles: string[] = [];
  const missingReferences: string[] = [];
  const corruptReferences: string[] = [];
  const referenceByKey = new Map(
    references.map((reference) => [reference.storageKey, reference]),
  );
  const discoveredKeys = await discoverFinalKeys(config.rootDir);

  for (const storageKey of discoveredKeys) {
    const reference = referenceByKey.get(storageKey);
    const finalPath = path.join(config.rootDir, storageKey);
    if (reference === undefined) {
      await removeFileIfPresent(finalPath);
      await syncDirectory(path.dirname(finalPath));
      await pruneEmptyParents(config.rootDir, finalPath);
      removedOrphanFiles.push(storageKey);
      continue;
    }
    try {
      const actual = await digestRegularFile(finalPath);
      if (
        actual.sha256 !== reference.sha256 ||
        actual.sizeBytes !== reference.sizeBytes ||
        !isValidReference(reference)
      ) {
        corruptReferences.push(storageKey);
      }
    } catch {
      corruptReferences.push(storageKey);
    }
  }

  const discovered = new Set(discoveredKeys);
  for (const reference of references) {
    if (!isValidReference(reference)) {
      if (!corruptReferences.includes(reference.storageKey)) {
        corruptReferences.push(reference.storageKey);
      }
    } else if (!discovered.has(reference.storageKey)) {
      missingReferences.push(reference.storageKey);
    }
  }

  return {
    removedTemporaryFiles: removedTemporaryFiles.sort(),
    removedLockFiles: removedLockFiles.sort(),
    removedOrphanFiles: removedOrphanFiles.sort(),
    missingReferences: missingReferences.sort(),
    corruptReferences: corruptReferences.sort(),
  };
}

async function resetTransientDirectory(
  rootDir: string,
  name: '.staging' | '.locks',
): Promise<string[]> {
  const directory = path.join(rootDir, name);
  const files = await collectRelativeFiles(rootDir, directory);
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectory(rootDir);
  return files;
}

async function collectRelativeFiles(
  rootDir: string,
  directory: string,
): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return files;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectRelativeFiles(rootDir, absolute)));
    } else {
      files.push(toStorageKey(rootDir, absolute));
    }
  }
  return files;
}

async function discoverFinalKeys(rootDir: string): Promise<string[]> {
  const keys: string[] = [];
  for (const facility of await fs.readdir(rootDir, { withFileTypes: true })) {
    if (facility.name.startsWith('.') || !facility.isDirectory()) continue;
    const facilityDir = path.join(rootDir, facility.name);
    for (const clip of await fs.readdir(facilityDir, { withFileTypes: true })) {
      if (!clip.isDirectory()) continue;
      const clipDir = path.join(facilityDir, clip.name);
      for (const media of await fs.readdir(clipDir, { withFileTypes: true })) {
        if (media.name.endsWith('.mp4')) {
          keys.push(toStorageKey(rootDir, path.join(clipDir, media.name)));
        }
      }
    }
  }
  return keys.sort();
}

async function pruneEmptyParents(
  rootDir: string,
  finalPath: string,
): Promise<void> {
  const clipDir = path.dirname(finalPath);
  const facilityDir = path.dirname(clipDir);
  await removeDirectoryIfEmpty(clipDir);
  if (path.dirname(facilityDir) === path.resolve(rootDir)) {
    await removeDirectoryIfEmpty(facilityDir);
  }
}

async function removeDirectoryIfEmpty(directory: string): Promise<void> {
  try {
    await fs.rmdir(directory);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT') && !hasErrorCode(error, 'ENOTEMPTY')) {
      throw error;
    }
  }
}

function isValidReference(reference: ClipStorageReference): boolean {
  if (
    !STORAGE_KEY_PATTERN.test(reference.storageKey) ||
    !/^[a-f0-9]{64}$/.test(reference.sha256) ||
    !Number.isSafeInteger(reference.sizeBytes) ||
    reference.sizeBytes <= 0
  ) {
    return false;
  }
  const [facilityId, clipId] = reference.storageKey.split('/');
  return (
    isSafeStorageSegment(facilityId) &&
    isSafeStorageSegment(clipId) &&
    path.posix.basename(reference.storageKey) === `${reference.sha256}.mp4`
  );
}

function toStorageKey(rootDir: string, absolutePath: string): string {
  return path
    .relative(path.resolve(rootDir), absolutePath)
    .split(path.sep)
    .join('/');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
