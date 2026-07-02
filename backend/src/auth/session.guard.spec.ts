import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { RequireFacilityGuard, type RequestWithAuth } from './session.guard';

function contextFor(request: Partial<RequestWithAuth>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('RequireFacilityGuard', () => {
  it('uses the session facility for facility-bound users', () => {
    const request = {
      headers: { 'x-facility-id': 'other-facility' },
      query: { facilityId: 'query-facility' },
      user: {
        id: 'user-1',
        email: 'admin@example.test',
        facilityId: 'session-facility',
        role: 'ADMIN',
        nickname: 'Admin',
        kakaoId: null,
        sessionVersion: 0,
      },
    } as Partial<RequestWithAuth>;

    expect(new RequireFacilityGuard().canActivate(contextFor(request))).toBe(
      true,
    );
    expect(request.effectiveFacilityId).toBe('session-facility');
  });

  it('allows facility-less super admins to enter an explicitly selected facility scope', () => {
    const request = {
      headers: { 'x-facility-id': 'fac_happy_nokyang' },
      user: {
        id: 'user-1',
        email: '<REDACTED_NOTIFICATION_EMAIL>',
        facilityId: null,
        role: 'SUPER_ADMIN',
        nickname: 'Senior AI Lab',
        kakaoId: null,
        sessionVersion: 0,
      },
    } as Partial<RequestWithAuth>;

    expect(new RequireFacilityGuard().canActivate(contextFor(request))).toBe(
      true,
    );
    expect(request.effectiveFacilityId).toBe('fac_happy_nokyang');
  });

  it('allows facility-less super admins to enter a facility scope from EventSource query', () => {
    const request = {
      headers: {},
      query: { facilityId: 'fac_happy_nokyang' },
      user: {
        id: 'user-1',
        email: '<REDACTED_NOTIFICATION_EMAIL>',
        facilityId: null,
        role: 'SUPER_ADMIN',
        nickname: 'Senior AI Lab',
        kakaoId: null,
        sessionVersion: 0,
      },
    } as Partial<RequestWithAuth>;

    expect(new RequireFacilityGuard().canActivate(contextFor(request))).toBe(
      true,
    );
    expect(request.effectiveFacilityId).toBe('fac_happy_nokyang');
  });

  it('rejects facility-less non-super users even when they send a facility scope header', () => {
    const request = {
      headers: { 'x-facility-id': 'fac_happy_nokyang' },
      user: {
        id: 'user-1',
        email: 'staff@example.test',
        facilityId: null,
        role: 'STAFF',
        nickname: 'Staff',
        kakaoId: null,
        sessionVersion: 0,
      },
    } as Partial<RequestWithAuth>;

    expect(() =>
      new RequireFacilityGuard().canActivate(contextFor(request)),
    ).toThrow(ForbiddenException);
    expect(request.effectiveFacilityId).toBeUndefined();
  });
});
