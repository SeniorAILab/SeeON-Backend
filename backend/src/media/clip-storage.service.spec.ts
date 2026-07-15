import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { ClipStorageService } from './clip-storage.service.js';
import {
  CLIP_STORAGE_ERROR_CODES,
  ClipStorageError,
  type ClipInspector,
  type ClipStorageConfig,
} from './clip-storage.types.js';

const FACILITY_ID = 'facility-1';
const CLIP_ID = 'clip-1';

class AcceptingInspector implements ClipInspector {
  inspect() {
    return Promise.resolve({ codec: 'h264' as const, durationMs: 1_000 });
  }
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function request(
  bytes: Buffer,
  overrides: Partial<{ sha256: string; size: number }> = {},
) {
  return {
    facilityId: FACILITY_ID,
    clipId: CLIP_ID,
    expectedSha256: overrides.sha256 ?? digest(bytes),
    expectedSizeBytes: overrides.size ?? bytes.length,
    source: Readable.from(bytes),
  };
}

describe('ClipStorageService persist', () => {
  let rootDir: string;
  let config: ClipStorageConfig;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-store-'));
    config = {
      rootDir,
      maximumBytes: 1024 * 1024,
      minimumFreeBytes: 0n,
      lockRetryCount: 100,
      lockRetryDelayMs: 1,
    };
  });

