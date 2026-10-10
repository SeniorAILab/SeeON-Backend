import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Observable } from 'rxjs';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  FacilityContextInterceptor,
  type FacilityBoundPrismaRunner,
} from './facility-context.interceptor';

const USER_FACILITY = 'interceptor-user-facility';
const OVERRIDE_FACILITY = 'interceptor-override-facility';

type RequestFixture = {
  user?: { facilityId?: string | null };
  effectiveFacilityId?: string | null;
  withFacilityContext?: FacilityBoundPrismaRunner;
};

function setup(
  request: RequestFixture,
  result = new Promise<never>(() => undefined),
  failure?: Error,
) {
  const calls = jest.fn<void, [string, unknown]>();
  const prisma: Pick<PrismaService, 'withFacilityContext'> = {
    withFacilityContext<T>(
      facilityId: string,
      callback: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
      calls(facilityId, callback);
      if (failure !== undefined) throw failure;
      // A never-valued promise is assignable for every T; no callback or SQL is executed.
      return result;
    },
  };
  // Only withFacilityContext is used; never instantiate the concrete Prisma service.
  const interceptor = new FacilityContextInterceptor(prisma as PrismaService);
  // The interceptor reads only the HTTP request; no Nest execution host is booted.
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const subscribed = jest.fn();
  const observable = new Observable<unknown>((subscriber) => {
    subscribed();
    subscriber.next('cold-value');
    subscriber.complete();
  });
  const next = { handle: jest.fn<Observable<unknown>, []>(() => observable) };
  const callback = jest.fn<Promise<string>, [Prisma.TransactionClient]>(() =>
    Promise.resolve('unused'),
  );
  return {
    request,
    interceptor,
    context,
    next,
    observable,
    subscribed,
    calls,
    callback,
    result,
  };
}

function assignedRunner(request: RequestFixture): FacilityBoundPrismaRunner {
  const runner = request.withFacilityContext;
  if (runner === undefined)
    throw new Error('Expected assigned facility runner');
  return runner;
}

describe('FacilityContextInterceptor lazy runner, without SQL binding', () => {
  it('assigns a runner without database calls or subscription and returns the exact cold Observable', () => {
    const f = setup({ user: { facilityId: USER_FACILITY } });
    const returned = f.interceptor.intercept(f.context, f.next);
    expect(typeof f.request.withFacilityContext).toBe('function');
    expect(returned).toBe(f.observable);
    expect(f.next.handle).toHaveBeenCalledTimes(1);
    expect(f.calls).not.toHaveBeenCalled();
    expect(f.subscribed).not.toHaveBeenCalled();
    const values: unknown[] = [];
    returned.subscribe((value) => values.push(value));
    expect(values).toEqual(['cold-value']);
    expect(f.subscribed).toHaveBeenCalledTimes(1);
    expect(f.calls).not.toHaveBeenCalled();
  });

  it.each([
    { override: OVERRIDE_FACILITY, expected: OVERRIDE_FACILITY },
    { override: undefined, expected: USER_FACILITY },
    { override: null, expected: USER_FACILITY },
  ])(
    'forwards exact selected facility and callback without wrapping its promise: $override',
    ({ override, expected }) => {
      const f = setup({
        user: { facilityId: USER_FACILITY },
        effectiveFacilityId: override,
      });
      f.interceptor.intercept(f.context, f.next);
      const returned = assignedRunner(f.request)(f.callback);
      expect(f.calls).toHaveBeenCalledTimes(1);
      expect(f.calls).toHaveBeenCalledWith(expected, f.callback);
      expect(returned).toBe(f.result);
      expect(f.callback).not.toHaveBeenCalled();
    },
  );

  it('rejects an empty effective override instead of falling back to the user facility', () => {
    const f = setup({
      user: { facilityId: USER_FACILITY },
      effectiveFacilityId: '',
    });
    let caught: unknown;
    try {
      f.interceptor.intercept(f.context, f.next);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect(caught).toMatchObject({
      message: 'Facility onboarding required',
      status: 403,
    });
    expect(f.request.withFacilityContext).toBeUndefined();
    expect(f.next.handle).not.toHaveBeenCalled();
    expect(f.calls).not.toHaveBeenCalled();
  });

  it.each([undefined, '', OVERRIDE_FACILITY])(
    'requires a session before checking facility override: %p',
    (effectiveFacilityId) => {
      const f = setup({ effectiveFacilityId });
      let caught: unknown;
      try {
        f.interceptor.intercept(f.context, f.next);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnauthorizedException);
      expect(caught).toMatchObject({ message: 'Missing session', status: 401 });
      expect(f.request.withFacilityContext).toBeUndefined();
      expect(f.next.handle).not.toHaveBeenCalled();
      expect(f.calls).not.toHaveBeenCalled();
    },
  );

  it.each([null, undefined, ''])(
    'rejects missing user facility without an override: %p',
    (facilityId) => {
      const f = setup({ user: { facilityId } });
      expect(() => f.interceptor.intercept(f.context, f.next)).toThrow(
        new ForbiddenException('Facility onboarding required'),
      );
      expect(f.request.withFacilityContext).toBeUndefined();
      expect(f.next.handle).not.toHaveBeenCalled();
      expect(f.calls).not.toHaveBeenCalled();
    },
  );

  it('allows an effective facility for a session without a user facility', () => {
    const f = setup({
      user: { facilityId: null },
      effectiveFacilityId: OVERRIDE_FACILITY,
    });
    f.interceptor.intercept(f.context, f.next);
    // The fake runner hands back a never-settling promise, so there is nothing
    // to await: discard it deliberately and assert the forwarded arguments.
    void assignedRunner(f.request)(f.callback);
    expect(f.calls).toHaveBeenCalledWith(OVERRIDE_FACILITY, f.callback);
    expect(f.callback).not.toHaveBeenCalled();
  });

  it('propagates the original synchronous runner error without invoking its callback', () => {
    const failure = new Error('runner rejected synchronously');
    const f = setup(
      { user: { facilityId: USER_FACILITY } },
      undefined,
      failure,
    );
    f.interceptor.intercept(f.context, f.next);
    let caught: unknown;
    try {
      // The fake throws before any promise exists; awaiting here would turn the
      // synchronous throw into a rejection, so only discard the value that the
      // signature promises in case the call unexpectedly returns one.
      void assignedRunner(f.request)(f.callback);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(f.calls).toHaveBeenCalledWith(USER_FACILITY, f.callback);
    expect(f.callback).not.toHaveBeenCalled();
  });

  it('returns an original rejected runner promise and rejection object unchanged', async () => {
    const failure = new Error('runner promise rejected');
    const original = Promise.reject<never>(failure);
    const f = setup({ user: { facilityId: USER_FACILITY } }, original);
    f.interceptor.intercept(f.context, f.next);
    const returned = assignedRunner(f.request)(f.callback);
    expect(returned).toBe(original);
    await expect(returned).rejects.toBe(failure);
    expect(f.callback).not.toHaveBeenCalled();
  });

  it('assigns the lazy runner before next.handle throws and preserves that error', () => {
    const f = setup({ user: { facilityId: USER_FACILITY } });
    const failure = new Error('handler failed');
    f.next.handle.mockImplementation(() => {
      expect(typeof f.request.withFacilityContext).toBe('function');
      throw failure;
    });
    let caught: unknown;
    try {
      f.interceptor.intercept(f.context, f.next);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(f.calls).not.toHaveBeenCalled();
    expect(f.subscribed).not.toHaveBeenCalled();
  });
});
