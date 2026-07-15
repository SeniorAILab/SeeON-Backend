import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'path';
import { FacilityScopedNotFoundException } from './domain-errors.js';

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

export async function writeImmutableFile(
  filePath: string,
  body: Buffer,
): Promise<ImmutableFileResult> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryFile = await fs.promises.open(temporaryPath, 'wx', 0o600);
  let writeError: Error | null = null;

  try {
    await temporaryFile.writeFile(body);
    await temporaryFile.sync();
  } catch (error: unknown) {
    writeError = toError(error);
  }

  let closeError: Error | null = null;
  try {
    await temporaryFile.close();
  } catch (error: unknown) {
    closeError = toError(error);
  }

  let outcome: ImmutableFileResult;
  try {
    if (writeError !== null) {
      if (closeError !== null) {
        throw combineErrors(
          writeError,
          closeError,
          'Snapshot write and candidate close both failed',
        );
      }
      throw writeError;
    }
    if (closeError !== null) throw closeError;

    try {
      await fs.promises.link(temporaryPath, filePath);
      outcome = IMMUTABLE_FILE_RESULT.CREATED;
    } catch (error: unknown) {
      if (!hasErrorCode(error, 'EEXIST')) throw toError(error);
      const existing = await fs.promises.readFile(filePath);
      outcome = existing.equals(body)
        ? IMMUTABLE_FILE_RESULT.IDENTICAL
        : IMMUTABLE_FILE_RESULT.CONFLICT;
    }
  } catch (operationError: unknown) {
    const primaryError = toError(operationError);
    const cleanupError = await removeCandidate(temporaryPath);
    if (cleanupError !== null) {
      throw combineErrors(
        primaryError,
        cleanupError,
        'Snapshot operation and candidate cleanup both failed',
      );
    }
    throw primaryError;
  }

  const cleanupError = await removeCandidate(temporaryPath);
  if (cleanupError !== null) throw cleanupError;
  return outcome;
}

async function removeCandidate(candidatePath: string): Promise<Error | null> {
  try {
    await fs.promises.unlink(candidatePath);
    return null;
  } catch (error: unknown) {
    return hasErrorCode(error, 'ENOENT') ? null : toError(error);
  }
}

function combineErrors(
  primary: Error,
  secondary: Error,
  message: string,
): AggregateError {
  return new AggregateError([primary, secondary], message, { cause: primary });
}

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('Unexpected non-Error failure', { cause: error });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

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
