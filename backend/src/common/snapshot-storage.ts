export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const SNAPSHOT_EXTENSIONS = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['application/octet-stream', 'bin'],
  ['multipart/form-data', 'bin'],
]);

export const IMMUTABLE_FILE_RESULT = {
  CREATED: 'created',
  IDENTICAL: 'identical',
  CONFLICT: 'conflict',
} as const;

export type ImmutableFileResult =
  (typeof IMMUTABLE_FILE_RESULT)[keyof typeof IMMUTABLE_FILE_RESULT];
