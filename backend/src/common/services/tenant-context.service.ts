import { AsyncLocalStorage } from 'node:async_hooks';

interface TenantStore {
  readonly facilityId: string;
  /** True only after PrismaService has opened a SET LOCAL-bound transaction. */
  readonly transactionBound: boolean;
}

const _storage = new AsyncLocalStorage<TenantStore>();

/**
 * Request-scoped facility context carrier (AsyncLocalStorage).
 *
 * `run()` is for request identity only and is intentionally insufficient for
 * tenant Prisma model access. The Prisma guard accepts only `runBound()` scopes,
 * which are created by PrismaService.withFacilityContext() after it opens the
 * interactive transaction that binds set_config('app.facility_id', facilityId, true).
 */
export const TenantContext = {
  /** Execute fn with an unbound request facility context. Not enough for DB access. */
  run<T>(facilityId: string, fn: () => T): T {
    return _storage.run({ facilityId, transactionBound: false }, fn);
  },

  /** Execute fn with a facility context proven to be inside a set_config-bound transaction. */
  runBound<T>(facilityId: string, fn: () => T): T {
    return _storage.run({ facilityId, transactionBound: true }, fn);
  },

  /** Returns facilityId only when the current context is transaction-bound. */
  getBoundFacilityId(): string | undefined {
    const store = _storage.getStore();
    return store?.transactionBound ? store.facilityId : undefined;
  },
} as const;
