import type { ClipStorageErrorCode } from '../clip-storage.types.js';

export class ClipStorageError extends Error {
  readonly name = 'ClipStorageError';

  constructor(
    readonly code: ClipStorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
