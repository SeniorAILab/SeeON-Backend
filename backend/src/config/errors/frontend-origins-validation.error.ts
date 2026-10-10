export class FrontendOriginsValidationError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(errors.join('\n'));
    this.name = 'FrontendOriginsValidationError';
  }
}
