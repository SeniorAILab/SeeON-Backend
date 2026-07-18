import { Prisma } from '@prisma/client';

/** True when the error is a Prisma P2002 unique-constraint violation. */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Thrown when a Prisma tenant model operation is attempted without an active
 * facility context in TenantContext (AsyncLocalStorage).
 *
 * Belt-and-suspenders: RLS is the DB-level authority; this error surfaces
 * misuse at the application layer before the query reaches the DB.
 */
export class MissingTenantContextError extends Error {
  readonly model: string;
  readonly operation: string;

  constructor(model: string, operation: string) {
    super(
      `Tenant model "${model}.${operation}" invoked without a facility context. ` +
        `Wrap all tenant model access in PrismaService.withFacilityContext(facilityId, fn).`,
    );
    this.name = 'MissingTenantContextError';
    this.model = model;
    this.operation = operation;
  }
}
