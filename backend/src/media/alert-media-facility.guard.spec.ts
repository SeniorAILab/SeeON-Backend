import type { ExecutionContext } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import type { RequestWithAuth } from '../auth/jwt-auth.guard.js';
import {
  AlertMediaFacilityGuard,
  MEDIA_FACILITY_COOKIE_NAME,
} from './alert-media-facility.guard.js';

describe('AlertMediaFacilityGuard cookie policy', () => {
  const originalMode = process.env.AUTH_COOKIE_SECURE;

  afterEach(() => {
    if (originalMode === undefined) delete process.env.AUTH_COOKIE_SECURE;
    else process.env.AUTH_COOKIE_SECURE = originalMode;
  });

  it('uses the shared strict request-aware policy for the media facility cookie', () => {
    process.env.AUTH_COOKIE_SECURE = 'auto';
    const request = {
      secure: true,
      headers: { 'x-facility-id': 'facility-selected' },
      user: {
        id: 'super-admin',
        facilityId: null,
        role: 'SUPER_ADMIN',
        email: 'admin@example.test',
        nickname: 'Admin',
        sessionVersion: 1,
      },
    } as unknown as RequestWithAuth;
    const response = { cookie: jest.fn() } as unknown as Response & {
      cookie: jest.Mock;
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as ExecutionContext;

    expect(new AlertMediaFacilityGuard().canActivate(context)).toBe(true);
    expect(request.effectiveFacilityId).toBe('facility-selected');
    const [name, value, options] = response.cookie.mock.calls[0] as [
      string,
      string,
      CookieOptions,
    ];
    expect(name).toBe(MEDIA_FACILITY_COOKIE_NAME);
    expect(value).toBe('facility-selected');
    expect(options).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 5 * 60 * 1_000,
    });
    expect(options).not.toHaveProperty('domain');
  });
});
