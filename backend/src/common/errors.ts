import { Prisma } from '@prisma/client';

/** True when the error is a Prisma P2002 unique-constraint violation. */
export function isUniqueConstraintViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
