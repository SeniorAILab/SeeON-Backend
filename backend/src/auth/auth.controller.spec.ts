import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import type { Response } from 'express';
import { AuthController } from './auth.controller';
import { OAUTH_STATE_COOKIE_NAME } from './auth.constants';
import type { AuthService } from './auth.service';
import type { SessionService } from './session.service';
import type { RequestWithAuth } from './session.guard';

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
    kakaoId: 'kakao-1',
    email: null,
    passwordHash: null,
    phone: null,
    nickname: '테스트 사용자',
    role,
    sessionVersion: 1,
  });

  const makeController = (frontOrigin?: string) => {
    const auth = {
      createOAuthState: jest.fn(() => 'oauth-state'),
      getKakaoAuthorizeUrl: jest.fn(
        () => 'https://kauth.kakao.com/oauth/authorize',
      ),
      completeKakaoCallback: jest.fn(),
      loginWithPassword: jest.fn(),
      registerWithPassword: jest.fn(),
    } as unknown as jest.Mocked<AuthService>;
    const controller = new AuthController(
      auth,
      {} as SessionService,
      new ConfigService(frontOrigin ? { FRONT_ORIGIN: frontOrigin } : {}),
    );
    return { auth, controller };
  };

  it('redirects back to login without setting state when Kakao OAuth is not configured', () => {
    const { auth, controller } = makeController('http://front.test/');
    auth.getKakaoAuthorizeUrl.mockImplementation(() => {
      throw new ServiceUnavailableException('KAKAO_REST_API_KEY must be real');
    });
    const response = makeResponse();

    controller.kakaoLogin(response);

    expect(auth.getKakaoAuthorizeUrl.mock.calls[0]).toEqual(['oauth-state']);
    expect(response.cookie).not.toHaveBeenCalled();
    expect(response.redirect).toHaveBeenCalledWith(
      'http://front.test/login?auth_error=kakao_unavailable',
    );
  });

  it('sets OAuth state only after building a valid Kakao authorize URL', () => {
    const { auth, controller } = makeController();
    const response = makeResponse();

    controller.kakaoLogin(response);

    expect(auth.getKakaoAuthorizeUrl.mock.calls[0]).toEqual(['oauth-state']);
    expect(response.cookie).toHaveBeenCalled();
    expect(response.redirect).toHaveBeenCalledWith(
      'https://kauth.kakao.com/oauth/authorize',
    );
  });

  it('redirects users without facilityId to absolute frontend onboarding URL', async () => {
    const { auth, controller } = makeController('http://front.test/');
    auth.completeKakaoCallback.mockResolvedValue({
      token: 'session-token',
      maxAgeSeconds: 60,
      user: makeUser(null),
    });
    const response = makeResponse();

    await controller.kakaoCallback(
      'code',
      'state',
      {
        headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=state` },
      } as RequestWithAuth,
      response,
    );

    expect(response.redirect).toHaveBeenCalledWith(
      'http://front.test/onboarding',
    );
  });

  it('redirects staff users with facilityId to the staff default URL', async () => {
    const { auth, controller } = makeController('https://app.example.com///');
    auth.completeKakaoCallback.mockResolvedValue({
      token: 'session-token',
      maxAgeSeconds: 60,
      user: makeUser('demo-facility-01'),
    });
    const response = makeResponse();

    await controller.kakaoCallback(
      'code',
      'state',
      {
        headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=state` },
      } as RequestWithAuth,
      response,
    );

    expect(response.redirect).toHaveBeenCalledWith(
      'https://app.example.com/now',
    );
  });

  it('redirects admin users with facilityId to absolute frontend dashboard URL', async () => {
    const { auth, controller } = makeController('https://app.example.com///');
    auth.completeKakaoCallback.mockResolvedValue({
      token: 'session-token',
      maxAgeSeconds: 60,
      user: makeUser('demo-facility-01', 'ADMIN'),
    });
    const response = makeResponse();

    await controller.kakaoCallback(
      'code',
      'state',
      {
        headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=state` },
      } as RequestWithAuth,
      response,
    );

    expect(response.redirect).toHaveBeenCalledWith(
      'https://app.example.com/admin/dashboard',
    );
  });

  it('redirects unlinked Kakao accounts back to login without a session cookie', async () => {
    const { auth, controller } = makeController('http://front.test/');
    auth.completeKakaoCallback.mockRejectedValue(
      new UnauthorizedException('Kakao account is not registered'),
    );
    const response = makeResponse();

    await controller.kakaoCallback(
      'code',
      'state',
      {
        headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=state` },
      } as RequestWithAuth,
      response,
    );

    expect(response.cookie).not.toHaveBeenCalled();
    expect(response.clearCookie).toHaveBeenCalled();
    expect(response.redirect).toHaveBeenCalledWith(
      'http://front.test/login?auth_error=kakao_unregistered',
    );
  });

  it('uses localhost frontend origin when FRONT_ORIGIN is unset', async () => {
    const { auth, controller } = makeController();
    auth.completeKakaoCallback.mockResolvedValue({
      token: 'session-token',
      maxAgeSeconds: 60,
      user: makeUser(null),
    });
    const response = makeResponse();

    await controller.kakaoCallback(
      'code',
      'state',
      {
        headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=state` },
      } as RequestWithAuth,
      response,
    );

    expect(response.redirect).toHaveBeenCalledWith(
      'http://localhost:3000/onboarding',
    );
  });

  it('logs in with email/password and does not expose passwordHash', async () => {
    const { auth, controller } = makeController();
    auth.loginWithPassword.mockResolvedValue({
      token: 'session-token',
      maxAgeSeconds: 60,
      user: {
        ...makeUser('demo-facility-01'),
        email: 'admin@sen.ai',
        passwordHash: 'hash',
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
        passwordHash: 'hash',
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
});
