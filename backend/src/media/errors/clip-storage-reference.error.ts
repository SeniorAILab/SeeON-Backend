export class ClipStorageReferenceError extends Error {
  readonly name = 'ClipStorageReferenceError';

  constructor(readonly storageKey: string | null) {
    super('stored clip reference is incomplete or exceeds safe integer range');
  }
}