  afterEach(async () => {
    await fs.chmod(rootDir, 0o700).catch(() => undefined);
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('rejects dot path segments before storage or inspection', async () => {
    // Given: a facility identifier could otherwise escape the storage root.
    const inspect = jest
      .fn()
      .mockRejectedValue(
        new ClipStorageError(
          CLIP_STORAGE_ERROR_CODES.UNSUPPORTED_MEDIA,
          'inspection must not run',
        ),
      );
    const service = new ClipStorageService({
      config,
      inspector: { inspect },
    });
    const bytes = Buffer.from('media');

    // When: a dot path segment reaches the persistence boundary.
    const action = service.persist({
      ...request(bytes),
      facilityId: '..',
    });

    // Then: validation rejects it before filesystem or inspector access.
    await expect(action).rejects.toMatchObject({
      code: CLIP_STORAGE_ERROR_CODES.INVALID_INPUT,
    });
    expect(inspect).not.toHaveBeenCalled();
    await expect(listFiles(rootDir)).resolves.toEqual([]);
  });

  it('rejects a checksum mismatch and removes the temporary file', async () => {
    // Given: the declared checksum differs from the streamed bytes.
    const service = new ClipStorageService({
      config,
      inspector: new AcceptingInspector(),
    });

    // When: the clip is persisted.
    const action = service.persist(
      request(Buffer.from('actual-media'), { sha256: '0'.repeat(64) }),
    );

    // Then: the checksum error is typed and no staged/final bytes remain.
    await expect(action).rejects.toMatchObject({
      code: CLIP_STORAGE_ERROR_CODES.CHECKSUM_MISMATCH,
    });
    await expect(listFiles(rootDir)).resolves.toEqual([]);
  });

  it('rejects a truncated stream and removes the temporary file', async () => {
    // Given: content-length declares more bytes than the source yields.
    const service = new ClipStorageService({
      config,
      inspector: new AcceptingInspector(),
    });
    const bytes = Buffer.from('short');

    // When: the clip is persisted.
    const action = service.persist(request(bytes, { size: bytes.length + 1 }));

    // Then: the length mismatch is typed and no staged/final bytes remain.
    await expect(action).rejects.toMatchObject({
      code: CLIP_STORAGE_ERROR_CODES.LENGTH_MISMATCH,
    });
    await expect(listFiles(rootDir)).resolves.toEqual([]);
  });

  it('rejects media when the H264 inspector rejects it', async () => {
    // Given: bytes have valid hash/length but are not an H264 MP4.
    const inspector: ClipInspector = {
      inspect: () =>
        Promise.reject(
          new ClipStorageError(
            CLIP_STORAGE_ERROR_CODES.UNSUPPORTED_MEDIA,
            'not H264',
          ),
        ),
    };
    const service = new ClipStorageService({ config, inspector });

    // When: the non-H264 bytes are persisted.
    const action = service.persist(request(Buffer.from('not-an-mp4')));

    // Then: the media is rejected and no staged/final bytes remain.
    await expect(action).rejects.toMatchObject({
      code: CLIP_STORAGE_ERROR_CODES.UNSUPPORTED_MEDIA,
    });
    await expect(listFiles(rootDir)).resolves.toEqual([]);
  });

  it('rejects before reading when free space is below the configured floor', async () => {
    // Given: the volume reports less than the configured reserve.
    const source = new Readable({
      read() {
        throw new Error('source must not be read');
      },
    });
    const service = new ClipStorageService({
      config: { ...config, minimumFreeBytes: 2n },
      inspector: new AcceptingInspector(),
      availableBytes: () => Promise.resolve(1n),
    });

    // When: persistence starts.
    const action = service.persist({
      facilityId: FACILITY_ID,
      clipId: CLIP_ID,
      expectedSha256: '0'.repeat(64),
      expectedSizeBytes: 1,
      source,
    });

    // Then: it fails as insufficient storage without touching the source.
    await expect(action).rejects.toMatchObject({
      code: CLIP_STORAGE_ERROR_CODES.INSUFFICIENT_STORAGE,
    });
  });

  it('fails safely when the storage root is read-only', async () => {
    // Given: the configured volume cannot create staging or lock files.
    await fs.chmod(rootDir, 0o500);
    const service = new ClipStorageService({
      config,
      inspector: new AcceptingInspector(),
    });

    // When: persistence starts.
    const action = service.persist(request(Buffer.from('media')));

    // Then: the write failure is typed and no clip is published.
    await expect(action).rejects.toMatchObject({
      code: CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
    });
  });

  it('converges identical concurrent ingest to one immutable inode', async () => {
    // Given: two requests carry exactly the same clip bytes and identity.
    const service = new ClipStorageService({
      config,
      inspector: new AcceptingInspector(),
    });
    const bytes = Buffer.from('same-media');

    // When: both requests race.
    const results = await Promise.all([
      service.persist(request(bytes)),
      service.persist(request(bytes)),
    ]);

    // Then: one publishes, one converges as duplicate, and one MP4 remains.
    expect(results.map((result) => result.duplicate).sort()).toEqual([
      false,
      true,
    ]);
    const files = await listFiles(rootDir);
    expect(files).toEqual([
      path.posix.join(FACILITY_ID, CLIP_ID, `${digest(bytes)}.mp4`),
    ]);
    const stat = await fs.stat(path.join(rootDir, files[0]));
    expect(stat.nlink).toBe(1);
  });

  it('preserves the winner when differing concurrent ingest conflicts', async () => {
    // Given: two requests reuse one clip identity with different bytes.
    const service = new ClipStorageService({
      config,
      inspector: new AcceptingInspector(),
    });
    const first = Buffer.from('first-media');
    const second = Buffer.from('second-media');

    // When: both requests race.
    const settled = await Promise.allSettled([
      service.persist(request(first)),
      service.persist(request(second)),
    ]);

    // Then: exactly one succeeds, one conflicts, and only the winner remains.
    expect(
      settled.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = settled.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: { code: CLIP_STORAGE_ERROR_CODES.IMMUTABLE_CONFLICT },
    });
    const files = await listFiles(rootDir);
    expect(files).toHaveLength(1);
    expect(await fs.readFile(path.join(rootDir, files[0]))).toEqual(
      settled[0].status === 'fulfilled' ? first : second,
    );
  });
});

async function listFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (!entry.name.endsWith('.lock'))
        files.push(path.relative(rootDir, absolute).split(path.sep).join('/'));
    }
  }
  await visit(rootDir);
  return files.sort();
}
