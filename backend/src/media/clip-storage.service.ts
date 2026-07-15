import {
  cleanupContainedFile,
  type ContainedFile,
} from './clip-storage-containment.js';
import {
  CLIP_STORAGE_ERROR_CODES,
  ClipStorageError,
  type ClipPersistRequest,
  type ClipReconciliationReport,
  type ClipStorageDependencies,
  type ClipStorageReference,
  type PersistedClip,
} from './clip-storage.types.js';
import {
  acquireClipLock,
  acquireStorageLock,
  releaseClipLock,
  type ClipLock,
} from './clip-storage-lock.js';
import {
  ensureStorageLayout,
  readAvailableBytes,
  stageClip,
  validatePersistRequest,
} from './clip-storage-write.js';
import {
  hasPublishedClip,
  mapStorageFailure,
  publishStagedClip,
} from './clip-storage-publish.js';
import { reconcileClipStorage } from './clip-storage-reconcile.js';

type CleanupContext = {
  readonly clipLock: ClipLock | undefined;
  readonly storageLock: ClipLock | undefined;
  readonly temporaryFile: ContainedFile | undefined;
  readonly primaryFailure: unknown;
};

export class ClipStorageService {
  constructor(private readonly dependencies: ClipStorageDependencies) {}

  async canAcceptMaximumClip(): Promise<boolean> {
    const availableBytes = this.dependencies.availableBytes
      ? await this.dependencies.availableBytes()
      : await readAvailableBytes(this.dependencies.config.rootDir);
    const requiredBytes =
      this.dependencies.config.minimumFreeBytes +
      BigInt(this.dependencies.config.maximumBytes);
    return availableBytes >= requiredBytes;
  }

  async persist(request: ClipPersistRequest): Promise<PersistedClip> {
    validatePersistRequest(request, this.dependencies.config.maximumBytes);
    let storageLock: ClipLock | undefined;
    let clipLock: ClipLock | undefined;
    let temporaryFile: ContainedFile | undefined;
    let primaryFailure: unknown;
    try {
      await ensureStorageLayout(this.dependencies.config.rootDir);
      storageLock = await acquireStorageLock(this.dependencies);
      clipLock = await acquireClipLock(this.dependencies, request);
      if (!(await hasPublishedClip(this.dependencies, request))) {
        await this.assertCapacity(request.expectedSizeBytes);
      }
      const staged = await stageClip(this.dependencies, request);
      temporaryFile = staged.temporaryFile;
      const published = await publishStagedClip(
        this.dependencies,
        request,
        staged,
      );
      return {
        storageKey: published.storageKey,
        sha256: staged.sha256,
        sizeBytes: staged.sizeBytes,
        codec: staged.codec,
        durationMs: staged.durationMs,
        duplicate: published.duplicate,
      };
    } catch (error) {
      primaryFailure = error;
      throw mapStorageFailure(error);
    } finally {
      await cleanupPersist({
        clipLock,
        storageLock,
        temporaryFile,
        primaryFailure,
      });
    }
  }

  async reconcile(
    references: readonly ClipStorageReference[],
  ): Promise<ClipReconciliationReport> {
    return reconcileClipStorage(this.dependencies.config, references);
  }

  private async assertCapacity(expectedSizeBytes: number): Promise<void> {
    const availableBytes = this.dependencies.availableBytes
      ? await this.dependencies.availableBytes()
      : await readAvailableBytes(this.dependencies.config.rootDir);
    const requiredBytes =
      this.dependencies.config.minimumFreeBytes + BigInt(expectedSizeBytes);
    if (availableBytes < requiredBytes) {
      throw new ClipStorageError(
        CLIP_STORAGE_ERROR_CODES.INSUFFICIENT_STORAGE,
        'clip storage reserve would be breached',
      );
    }
  }
}

async function cleanupPersist(context: CleanupContext): Promise<void> {
  const cleanupFailures: unknown[] = [];
  try {
    if (context.temporaryFile !== undefined) {
      await cleanupContainedFile(context.temporaryFile);
    }
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    if (context.clipLock !== undefined) {
      await releaseClipLock(context.clipLock);
    }
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    if (context.storageLock !== undefined) {
      await releaseClipLock(context.storageLock);
    }
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (cleanupFailures.length === 0) return;

  const failures =
    context.primaryFailure === undefined
      ? cleanupFailures
      : [context.primaryFailure, ...cleanupFailures];
  throw new ClipStorageError(
    CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
    'clip persistence cleanup failed',
    {
      cause: new AggregateError(
        failures,
        'clip persistence and cleanup failures',
      ),
    },
  );
}
