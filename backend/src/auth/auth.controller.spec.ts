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
      redirect: jest.Mock;
    };

  const makeUser = (facilityId: string | null): User => ({
    id: 'user-1',
    createdAt: new Date('2026-06-18T00:00:00.000Z'),
    facilityId,
    kakaoId: 'kakao-1',
    email: null,
    nickname: '테스트 사용자',
    role: 'CAREGIVER',
    sessionVersion: 1,
  });

  const makeController = (frontOrigin?: string) => {
    const auth = {
      completeKakaoCallback: jest.fn(),
    } as unknown as jest.Mocked<AuthService>;
    const controller = new AuthController(
      auth,
      {} as SessionService,
      new ConfigService(frontOrigin ? { FRONT_ORIGIN: frontOrigin } : {}),
    );
    return { auth, controller };
  };

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

  it('redirects users with facilityId to absolute frontend dashboard URL', async () => {
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
      'https://app.example.com/dashboard',
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
});
