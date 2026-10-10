import type { ClipReconciliationReport } from '../clip-storage.types.js';

export class ClipStorageReconciliationError extends Error {
  readonly name = 'ClipStorageReconciliationError';

  constructor(readonly report: ClipReconciliationReport) {
    super('clip storage reconciliation found missing or corrupt media');
  }
}
