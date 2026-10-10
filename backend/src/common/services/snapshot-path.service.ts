import * as path from 'path';
import { FacilityScopedNotFoundException } from '../domain-errors.js';

export function resolveSnapshotPath(
  snapshotDir: string,
  snapshotKey: string,
): string {
  const root = path.resolve(snapshotDir);
  const resolved = path.resolve(root, snapshotKey);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new FacilityScopedNotFoundException('snapshot');
  }
  return resolved;
}
