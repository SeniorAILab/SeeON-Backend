import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'path';
import {
  IMMUTABLE_FILE_RESULT,
  type ImmutableFileResult,
} from '../snapshot-storage.js';

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
