import type { CookieOptions, Response } from 'express';
import { SESSION_COOKIE_NAME } from './auth.constants';
import { setSessionCookie } from './cookie.util';

type CookieCall = readonly [
  name: string,
  value: string,
  options: CookieOptions,
];

describe('auth cookie utilities', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAuthCookieSecure = process.env.AUTH_COOKIE_SECURE;
  const originalFrontOrigin = process.env.FRONT_ORIGIN;

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
    process.env.FRONT_ORIGIN = 'http://192.0.2.10';
    delete process.env.AUTH_COOKIE_SECURE;
    const response = makeResponse();

    setSessionCookie(response, 'session-token', 60);

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
});
