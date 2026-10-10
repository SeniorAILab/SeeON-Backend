export type AlertMediaFileErrorReason =
  | 'INVALID_REFERENCE'
  | 'MISSING'
  | 'CORRUPT';

export class AlertMediaFileError extends Error {
  readonly name = 'AlertMediaFileError';

  constructor(
    readonly reason: AlertMediaFileErrorReason,
    options?: ErrorOptions,
  ) {
    super('alert media file cannot be served', options);
  }
}
