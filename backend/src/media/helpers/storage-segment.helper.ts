const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isSafeStorageSegment(
  value: string | undefined,
): value is string {
  return (
    value !== undefined &&
    value !== '.' &&
    value !== '..' &&
    SEGMENT_PATTERN.test(value)
  );
}
