import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable } from 'node:stream';

export async function writeAlertSnapshot(
  filePath: string,
  body: Buffer,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, body);
}

export function alertSnapshotExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function openAlertSnapshot(filePath: string): Readable {
  return fs.createReadStream(filePath);
}
