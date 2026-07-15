import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { FfprobeClipInspector } from './clip-inspector.js';
import { CLIP_STORAGE_ERROR_CODES } from './clip-storage.types.js';

const execFileAsync = promisify(execFile);

describe('FfprobeClipInspector', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-probe-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('accepts an H264 MP4 without audio and returns measured duration', async () => {
    // Given: ffmpeg produced a small browser-compatible H264 MP4.
    const filePath = path.join(directory, 'valid.mp4');
    await generateH264(filePath, [
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
    ]);

    // When: the finalized file is inspected.
    const result = await new FfprobeClipInspector().inspect(filePath);

    // Then: codec and positive measured duration come from ffprobe.
    expect(result.codec).toBe('h264');
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('rejects H264 carried in a non-MP4 container', async () => {
    // Given: the video contract is encoded into an MPEG transport stream.
    const filePath = path.join(directory, 'transport.ts');
    await generateH264(filePath, ['-pix_fmt', 'yuv420p', '-f', 'mpegts']);

    // When: the non-MP4 H264 clip is inspected.
    const action = new FfprobeClipInspector().inspect(filePath);

    // Then: the container mismatch is rejected.
    await expect(action).rejects.toMatchObject({
      code: CLIP_STORAGE_ERROR_CODES.UNSUPPORTED_MEDIA,
    });
  });

  it('rejects H264 MP4 using a non-yuv420p pixel format', async () => {
    // Given: an otherwise valid faststart MP4 uses 4:4:4 chroma.
    const filePath = path.join(directory, 'yuv444p.mp4');
    await generateH264(filePath, [
      '-pix_fmt',
      'yuv444p',
      '-movflags',
      '+faststart',
    ]);

    // When: the incompatible pixel format is inspected.
    const action = new FfprobeClipInspector().inspect(filePath);

    // Then: browser compatibility is enforced.
    await expect(action).rejects.toMatchObject({
      code: CLIP_STORAGE_ERROR_CODES.UNSUPPORTED_MEDIA,
    });
  });

  it('rejects MP4 when moov follows mdat', async () => {
    // Given: ffmpeg produced a regular MP4 without faststart relocation.
    const filePath = path.join(directory, 'not-faststart.mp4');
    await generateH264(filePath, ['-pix_fmt', 'yuv420p']);

    // When: the non-faststart file is inspected.
    const action = new FfprobeClipInspector().inspect(filePath);

    // Then: the progressive-download contract is enforced.
    await expect(action).rejects.toMatchObject({
      code: CLIP_STORAGE_ERROR_CODES.UNSUPPORTED_MEDIA,
    });
  });

  it('rejects a non-media file', async () => {
    // Given: a regular file is not an MP4.
    const filePath = path.join(directory, 'invalid.mp4');
    await fs.writeFile(filePath, 'not-media');

    // When: it is inspected.
    const action = new FfprobeClipInspector().inspect(filePath);

    // Then: the failure is normalized to unsupported media.
    await expect(action).rejects.toMatchObject({
      code: CLIP_STORAGE_ERROR_CODES.UNSUPPORTED_MEDIA,
    });
  });
});

async function generateH264(
  filePath: string,
  outputOptions: readonly string[],
): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=64x64:d=1',
    '-an',
    '-c:v',
    'libx264',
    ...outputOptions,
    '-y',
    filePath,
  ]);
}
