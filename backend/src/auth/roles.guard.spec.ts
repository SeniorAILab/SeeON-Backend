import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RequireCapability, RolesGuard } from './roles.guard';
import type { RequestWithAuth } from './jwt-auth.guard';

describe('RolesGuard', () => {
  const guardedHandler = () => undefined;
  const openHandler = () => undefined;
  class GuardedController {}

  Reflect.decorate(
    [RequireCapability('facilityAdmin')],
    GuardedController.prototype,
    'guardedHandler',
    Object.getOwnPropertyDescriptor({ guardedHandler }, 'guardedHandler'),
  );

  function context(
    request: { user?: RequestWithAuth['user'] },
    handler: () => undefined = guardedHandler,
  ) {
    return {
      getHandler: () => handler,
      getClass: () => GuardedController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;
  }

  function guard() {
    return new RolesGuard(new Reflector());
  }

  it('allows ADMIN and SUPER_ADMIN to use facilityAdmin routes', () => {
    for (const role of [Role.ADMIN, Role.SUPER_ADMIN]) {
      expect(
        guard().canActivate(
          context({
            user: {
              id: `user-${role}`,
              facilityId: role === Role.ADMIN ? 'fac-1' : null,
              role,
              kakaoId: null,
              email: null,
              nickname: role,
              sessionVersion: 0,
            },
          }),
        ),
      ).toBe(true);
    }
  });

  it('denies STAFF on facilityAdmin routes with 403', () => {
    expect(() =>
      guard().canActivate(
        context({
          user: {
            id: 'staff-1',
            facilityId: 'fac-1',
            role: Role.STAFF,
            kakaoId: null,
            email: 'staff@example.test',
            nickname: 'Staff',
            sessionVersion: 0,
          },
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('requires JwtAuthGuard to populate request.user before capability checks', () => {
    expect(() => guard().canActivate(context({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('allows routes without required capability metadata', () => {
    expect(guard().canActivate(context({}, openHandler))).toBe(true);
  });
});
