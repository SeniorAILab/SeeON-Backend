import type { EventMediaErrorCode } from '../event-media.types.js';

export class EventMediaError extends Error {
  readonly name = 'EventMediaError';

  constructor(
    readonly code: EventMediaErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
