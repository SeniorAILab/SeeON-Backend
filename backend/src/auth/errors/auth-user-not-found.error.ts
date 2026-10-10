export class AuthUserNotFoundError extends Error {
  readonly name = 'AuthUserNotFoundError';

  constructor() {
    super('Unknown user');
  }
}
