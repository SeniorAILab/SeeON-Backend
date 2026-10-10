export class MediaDownloadAuditConsistencyError extends Error {
  readonly name = 'MediaDownloadAuditConsistencyError';

  constructor() {
    super('download audit and recovery job lease versions diverged');
  }
}
