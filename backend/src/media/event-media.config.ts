import {
  EVENT_MEDIA_ERROR_CODES,
  EventMediaError,
  type EventMediaConfig,
} from './event-media.types.js';

const MINIMUM_RETENTION_DAYS = 60;

export function readEventMediaConfig(
  environment: NodeJS.ProcessEnv = process.env,
): EventMediaConfig {
  const retentionDays = Number(
    environment.MEDIA_RETENTION_DAYS ?? MINIMUM_RETENTION_DAYS,
  );
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MINIMUM_RETENTION_DAYS
  ) {
    throw new EventMediaError(
      EVENT_MEDIA_ERROR_CODES.INVALID_INPUT,
      'MEDIA_RETENTION_DAYS must be an integer of at least 60',
    );
  }
  return {
    enabled: environment.EVENT_CLIPS_ENABLED === 'true',
    retentionDays,
  };
}

export function retentionExpiry(
  finalizedAt: Date,
  retentionDays: number,
): Date {
  return new Date(finalizedAt.getTime() + retentionDays * 24 * 60 * 60 * 1_000);
}
