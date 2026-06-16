/**
 * Thrown when a Prisma tenant model operation is attempted without an active
 * org context in TenantContext (AsyncLocalStorage).
 *
 * Belt-and-suspenders: RLS is the DB-level authority; this error surfaces
 * misuse at the application layer before the query reaches the DB.
 */
export class MissingTenantContextError extends Error {
  readonly model: string;
  readonly operation: string;

  constructor(model: string, operation: string) {
    super(
      `Tenant model "${model}.${operation}" invoked without an org context. ` +
        `Wrap all tenant model access in PrismaService.withOrgContext(orgId, fn).`,
    );
    this.name = 'MissingTenantContextError';
    this.model = model;
    this.operation = operation;
  }
}
