import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AlertMediaFileError, openAlertMediaFile } from './alert-media-file.js';

const FACILITY_ID = 'facility-a';
const CLIP_ID = 'clip-a';
const SHA256 = 'a'.repeat(64);
const STORAGE_KEY = `${FACILITY_ID}/${CLIP_ID}/${SHA256}.mp4`;
const MEDIA_BYTES = Buffer.from('inside-media');
const OTHER_BYTES = Buffer.from('outside-data');

type OpenOutcome =
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'served'; readonly handle: FileHandle };

describe('openAlertMediaFile descriptor containment', () => {
  let sandbox: string;
  let rootDir: string;
  let parentDir: string;
  let candidate: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'alert-media-fd-'));
    rootDir = path.join(sandbox, 'root');
    parentDir = path.join(rootDir, FACILITY_ID, CLIP_ID);
    candidate = path.join(parentDir, `${SHA256}.mp4`);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(candidate, MEDIA_BYTES);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('rejects an outside directory swapped in after parent validation and closes the opened descriptor', async () => {
    const outsideDir = path.join(sandbox, 'outside');
    const parkedDir = path.join(sandbox, 'parked');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, `${SHA256}.mp4`), OTHER_BYTES);

    const opened = captureOpenedHandle();
    const originalRealpath = fs.realpath.bind(fs);
    jest.spyOn(fs, 'realpath').mockImplementation(async (target) => {
      const resolved = await originalRealpath(target);
      if (target === parentDir) {
        await fs.rename(parentDir, parkedDir);
        await fs.symlink(outsideDir, parentDir, 'dir');
      }
      return resolved;
    });

    await expectRejectedAndClosed(await attemptOpen(rootDir), opened.read());
  });

  it('rejects a pre-existing intermediate symlink to another facility path inside the root', async () => {
    const otherParent = path.join(rootDir, 'facility-b', 'clip-b');
    await fs.mkdir(otherParent, { recursive: true });
    await fs.writeFile(path.join(otherParent, `${SHA256}.mp4`), OTHER_BYTES);
    await fs.rm(parentDir, { recursive: true });
    await fs.symlink(otherParent, parentDir, 'dir');

    const opened = captureOpenedHandle();
    await expectRejectedAndClosed(await attemptOpen(rootDir), opened.read());
  });

  it('rejects a file renamed after open but before descriptor validation and closes that descriptor', async () => {
    const moved = path.join(sandbox, 'moved.mp4');
    const opened = captureOpenedHandle(async () => {
      await fs.rename(candidate, moved);
    });

    await expectRejectedAndClosed(await attemptOpen(rootDir), opened.read());
  });
});

function captureOpenedHandle(
  afterOpen?: (handle: FileHandle) => Promise<void>,
): { readonly read: () => FileHandle | undefined } {
  const originalOpen = fs.open.bind(fs);
  let opened: FileHandle | undefined;
  jest.spyOn(fs, 'open').mockImplementation(async (filePath, flags, mode) => {
    const handle = await originalOpen(filePath, flags, mode);
    opened = handle;
    if (afterOpen !== undefined) await afterOpen(handle);
    return handle;
  });
  return { read: () => opened };
}

async function attemptOpen(rootDir: string): Promise<OpenOutcome> {
  try {
    const result = await openAlertMediaFile({
      rootDir,
      facilityId: FACILITY_ID,
      storageKey: STORAGE_KEY,
      sha256: SHA256,
      expectedSizeBytes: MEDIA_BYTES.length,
    });
    return { kind: 'served', handle: result.handle };
  } catch (error) {
    if (!(error instanceof AlertMediaFileError)) throw error;
    return { kind: 'rejected', error };
  }
}

async function expectRejectedAndClosed(
  outcome: OpenOutcome,
  opened: FileHandle | undefined,
): Promise<void> {
  try {
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.error).toBeInstanceOf(AlertMediaFileError);
    }
  } finally {
    if (outcome.kind === 'served') await outcome.handle.close();
  }
  expect(opened).toBeDefined();
  if (opened !== undefined) {
    await expect(opened.stat()).rejects.toMatchObject({ code: 'EBADF' });
  }
}
