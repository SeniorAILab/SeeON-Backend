import type { User } from '@prisma/client';
import type { Response } from 'express';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { RequestWithAuth } from './jwt-auth.guard';

describe('AuthController', () => {
  const makeResponse = () =>
    ({
      cookie: jest.fn(),
      clearCookie: jest.fn(),
      redirect: jest.fn(),
    }) as unknown as Response & {
      cookie: jest.Mock;
      clearCookie: jest.Mock;
      redirect: jest.Mock;
    };

  const makeUser = (
    facilityId: string | null,
    role: User['role'] = 'STAFF',
  ): User => ({
    id: 'user-1',
    createdAt: new Date('2026-06-18T00:00:00.000Z'),
    facilityId,
    email: null,
    passwordHash: null,
    phone: null,
    notificationEmail: null,
    emailAlertsEnabled: true,
    nickname: '테스트 사용자',
    role,
    sessionVersion: 1,
  });

  const makeController = () => {
    const loginWithPassword = jest.fn<
      ReturnType<AuthService['loginWithPassword']>,
      Parameters<AuthService['loginWithPassword']>
    >();
    const registerWithPassword = jest.fn<
      ReturnType<AuthService['registerWithPassword']>,
      Parameters<AuthService['registerWithPassword']>
    >();
    const revokeAllSessions = jest.fn<
      ReturnType<AuthService['revokeAllSessions']>,
      Parameters<AuthService['revokeAllSessions']>
    >();
    const createFacilityForUser = jest.fn<
      ReturnType<AuthService['createFacilityForUser']>,
      Parameters<AuthService['createFacilityForUser']>
    >();
    const auth = {
      loginWithPassword,
      registerWithPassword,
      revokeAllSessions,
      createFacilityForUser,
    } as unknown as jest.Mocked<AuthService>;
    const controller = new AuthController(auth);
    return { auth, controller, revokeAllSessions, createFacilityForUser };
  };

  it('returns /auth/me identity without legacy session fields', () => {
    const { controller } = makeController();

    const body = controller.me({
      user: {
        id: 'user-1',
        facilityId: 'facility-1',
        role: 'ADMIN',
        email: 'admin@example.test',
        nickname: 'Admin',
        sessionVersion: 3,
      },
    } as RequestWithAuth);

    expect(body).toEqual({
      id: 'user-1',
      role: 'ADMIN',
      facilityId: 'facility-1',
      email: 'admin@example.test',
      nickname: 'Admin',
    });
  });

  it('logs out by bumping sessionVersion and clearing the auth cookie', async () => {
    const { controller, revokeAllSessions } = makeController();
    const response = makeResponse();

    await controller.logout(
      { user: { id: 'user-1' } } as RequestWithAuth,
      response,
    );

    expect(revokeAllSessions).toHaveBeenCalledWith('user-1');
    expect(response.clearCookie).toHaveBeenCalled();
  });

  it('logs in with email/password and does not expose passwordHash', async () => {
    const { auth, controller } = makeController();
    auth.loginWithPassword.mockResolvedValue({
      token: 'session-token',
      maxAgeSeconds: 60,
      user: {
        ...makeUser('demo-facility-01'),
        email: 'admin@sen.ai',
      },
    });
    const response = makeResponse();

    const body = await controller.login(
      { email: 'admin@sen.ai', password: '1234' },
      response,
    );

    expect(auth.loginWithPassword.mock.calls[0]).toEqual([
      'admin@sen.ai',
      '1234',
    ]);
    expect(response.cookie).toHaveBeenCalled();
    expect('passwordHash' in body.user).toBe(false);
    expect(body.user).toEqual(
      expect.objectContaining({
        email: 'admin@sen.ai',
        facilityId: 'demo-facility-01',
      }),
    );
  });

  it('registers with password, sets session cookie, and does not expose passwordHash', async () => {
    const { auth, controller } = makeController();
    auth.registerWithPassword.mockResolvedValue({
      token: 'session-token',
      maxAgeSeconds: 60,
      user: {
        ...makeUser('facility-1'),
        email: 'owner@example.test',
        nickname: '홍원장',
      },
    });
    const response = makeResponse();

    const body = await controller.register(
      {
        name: '홍원장',
        email: 'owner@example.test',
        password: 'Passw0rd!234',
        phone: '010-1111-2222',
        facilityName: 'ULW 요양원',
      },
      response,
    );

    expect(auth.registerWithPassword.mock.calls[0]).toEqual([
      {
        name: '홍원장',
        email: 'owner@example.test',
        password: 'Passw0rd!234',
        phone: '010-1111-2222',
        facilityName: 'ULW 요양원',
      },
    ]);
    expect(response.cookie).toHaveBeenCalled();
    expect('passwordHash' in body.user).toBe(false);
    expect(body.user).toEqual(
      expect.objectContaining({
        email: 'owner@example.test',
        nickname: '홍원장',
        facilityId: 'facility-1',
      }),
    );
  });

  it('creates a facility for the authenticated user and sets a session cookie', async () => {
    const { controller, createFacilityForUser } = makeController();
    createFacilityForUser.mockResolvedValue({
      token: 'session-token',
      maxAgeSeconds: 60,
      user: { ...makeUser('facility-2', 'ADMIN'), email: 'admin@sen.ai' },
    });
    const response = makeResponse();

    const body = await controller.createFacility(
      { facilityName: 'New Facility' },
      { user: { id: 'user-1' } } as RequestWithAuth,
      response,
    );

    expect(createFacilityForUser).toHaveBeenCalledWith(
      'user-1',
      'New Facility',
    );
    expect(response.cookie).toHaveBeenCalled();
    expect(body.user).toEqual(
      expect.objectContaining({ facilityId: 'facility-2', role: 'ADMIN' }),
    );
  });
});
