import { ConfigService } from '@nestjs/config';
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

  it('redirects users without orgId to absolute frontend onboarding URL', async () => {
    const { auth, controller } = makeController('http://front.test/');
    auth.completeKakaoCallback.mockResolvedValue({
      token: 'session-token',
      maxAgeSeconds: 60,
      user: { orgId: null },
    } as Awaited<ReturnType<AuthService['completeKakaoCallback']>>);
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

  it('redirects users with orgId to absolute frontend dashboard URL', async () => {
    const { auth, controller } = makeController('https://app.example.com///');
    auth.completeKakaoCallback.mockResolvedValue({
      token: 'session-token',
      maxAgeSeconds: 60,
      user: { orgId: 'demo-org-01' },
    } as Awaited<ReturnType<AuthService['completeKakaoCallback']>>);
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
      user: { orgId: null },
    } as Awaited<ReturnType<AuthService['completeKakaoCallback']>>);
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
