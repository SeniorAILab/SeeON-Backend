import { BadRequestException } from '@nestjs/common';
import * as path from 'path';
import { FacilityScopedNotFoundException } from './domain-errors.js';

export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const SNAPSHOT_EXTENSIONS = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['application/octet-stream', 'bin'],
  ['multipart/form-data', 'bin'],
]);

export function snapshotRoot(): string {
  return process.env.SNAPSHOT_DIR ?? path.join(process.cwd(), 'snapshots');
}

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

export async function readRequestBody(
  req: AsyncIterable<Buffer | string>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer: Uint8Array =
      typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new BadRequestException('Snapshot exceeds size limit');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
