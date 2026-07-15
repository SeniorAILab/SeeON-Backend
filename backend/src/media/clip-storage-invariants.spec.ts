import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { ClipStorageService } from './clip-storage.service.js';
import {
  CLIP_STORAGE_ERROR_CODES,
  type ClipPersistRequest,
  type ClipStorageConfig,
} from './clip-storage.types.js';

describe('ClipStorageService persistence invariants', () => {
  let rootDir: string;
  let config: ClipStorageConfig;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-invariants-'));
    config = {
      rootDir,
      maximumBytes: 10,
      minimumFreeBytes: 100n,
      lockRetryCount: 1_000,
      lockRetryDelayMs: 1,
    };
  });

  afterEach(() => fs.rm(rootDir, { recursive: true, force: true }));

  it('checks inspected duration before atomic publication', async () => {
    // Given: hash and length are valid but the inspector reports another duration.
    const bytes = Buffer.from('1234567890');
    const service = new ClipStorageService({
      config: { ...config, minimumFreeBytes: 0n },
      inspector: {
        inspect: () =>
          Promise.resolve({ codec: 'h264' as const, durationMs: 1_001 }),
      },
      availableBytes: () => Promise.resolve(10n),
    });

    // When: persistence reaches media inspection.
    const action = service.persist(clipRequest('duration', bytes));

    // Then: the mismatch is typed and neither final nor transient files remain.
    await expect(action).rejects.toMatchObject({
      code: CLIP_STORAGE_ERROR_CODES.DURATION_MISMATCH,
    });
    await expect(listFiles(rootDir)).resolves.toEqual([]);
  });

  it('drains an oversized source before returning length mismatch', async () => {
    // Given: a source continues with more chunks after the declared length.
    const declared = Buffer.from('abc');
    const source = Readable.from([
      declared,
      Buffer.from('overflow'),
      Buffer.from('tail'),
    ]);
    const service = new ClipStorageService({
      config: { ...config, minimumFreeBytes: 0n },
      inspector: {
        inspect: () =>
          Promise.resolve({ codec: 'h264' as const, durationMs: 1_000 }),
      },
      availableBytes: () => Promise.resolve(10n),
    });

    // When: the streamed bytes exceed the immutable declaration.
    const action = service.persist({
      ...clipRequest('overflow', declared),
      source,
    });

    // Then: all chunks are consumed before rejection and cleanup is complete.
    await expect(action).rejects.toMatchObject({
      code: CLIP_STORAGE_ERROR_CODES.LENGTH_MISMATCH,
    });
    expect(source.readableEnded).toBe(true);
    await expect(listFiles(rootDir)).resolves.toEqual([]);
  });

  it('serializes capacity reservation across different clip identities', async () => {
    // Given: the volume can accept exactly one of two distinct ten-byte clips.
    const observations: number[] = [];
    const availableBytes = async () => {
      const finalCount = (await listFiles(rootDir)).filter((file) =>
        file.endsWith('.mp4'),
      ).length;
      observations.push(finalCount);
      return finalCount === 0 ? 110n : 100n;
    };
    const service = new ClipStorageService({
      config,
      inspector: {
        inspect: () =>
          Promise.resolve({ codec: 'h264' as const, durationMs: 1_000 }),
      },
      availableBytes,
    });
    const first = Buffer.from('1234567890');
    const second = Buffer.from('abcdefghij');

    // When: different clip identities race the same capacity boundary.
    const settled = await Promise.allSettled([
      service.persist(clipRequest('capacity-a', first)),
      service.persist(clipRequest('capacity-b', second)),
    ]);

    // Then: one wins, one gets 507 semantics, and no lock/temp/orphan remains.
    expect(
      settled.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = settled.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: CLIP_STORAGE_ERROR_CODES.INSUFFICIENT_STORAGE },
    });
    expect(observations).toEqual([0, 1]);
    const files = await listFiles(rootDir);
    expect(files.filter((file) => file.endsWith('.mp4'))).toHaveLength(1);
    expect(
      files.some((file) => file.endsWith('.part') || file.endsWith('.lock')),
    ).toBe(false);
  });
});

function clipRequest(clipId: string, bytes: Buffer): ClipPersistRequest {
  return {
    facilityId: 'facility-1',
    clipId,
    expectedSha256: createHash('sha256').update(bytes).digest('hex'),
    expectedSizeBytes: bytes.length,
    expectedDurationMs: 1_000,
    source: Readable.from(bytes),
  };
}

async function listFiles(rootDir: string): Promise<readonly string[]> {
  const files: string[] = [];
  await collectFiles(rootDir, rootDir, files);
  return files.sort();
}

async function collectFiles(
  rootDir: string,
  directory: string,
  files: string[],
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(rootDir, absolute, files);
    } else {
      files.push(path.relative(rootDir, absolute).split(path.sep).join('/'));
    }
  }
}
