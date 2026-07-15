import type { Readable } from 'node:stream';
import {
  EVENT_MEDIA_ERROR_CODES,
  EventMediaError,
  type ReadyClipUpload,
} from './event-media.types.js';

type Headers = Readonly<Record<string, string | readonly string[] | undefined>>;

const SAFE_CLIP_ID = /^[A-Za-z0-9._-]{1,200}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function parseReadyClipUpload(
  externalClipId: string,
  headers: Headers,
  source: Readable,
): ReadyClipUpload {
  if (
    !SAFE_CLIP_ID.test(externalClipId) ||
    externalClipId === '.' ||
    externalClipId === '..'
  ) {
    throw invalidInput('clip_id is invalid');
  }
  const contentType = requiredHeader(headers, 'content-type')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'video/mp4') {
    throw invalidInput('content-type must be video/mp4');
  }
  const cameraId = requiredHeader(headers, 'x-edge-camera-id').trim();
  if (cameraId.length === 0) throw invalidInput('camera_id is required');
  const eventRefs = parseEventRefs(
    requiredHeader(headers, 'x-edge-event-refs'),
  );
  const clipStartAt = parseUtc(requiredHeader(headers, 'x-clip-start-at'));
  const clipEndAt = parseUtc(requiredHeader(headers, 'x-clip-end-at'));
  const finalizedAt = parseUtc(requiredHeader(headers, 'x-clip-finalized-at'));
  if (
    clipStartAt.getTime() > clipEndAt.getTime() ||
    clipEndAt.getTime() > finalizedAt.getTime()
  ) {
    throw invalidInput('clip timestamps are not monotonic');
  }
  const sha256 = requiredHeader(headers, 'x-clip-sha256');
  if (!SHA256.test(sha256)) throw invalidInput('sha256 is invalid');

  return {
    externalClipId,
    cameraId,
    eventRefs,
    clipStartAt,
    clipEndAt,
    finalizedAt,
    sha256,
    sizeBytes: parsePositiveInteger(
      requiredHeader(headers, 'x-clip-size-bytes'),
      'size_bytes',
    ),
    durationMs: parseBoundedDuration(
      requiredHeader(headers, 'x-clip-duration-ms'),
    ),
    stateVersion: parsePositiveInteger(
      requiredHeader(headers, 'x-clip-state-version'),
      'state_version',
    ),
    source,
  };
}

export function validateUnavailableClipId(externalClipId: string): void {
  if (
    !SAFE_CLIP_ID.test(externalClipId) ||
    externalClipId === '.' ||
    externalClipId === '..'
  ) {
    throw invalidInput('clip_id is invalid');
  }
}

export function validateEventRefs(
  values: readonly string[],
): readonly string[] {
  if (
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some((value) => !UUID_V4.test(value))
  ) {
    throw invalidInput('event_refs must be ordered unique UUIDv4 values');
  }
  return values;
}

function parseEventRefs(raw: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw invalidInput('x-edge-event-refs must be a JSON array');
    }
    throw error;
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((value) => typeof value === 'string')
  ) {
    throw invalidInput('x-edge-event-refs must be a string array');
  }
  return validateEventRefs(parsed);
}

function requiredHeader(headers: Headers, name: string): string {
  const raw = headers[name];
  if (raw === undefined) {
    throw invalidInput(`${name} is required`);
  }
  if (typeof raw === 'string') {
    if (raw.length === 0) throw invalidInput(`${name} is required`);
    return raw;
  }
  const [value = ''] = raw;
  if (value.length === 0) {
    throw invalidInput(`${name} is required`);
  }
  return value;
}

function parseUtc(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw invalidInput('clip timestamps must be canonical UTC RFC3339');
  }
  return parsed;
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw invalidInput(`${field} must be a positive safe integer`);
  }
  return parsed;
}

function parseBoundedDuration(value: string): number {
  const durationMs = parsePositiveInteger(value, 'duration_ms');
  if (durationMs > 120_000) throw invalidInput('duration_ms exceeds 120000');
  return durationMs;
}

function invalidInput(message: string): EventMediaError {
  return new EventMediaError(EVENT_MEDIA_ERROR_CODES.INVALID_INPUT, message);
}
