import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequireFacilityGuard, type RequestWithAuth } from './jwt-auth.guard';
import { JwtStrategy, jwtCookieExtractor } from './jwt.strategy';
const SCOPED_FACILITY_ID = 'fac_happy_nokyang';


function contextFor(request: Partial<RequestWithAuth>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('JwtStrategy', () => {
  it('extracts JWT from the httpOnly auth cookie', () => {
    expect(
      jwtCookieExtractor({
        headers: { cookie: 'other=1; app_session=jwt-token' },
      } as RequestWithAuth),
    ).toBe('jwt-token');
  });

  it('loads the user and rejects sessionVersion mismatches', async () => {
    const prisma = {
      db: {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-1',
            facilityId: 'facility-1',
            role: 'ADMIN',
            email: 'admin@example.test',
            nickname: 'Admin',
            sessionVersion: 8,
          }),
        },
      },
    };
    const strategy = new JwtStrategy(
      new ConfigService({ SESSION_JWT_SECRET: 'x'.repeat(32) }),
      prisma as never,
    );

    await expect(
      strategy.validate({
        sub: 'user-1',
        role: 'ADMIN',
        facilityId: 'facility-1',
        sessionVersion: 7,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('RequireFacilityGuard', () => {
  it('uses the JWT user facility for facility-bound users', () => {
    const request = {
      headers: { 'x-facility-id': 'other-facility' },
      query: { facilityId: 'query-facility' },
      user: {
        id: 'user-1',
        email: 'admin@example.test',
        facilityId: 'session-facility',
        role: 'ADMIN',
        nickname: 'Admin',
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
      headers: { 'x-facility-id': SCOPED_FACILITY_ID },
      user: {
        id: 'user-1',
        email: '<REDACTED_NOTIFICATION_EMAIL>',
        facilityId: null,
        role: 'SUPER_ADMIN',
        nickname: 'Senior AI Lab',
        sessionVersion: 0,
      },
    } as Partial<RequestWithAuth>;

    expect(new RequireFacilityGuard().canActivate(contextFor(request))).toBe(
      true,
    );
    expect(request.effectiveFacilityId).toBe(SCOPED_FACILITY_ID);
  });

  it('allows facility-less super admins to enter a facility scope from EventSource query', () => {
    const request = {
      headers: {},
      query: { facilityId: SCOPED_FACILITY_ID },
      user: {
        id: 'user-1',
        email: '<REDACTED_NOTIFICATION_EMAIL>',
        facilityId: null,
        role: 'SUPER_ADMIN',
        nickname: 'Senior AI Lab',
        sessionVersion: 0,
      },
    } as Partial<RequestWithAuth>;

    expect(new RequireFacilityGuard().canActivate(contextFor(request))).toBe(
      true,
    );
    expect(request.effectiveFacilityId).toBe(SCOPED_FACILITY_ID);
  });

  it('rejects facility-less non-super users even when they send a facility scope header', () => {
    const request = {
      headers: { 'x-facility-id': SCOPED_FACILITY_ID },
      user: {
        id: 'user-1',
        email: 'staff@example.test',
        facilityId: null,
        role: 'STAFF',
        nickname: 'Staff',
        sessionVersion: 0,
      },
    } as Partial<RequestWithAuth>;

    expect(() =>
      new RequireFacilityGuard().canActivate(contextFor(request)),
    ).toThrow(ForbiddenException);
    expect(request.effectiveFacilityId).toBeUndefined();
  });
});
