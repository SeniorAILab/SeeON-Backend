export class ClipStorageConfigError extends Error {
  readonly name = 'ClipStorageConfigError';

  constructor(readonly value: string | undefined) {
    super('clip storage configuration must use positive safe integers');
  }
}
