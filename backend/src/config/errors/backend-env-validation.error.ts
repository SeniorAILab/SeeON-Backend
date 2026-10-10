export class BackendEnvValidationError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`Invalid backend production env:\n${errors.join('\n')}`);
    this.name = 'BackendEnvValidationError';
  }
}
