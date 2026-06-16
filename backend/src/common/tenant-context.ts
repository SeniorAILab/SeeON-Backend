import { AsyncLocalStorage } from 'node:async_hooks';

interface TenantStore {
  readonly orgId: string;
  /** True only after PrismaService has opened a SET LOCAL-bound transaction. */
  readonly transactionBound: boolean;
}

const _storage = new AsyncLocalStorage<TenantStore>();

/**
 * Request-scoped org context carrier (AsyncLocalStorage).
 *
 * `run()` is for request identity only and is intentionally insufficient for
 * tenant Prisma model access. The Prisma guard accepts only `runBound()` scopes,
 * which are created by PrismaService.withOrgContext() after it opens the
 * interactive transaction that binds set_config('app.org_id', orgId, true).
 */
export const TenantContext = {
  /** Execute fn with an unbound request org context. Not enough for DB access. */
  run<T>(orgId: string, fn: () => T): T {
    return _storage.run({ orgId, transactionBound: false }, fn);
  },

  /** Execute fn with an org context proven to be inside a set_config-bound transaction. */
  runBound<T>(orgId: string, fn: () => T): T {
    return _storage.run({ orgId, transactionBound: true }, fn);
  },

  /** Returns orgId only when the current context is transaction-bound. */
  getBoundOrgId(): string | undefined {
    const store = _storage.getStore();
    return store?.transactionBound ? store.orgId : undefined;
  },
} as const;
