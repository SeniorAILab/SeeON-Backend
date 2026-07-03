import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { MissingTenantContextError } from '../common/errors.js';
import { TenantContext } from '../common/tenant-context.js';

// ─── Tenant model set ─────────────────────────────────────────────────────────
// These tables carry RLS ENABLE + FORCE. All access must go through
// withFacilityContext(). Direct calls on db.* without a TenantContext store throw
// MissingTenantContextError before the query reaches the DB (NR1/NR2).
//
// KakaoIdentity is intentionally EXCLUDED: Kakao login/onboarding happens before
// a facility context exists (facilityId may be NULL). RLS default-deny would block those
// rows. KakaoIdentity is gated at the app layer, like User.
const TENANT_MODELS = new Set([
  'Camera',
  'Alert',
  'AlertNote',
  'Event',
  'Floor',
  'Space',
]);

// ─── PrismaService ────────────────────────────────────────────────────────────

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  /**
   * Guarded Prisma client with $allOperations extension (NR4 — $allOperations,
   * NOT the deprecated $use middleware).
   *
   * Guard behaviour:
   *   - Tenant model operation with no TenantContext store
   *     → throws MissingTenantContextError before the DB is touched.
   *   - Tenant model operation inside withFacilityContext()
   *     → TenantContext has facilityId → guard passes, RLS enforces per-facility rows.
   *   - Non-tenant model operations
   *     → pass through unconditionally.
   *
   * db.$transaction() is used by withFacilityContext() to open the facility-bound
   * interactive transaction that runs SET LOCAL "app.facility_id".
   */
  // The cast is necessary: $extends returns DynamicClientExtensionThis<…>
  // which is structurally identical to PrismaClient for all call-sites but has
  // a different generic identity. The extension adds no new methods; behaviour
  // is preserved.
  readonly db: PrismaClient;

  private readonly _prisma: PrismaClient;

  constructor() {
    this._prisma = new PrismaClient();
    this.db = this._prisma.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (
              TENANT_MODELS.has(model) &&
              !TenantContext.getBoundFacilityId()
            ) {
              throw new MissingTenantContextError(model, operation);
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
  }

  async onModuleInit() {
    await this._prisma.$connect();
  }

  async onModuleDestroy() {
    await this._prisma.$disconnect();
  }

  // ── Delegated base-client methods (used by tests and bootstrap code) ──────

  /** Connect the underlying client. Called by NestJS lifecycle, and tests. */
  async $connect() {
    return this._prisma.$connect();
  }

  /** Disconnect the underlying client. Called by NestJS lifecycle, and tests. */
  async $disconnect() {
    return this._prisma.$disconnect();
  }

  /**
   * Execute a raw SQL query on the app-role connection (DATABASE_URL =
   * fall_app, NOSUPERUSER NOBYPASSRLS). Without a facility context / GUC, RLS
   * denies all tenant rows — useful for testing un-scoped denial (NR1).
   *
   * For scoped raw queries use $queryRaw on the tx inside withFacilityContext (NR2).
   */
  get $queryRaw(): PrismaClient['$queryRaw'] {
    return this._prisma.$queryRaw.bind(this._prisma);
  }

  // ── Tenant-scoped transaction (NR2) ───────────────────────────────────────

  /**
   * Execute fn inside a facility-bound interactive transaction.
   *
   * Sequence:
   *   1. Validate facilityId is non-empty (fail-closed).
   *   2. Run TenantContext.runBound(facilityId) so the $allOperations guard accepts
   *      tenant model access only inside this transaction-bound scope.
   *   3. Open an interactive $transaction on db (extended client, so the tx
   *      also has the guard applied).
   *   4. SET LOCAL "app.facility_id" on the transaction's connection. Postgres RLS
   *      policies on all tenant tables see this GUC and restrict to facility rows.
   *   5. Call fn(tx). All model ops AND raw $queryRaw on tx use the same
   *      pinned connection, so SET LOCAL applies to all (NR2).
   *
   * Connection-pin note: one connection is held for the duration of fn.
   * Keep fn short-lived. Timeout: ~5 s (NR2).
   *
   * @throws MissingTenantContextError            if facilityId is falsy
   * @throws Prisma.PrismaClientKnownRequestError  on FK / unique violations
   */
  async withFacilityContext<T>(
    facilityId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!facilityId) {
      throw new MissingTenantContextError('*', 'withFacilityContext');
    }

    return TenantContext.runBound(facilityId, () =>
      this.db.$transaction(
        async (tx) => {
          // Bind the GUC on this connection.
          // set_config('app.facility_id', facilityId, true) — third arg is_local=true:
          // the GUC is scoped to the current TRANSACTION only. It reverts
          // automatically on commit/rollback. Never use session-scoped SET
          // (is_local=false): that leaks GUC across connection-pool reuse.
          await tx.$executeRaw`SELECT set_config('app.facility_id', ${facilityId}, true)`;
          return fn(tx);
        },
        { timeout: 5_000 }, // ~5 s connection-pin limit (NR2)
      ),
    );
  }
}
