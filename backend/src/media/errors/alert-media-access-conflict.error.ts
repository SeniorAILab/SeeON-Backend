export class AlertMediaAccessConflictError extends Error {
  readonly name = 'AlertMediaAccessConflictError';

  constructor(readonly interactionId: string) {
    super('media interaction id is already bound to another action');
  }
}
