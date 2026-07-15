import * as path from 'node:path';
import type { ClipStorageConfig } from './clip-storage.types.js';

const DEFAULT_MAXIMUM_BYTES = 256 * 1024 * 1024;
const DEFAULT_MINIMUM_FREE_BYTES = 1024n * 1024n * 1024n;

export function readClipStorageConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ClipStorageConfig {
  return {
    rootDir:
      readNonEmpty(environment.MEDIA_CLIP_DIR) ??
      path.join(process.cwd(), 'clips'),
    maximumBytes: readPositiveInteger(
      environment.MEDIA_CLIP_MAX_BYTES,
      DEFAULT_MAXIMUM_BYTES,
    ),
    minimumFreeBytes: BigInt(
      readPositiveInteger(
        environment.MEDIA_MIN_FREE_BYTES,
        Number(DEFAULT_MINIMUM_FREE_BYTES),
      ),
    ),
    lockRetryCount: 50,
    lockRetryDelayMs: 20,
  };
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ClipStorageConfigError(value);
  }
  return parsed;
}

export class ClipStorageConfigError extends Error {
  readonly name = 'ClipStorageConfigError';

  constructor(readonly value: string | undefined) {
    super('clip storage configuration must use positive safe integers');
  }
}
