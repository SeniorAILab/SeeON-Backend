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
const MEDIA = Buffer.from('contained-media');

describe('ClipStorageService write containment', () => {
  let sandbox: string;
  let rootDir: string;
  let outsideDir: string;
  let config: ClipStorageConfig;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-containment-'));
    rootDir = path.join(sandbox, 'root');
    outsideDir = path.join(sandbox, 'outside');
    await Promise.all([
      fs.mkdir(rootDir, { recursive: true }),
      fs.mkdir(outsideDir, { recursive: true }),
    ]);
    config = {
      rootDir,
      maximumBytes: 1024 * 1024,
      minimumFreeBytes: 0n,
      lockRetryCount: 2,
      lockRetryDelayMs: 1,
    };
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('rejects a lock parent swapped immediately before file creation without writing outside', async () => {
    // Given: an attacker replaces the verified lock directory at the create seam.
    const lockDir = path.join(rootDir, '.locks');
    const parkedLockDir = path.join(sandbox, 'parked-locks');
    const outsideStoreLock = path.join(outsideDir, '.store.lock');
    const originalOpen = fs.open.bind(fs);
    let replaced = false;
    let escapedBytes: Buffer | undefined;
    jest.spyOn(fs, 'open').mockImplementation(async (filePath, flags, mode) => {
      if (
        !replaced &&
        typeof filePath === 'string' &&
        filePath.endsWith('.store.lock')
      ) {
        replaced = true;
        await fs.rename(lockDir, parkedLockDir);
        await fs.symlink(outsideDir, lockDir, 'dir');
      } else if (
        replaced &&
        typeof filePath === 'string' &&
        filePath.endsWith(`${CLIP_ID}.lock`)
      ) {
        escapedBytes = await fs
          .readFile(outsideStoreLock)
          .catch(() => undefined);
        const denied = new Error('forced lock acquisition failure');
        Object.assign(denied, { code: 'EACCES' });
        throw denied;
      }
      return originalOpen(filePath, flags, mode);
    });

    // When: persistence acquires the global lock after the directory swap.
    const action = service(config).persist(request());

    // Then: containment fails before any lock bytes reach the outside target.
    await expectContainmentRejection(action);
    expect(escapedBytes).toBeUndefined();
    await expect(listFiles(outsideDir)).resolves.toEqual([]);
    await expect(listFiles(parkedLockDir)).resolves.toEqual([]);
  });

  it('rejects an intermediate staging symlink before writing media', async () => {
    // Given: the facility staging segment redirects outside the configured root.
    const stagingRoot = path.join(rootDir, '.staging');
    await fs.mkdir(stagingRoot, { recursive: true });
    await fs.symlink(outsideDir, path.join(stagingRoot, FACILITY_ID), 'dir');
    const inspect = jest.fn<ReturnType<ClipInspector['inspect']>, [string]>(
      () => Promise.resolve({ codec: 'h264', durationMs: 1_000 }),
    );

    // When: persistence attempts to create the streamed temporary file.
    const action = service(config, { inspect }).persist(request());

    // Then: no inspector or outside media write is reachable.
    await expectContainmentRejection(action);
    expect(inspect).not.toHaveBeenCalled();
    await expect(listFiles(outsideDir)).resolves.toEqual([]);
  });

  it('rejects an intermediate final symlink before atomic publication', async () => {
    // Given: the clip publication directory redirects outside the root.
    const facilityDir = path.join(rootDir, FACILITY_ID);
    await fs.mkdir(facilityDir, { recursive: true });
    await fs.symlink(outsideDir, path.join(facilityDir, CLIP_ID), 'dir');

    // When: valid staged bytes reach publication.
    const action = service(config).persist(request());

    // Then: no immutable media file is linked through the symlink.
    await expectContainmentRejection(action);
    await expect(listFiles(outsideDir)).resolves.toEqual([]);
  });

  it('rejects a staging parent replaced immediately before file creation', async () => {
    // Given: an attacker swaps the verified staging parent at the create seam.
    const temporaryDir = path.join(rootDir, '.staging', FACILITY_ID, CLIP_ID);
    const parkedDir = path.join(sandbox, 'parked-staging');
    const inspect = jest.fn<ReturnType<ClipInspector['inspect']>, [string]>(
      () => Promise.resolve({ codec: 'h264', durationMs: 1_000 }),
    );
    const originalOpen = fs.open.bind(fs);
    let replaced = false;
    jest.spyOn(fs, 'open').mockImplementation(async (filePath, flags, mode) => {
      if (
        !replaced &&
        typeof filePath === 'string' &&
        filePath.endsWith('.part')
      ) {
        replaced = true;
        await fs.rename(temporaryDir, parkedDir);
        await fs.symlink(outsideDir, temporaryDir, 'dir');
      }
      return originalOpen(filePath, flags, mode);
    });

    // When: the staged file is opened after the directory replacement.
    const action = service(config, { inspect }).persist(request());

    // Then: the descriptor mismatch rejects and removes every escaped file.
    await expectContainmentRejection(action);
    expect(inspect).not.toHaveBeenCalled();
    await expect(listFiles(outsideDir)).resolves.toEqual([]);
    await expect(listFiles(parkedDir)).resolves.toEqual([]);
  });

  it('rejects a final parent replaced after enumeration but before publish', async () => {
    // Given: the exact final directory is replaced at the atomic-link seam.
    const finalDir = path.join(rootDir, FACILITY_ID, CLIP_ID);
    const parkedDir = path.join(sandbox, 'parked-final');
    const originalReaddir = fs.readdir.bind(fs);
    let replaced = false;
    jest.spyOn(fs, 'readdir').mockImplementation(async (directory, options) => {
      const entries = await originalReaddir(directory, options);
      if (!replaced) {
        const resolved = await fs.realpath(directory);
        if (resolved === finalDir) {
          replaced = true;
          await fs.rename(finalDir, parkedDir);
          await fs.symlink(outsideDir, finalDir, 'dir');
        }
      }
      return entries;
    });

    // When: publication continues after the parent replacement.
    const action = service(config).persist(request());

    // Then: no final media survives in either attacker-controlled directory.
    await expectContainmentRejection(action);
    await expect(listFiles(outsideDir)).resolves.toEqual([]);
    await expect(listFiles(parkedDir)).resolves.toEqual([]);
  });
});

function service(
  config: ClipStorageConfig,
  inspector: ClipInspector = acceptingInspector,
): ClipStorageService {
  return new ClipStorageService({ config, inspector });
}

const acceptingInspector: ClipInspector = {
  inspect: () => Promise.resolve({ codec: 'h264' as const, durationMs: 1_000 }),
};

function request() {
  return {
    facilityId: FACILITY_ID,
    clipId: CLIP_ID,
    expectedSha256: createHash('sha256').update(MEDIA).digest('hex'),
    expectedSizeBytes: MEDIA.length,
    expectedDurationMs: 1_000,
    source: Readable.from(MEDIA),
  };
}

async function expectContainmentRejection(
  action: Promise<unknown>,
): Promise<void> {
  await expect(action).rejects.toMatchObject({
    code: CLIP_STORAGE_ERROR_CODES.STORAGE_UNWRITABLE,
  });
}

async function listFiles(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  await collectFiles(directory, directory, files);
  return files.sort();
}

async function collectFiles(
  root: string,
  directory: string,
  files: string[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, absolute, files);
    } else {
      files.push(path.relative(root, absolute));
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
