import type { CookieOptions, Response } from 'express';
import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from './auth.constants';
import { setOAuthStateCookie, setSessionCookie } from './cookie.util';

type CookieCall = readonly [
  name: string,
  value: string,
  options: CookieOptions,
];

describe('auth cookie utilities', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAuthCookieSecure = process.env.AUTH_COOKIE_SECURE;
  const originalFrontOrigin = process.env.FRONT_ORIGIN;
  const originalKakaoRedirectUri = process.env.KAKAO_REDIRECT_URI;

  const makeResponse = () =>
    ({
      cookie: jest.fn(),
    }) as unknown as Response & { cookie: jest.Mock };

  const cookieCall = (response: { readonly cookie: jest.Mock }): CookieCall =>
    response.cookie.mock.calls[0] as CookieCall;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalAuthCookieSecure === undefined) {
      delete process.env.AUTH_COOKIE_SECURE;
    } else {
      process.env.AUTH_COOKIE_SECURE = originalAuthCookieSecure;
    }
    if (originalFrontOrigin === undefined) {
      delete process.env.FRONT_ORIGIN;
    } else {
      process.env.FRONT_ORIGIN = originalFrontOrigin;
    }
    if (originalKakaoRedirectUri === undefined) {
      delete process.env.KAKAO_REDIRECT_URI;
    } else {
      process.env.KAKAO_REDIRECT_URI = originalKakaoRedirectUri;
    }
  });

  it('marks session cookies secure for HTTPS production origins', () => {
    process.env.NODE_ENV = 'production';
    process.env.FRONT_ORIGIN = 'https://senai.example.com';
    delete process.env.AUTH_COOKIE_SECURE;
    const response = makeResponse();

    setSessionCookie(response, 'session-token', 60);

    const [name, value, options] = cookieCall(response);
    expect(name).toBe(SESSION_COOKIE_NAME);
    expect(value).toBe('session-token');
    expect(options.secure).toBe(true);
  });

  it('keeps cookies secure for HTTP production origins unless explicitly overridden', () => {
    process.env.NODE_ENV = 'production';
    process.env.FRONT_ORIGIN = 'http://<retired-host>';
    delete process.env.AUTH_COOKIE_SECURE;
    const response = makeResponse();

    setOAuthStateCookie(response, 'oauth-state', 60);

    const [, , options] = cookieCall(response);
    expect(options.secure).toBe(true);
  });

  it('allows explicit insecure cookies for HTTP-only deployment smoke tests', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_COOKIE_SECURE = 'false';
    const response = makeResponse();

    setSessionCookie(response, 'session-token', 60);

    const [, , options] = cookieCall(response);
    expect(options.secure).toBe(false);
  });

  it('uses the same secure-cookie policy for OAuth state cookies', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_COOKIE_SECURE = 'false';
    const response = makeResponse();

    setOAuthStateCookie(response, 'oauth-state', 60);

    const [name, value, options] = cookieCall(response);
    expect(name).toBe(OAUTH_STATE_COOKIE_NAME);
    expect(value).toBe('oauth-state');
    expect(options.secure).toBe(false);
    expect(options.path).toBe('/api/v1/auth');
  });
});
