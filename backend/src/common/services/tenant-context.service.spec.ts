import { TenantContext } from './tenant-context.service.js';

const FACILITY_A = 'context-facility-a';
const FACILITY_B = 'context-facility-b';

function barrier() {
  let release: () => void = () => {
    throw new Error('Barrier not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('TenantContext local async scope (not database binding)', () => {
  it('does not grant bound scope to request identity, even across an await', async () => {
    expect(TenantContext.getBoundFacilityId()).toBeUndefined();
    const gate = barrier();
    const action = TenantContext.run(FACILITY_A, async () => {
      expect(TenantContext.getBoundFacilityId()).toBeUndefined();
      await gate.promise;
      expect(TenantContext.getBoundFacilityId()).toBeUndefined();
    });
    expect(TenantContext.getBoundFacilityId()).toBeUndefined();
    gate.release();
    await action;
    expect(TenantContext.getBoundFacilityId()).toBeUndefined();
  });

  it('restores a bound outer scope after nested bound and unbound callbacks', () => {
    TenantContext.runBound(FACILITY_A, () => {
      expect(TenantContext.getBoundFacilityId()).toBe(FACILITY_A);
      TenantContext.run(FACILITY_B, () => {
        expect(TenantContext.getBoundFacilityId()).toBeUndefined();
        TenantContext.runBound(FACILITY_B, () => {
          expect(TenantContext.getBoundFacilityId()).toBe(FACILITY_B);
        });
        expect(TenantContext.getBoundFacilityId()).toBeUndefined();
      });
      expect(TenantContext.getBoundFacilityId()).toBe(FACILITY_A);
    });
    expect(TenantContext.getBoundFacilityId()).toBeUndefined();
  });

  it('isolates concurrent bound scopes and restores the parent after nested awaits', async () => {
    const first = barrier();
    const second = barrier();
    const a = TenantContext.runBound(FACILITY_A, async () => {
      expect(TenantContext.getBoundFacilityId()).toBe(FACILITY_A);
      await first.promise;
      expect(TenantContext.getBoundFacilityId()).toBe(FACILITY_A);
      await TenantContext.runBound(FACILITY_B, async () => {
        await second.promise;
        expect(TenantContext.getBoundFacilityId()).toBe(FACILITY_B);
      });
      expect(TenantContext.getBoundFacilityId()).toBe(FACILITY_A);
    });
    const b = TenantContext.runBound(FACILITY_B, async () => {
      expect(TenantContext.getBoundFacilityId()).toBe(FACILITY_B);
      first.release();
      await second.promise;
      expect(TenantContext.getBoundFacilityId()).toBe(FACILITY_B);
    });
    expect(TenantContext.getBoundFacilityId()).toBeUndefined();
    second.release();
    await Promise.all([a, b]);
    expect(TenantContext.getBoundFacilityId()).toBeUndefined();
  });

  it.each(['run', 'runBound'] as const)(
    '%s returns callback objects and promises unchanged',
    async (method) => {
      const object = { marker: 'original' };
      let calls = 0;
      expect(
        TenantContext[method](FACILITY_A, () => {
          calls += 1;
          return object;
        }),
      ).toBe(object);
      expect(calls).toBe(1);
      const promise = Promise.resolve(object);
      const returned = TenantContext[method](FACILITY_A, () => promise);
      expect(returned).toBe(promise);
      await expect(returned).resolves.toBe(object);
      expect(TenantContext.getBoundFacilityId()).toBeUndefined();
    },
  );

  it.each(['run', 'runBound'] as const)(
    '%s preserves synchronous exceptions and restores the enclosing scope',
    (method) => {
      const failure = new Error('callback failed');
      TenantContext.runBound(FACILITY_A, () => {
        let caught: unknown;
        try {
          TenantContext[method](FACILITY_B, () => {
            throw failure;
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(failure);
        expect(TenantContext.getBoundFacilityId()).toBe(FACILITY_A);
      });
      expect(TenantContext.getBoundFacilityId()).toBeUndefined();
    },
  );

  it.each(['run', 'runBound'] as const)(
    '%s preserves rejected promises and restores enclosing async scope',
    async (method) => {
      const failure = new Error('async callback failed');
      await TenantContext.runBound(FACILITY_A, async () => {
        const rejected = Promise.reject(failure);
        const returned = TenantContext[method](FACILITY_B, () => rejected);
        expect(returned).toBe(rejected);
        expect(TenantContext.getBoundFacilityId()).toBe(FACILITY_A);
        await expect(returned).rejects.toBe(failure);
        expect(TenantContext.getBoundFacilityId()).toBe(FACILITY_A);
      });
      expect(TenantContext.getBoundFacilityId()).toBeUndefined();
    },
  );
});
