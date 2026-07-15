import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CLIP_STORAGE_ERROR_CODES,
  ClipStorageError,
  type ClipInspection,
  type ClipInspector,
} from './clip-storage.types.js';
import { hasFaststartMp4Layout } from './mp4-faststart.js';

const execFileAsync = promisify(execFile);

export class FfprobeClipInspector implements ClipInspector {
  constructor(private readonly executable = 'ffprobe') {}

  async inspect(filePath: string): Promise<ClipInspection> {
    let stdout: string;
    try {
      const result = await execFileAsync(
        this.executable,
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type,codec_name,pix_fmt:format=format_name,duration',
          '-of',
          'json',
          filePath,
        ],
        { maxBuffer: 1024 * 1024, timeout: 10_000 },
      );
      stdout = result.stdout;
    } catch (error) {
      throw unsupportedMedia('ffprobe rejected the uploaded clip', error);
    }

    let document: unknown;
    try {
      document = JSON.parse(stdout);
    } catch (error) {
      throw unsupportedMedia('ffprobe returned invalid JSON', error);
    }

    if (!isRecord(document)) {
      throw unsupportedMedia('ffprobe did not return media streams');
    }
    const streams = readUnknownArray(document.streams);
    if (streams === undefined) {
      throw unsupportedMedia('ffprobe did not return media streams');
    }
    const videos = streams.filter(
      (stream) => isRecord(stream) && stream.codec_type === 'video',
    );
    const audios = streams.filter(
      (stream) => isRecord(stream) && stream.codec_type === 'audio',
    );
    const video = videos[0];
    if (
      videos.length !== 1 ||
      audios.length !== 0 ||
      !isRecord(video) ||
      video.codec_name !== 'h264' ||
      video.pix_fmt !== 'yuv420p' ||
      !isMp4Family(document.format)
    ) {
      throw unsupportedMedia(
        'clip must be MP4 with one H264 yuv420p video stream and no audio',
      );
    }

    const durationSeconds = readDurationSeconds(document.format);
    if (durationSeconds === undefined) {
      throw unsupportedMedia('clip duration is missing or invalid');
    }
    let faststart: boolean;
    try {
      faststart = await hasFaststartMp4Layout(filePath);
    } catch (error) {
      throw unsupportedMedia('MP4 box inspection failed', error);
    }
    if (!faststart) {
      throw unsupportedMedia(
        'clip MP4 must place the top-level moov box before mdat',
      );
    }
    return {
      codec: 'h264',
      durationMs: Math.max(1, Math.round(durationSeconds * 1_000)),
    };
  }
}

function isMp4Family(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.format_name === 'string' &&
    value.format_name.split(',').includes('mp4')
  );
}

function readDurationSeconds(value: unknown): number | undefined {
  if (!isRecord(value) || typeof value.duration !== 'string') {
    return undefined;
  }
  const parsed = Number(value.duration);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readUnknownArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item: unknown) => item);
}

function unsupportedMedia(message: string, cause?: unknown): ClipStorageError {
  return new ClipStorageError(
    CLIP_STORAGE_ERROR_CODES.UNSUPPORTED_MEDIA,
    message,
    cause === undefined ? undefined : { cause },
  );
}
