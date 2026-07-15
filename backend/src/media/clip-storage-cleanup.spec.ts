import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { ClipStorageService } from './clip-storage.service.js';
import {
  CLIP_STORAGE_ERROR_CODES,
  type ClipInspector,
  type ClipStorageConfig,
} from './clip-storage.types.js';

const FACILITY_ID = 'facility-1';
const CLIP_ID = 'clip-1';
const bytes = Buffer.from('incoming-media');

describe('ClipStorageService cleanup failures', () => {
  let rootDir: string;
  let config: ClipStorageConfig;
  let temporaryDir: string;
  let lockDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-cleanup-'));
    temporaryDir = path.join(rootDir, '.staging', FACILITY_ID, CLIP_ID);
    lockDir = path.join(rootDir, '.locks', FACILITY_ID);
    config = {
      rootDir,
      maximumBytes: 1024 * 1024,
      minimumFreeBytes: 0n,
      lockRetryCount: 2,
      lockRetryDelayMs: 1,
    };
  });

  afterEach(async () => {
    await fs.chmod(temporaryDir, 0o700).catch(() => undefined);
    await fs.chmod(lockDir, 0o700).catch(() => undefined);
    await fs.chmod(rootDir, 0o700).catch(() => undefined);
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('surfaces a temp cleanup fault while preserving the primary failure', async () => {
    // Given: publish will conflict after inspection makes staging read-only.
    const failure = await persistWithCleanupFaults(config, false);

    // Then: cleanup is the surfaced failure and its cause preserves both errors.
    expect(failure).toMatchObject({
      code: CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
    });
    const errors = aggregateErrors(failure);
    expect(errors).toHaveLength(2);
    expect(errorCode(errors[0])).toBe(
      CLIP_STORAGE_ERROR_CODES.IMMUTABLE_CONFLICT,
    );
    expect(errorCode(errors[1])).toBe(
      CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
    );
    expect(causeCode(errors[1])).toBe('EACCES');
  });

  it('preserves primary, temp, and lock failures in cleanup order', async () => {
    // Given: both transient directories become read-only before publish conflicts.
    const failure = await persistWithCleanupFaults(config, true);

    // Then: neither cleanup failure is discarded from the cause chain.
    expect(failure).toMatchObject({
      code: CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
    });
    const errors = aggregateErrors(failure);
    expect(errors).toHaveLength(3);
    expect(errorCode(errors[0])).toBe(
      CLIP_STORAGE_ERROR_CODES.IMMUTABLE_CONFLICT,
    );
    expect(errorCode(errors[1])).toBe(
      CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
    );
    expect(causeCode(errors[1])).toBe('EACCES');
    expect(errorCode(errors[2])).toBe('EACCES');
  });
});

async function persistWithCleanupFaults(
  config: ClipStorageConfig,
  failLockCleanup: boolean,
): Promise<unknown> {
  const temporaryDir = path.join(
    config.rootDir,
    '.staging',
    FACILITY_ID,
    CLIP_ID,
  );
  const lockDir = path.join(config.rootDir, '.locks', FACILITY_ID);
  const inspector: ClipInspector = {
    inspect: async () => {
      const finalDir = path.join(config.rootDir, FACILITY_ID, CLIP_ID);
      await fs.mkdir(finalDir, { recursive: true });
      await fs.writeFile(
        path.join(finalDir, `${'0'.repeat(64)}.mp4`),
        'existing-winner',
      );
      await fs.chmod(temporaryDir, 0o500);
      if (failLockCleanup) await fs.chmod(lockDir, 0o500);
      return { codec: 'h264', durationMs: 1_000 };
    },
  };
  const service = new ClipStorageService({ config, inspector });
  let failure: unknown;
  try {
    await service.persist({
      facilityId: FACILITY_ID,
      clipId: CLIP_ID,
      expectedSha256: createHash('sha256').update(bytes).digest('hex'),
      expectedSizeBytes: bytes.length,
      expectedDurationMs: 1_000,
      source: Readable.from(bytes),
    });
  } catch (error) {
    failure = error;
  } finally {
    await fs.chmod(temporaryDir, 0o700).catch(() => undefined);
    await fs.chmod(lockDir, 0o700).catch(() => undefined);
  }
  return failure;
}

function aggregateErrors(error: unknown): readonly unknown[] {
  if (!(error instanceof Error) || !(error.cause instanceof AggregateError)) {
    throw new Error('expected cleanup failure with AggregateError cause');
  }
  return error.cause.errors;
}

function causeCode(error: unknown): unknown {
  return error instanceof Error ? errorCode(error.cause) : undefined;
}

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return error.code;
}
