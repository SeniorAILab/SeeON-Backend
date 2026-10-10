import * as path from 'path';

export function snapshotRoot(): string {
  return process.env.SNAPSHOT_DIR ?? path.join(process.cwd(), 'snapshots');
}
