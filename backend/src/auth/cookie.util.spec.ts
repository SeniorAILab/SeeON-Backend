import type { CookieOptions, Request, Response } from 'express';
import { SESSION_COOKIE_NAME } from './auth.constants';
import {
  buildAuthCookieOptions,
  clearSessionCookie,
  setSessionCookie,
} from './cookie.util';

type CookieCall = readonly [
  name: string,
  value: string,
  options: CookieOptions,
];
type ClearCookieCall = readonly [name: string, options: CookieOptions];

describe('auth cookie utilities', () => {
  const originalAuthCookieSecure = process.env.AUTH_COOKIE_SECURE;
  const originalAuthCookieSameSite = process.env.AUTH_COOKIE_SAME_SITE;

  const makeRequest = (secure: boolean) => ({ secure }) as Request;
  const makeResponse = () =>
    ({
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    }) as unknown as Response & {
      cookie: jest.Mock;
      clearCookie: jest.Mock;
    };

  afterEach(() => {
    if (originalAuthCookieSecure === undefined) {
      delete process.env.AUTH_COOKIE_SECURE;
    } else {
      process.env.AUTH_COOKIE_SECURE = originalAuthCookieSecure;
    }
    if (originalAuthCookieSameSite === undefined) {
      delete process.env.AUTH_COOKIE_SAME_SITE;
    } else {
      process.env.AUTH_COOKIE_SAME_SITE = originalAuthCookieSameSite;
    }
  });

  it.each([
    [true, true],
    [false, false],
  ])(
    'uses request security in auto mode: req.secure=%s',
    (secure, expected) => {
      process.env.AUTH_COOKIE_SECURE = 'auto';

      expect(buildAuthCookieOptions(makeRequest(secure)).secure).toBe(expected);
    },
  );

  it.each([
    ['true', false, true],
    ['false', true, false],
  ])(
    'pins secure=%s independently of req.secure',
    (configured, requestSecure, expected) => {
      process.env.AUTH_COOKIE_SECURE = configured;

      expect(buildAuthCookieOptions(makeRequest(requestSecure)).secure).toBe(
        expected,
      );
    },
  );

  it('uses unconditional Secure and SameSite=None for the temporary bridge', () => {
    process.env.AUTH_COOKIE_SAME_SITE = 'none';
    process.env.AUTH_COOKIE_SECURE = 'true';

    expect(buildAuthCookieOptions(makeRequest(false))).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
    });
  });

  it('uses matching strict host-only attributes for session set and clear', () => {
    process.env.AUTH_COOKIE_SECURE = 'auto';
    const request = makeRequest(true);
    const response = makeResponse();

    setSessionCookie(request, response, 'session-token', 60);
    clearSessionCookie(request, response);

    const [name, value, setOptions] = response.cookie.mock
      .calls[0] as CookieCall;
    const [clearName, clearOptions] = response.clearCookie.mock
      .calls[0] as ClearCookieCall;
    expect(name).toBe(SESSION_COOKIE_NAME);
    expect(clearName).toBe(SESSION_COOKIE_NAME);
    expect(value).toBe('session-token');
    expect(setOptions).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 60_000,
    });
    expect(clearOptions).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
    });
    expect(setOptions).not.toHaveProperty('domain');
    expect(clearOptions).not.toHaveProperty('domain');
  });

  it('rejects an invalid SameSite mode instead of guessing', () => {
    process.env.AUTH_COOKIE_SAME_SITE = 'lax';

    expect(() => buildAuthCookieOptions(makeRequest(true))).toThrow(
      'AUTH_COOKIE_SAME_SITE must be strict or none',
    );
  });

  it('rejects an invalid cookie security mode instead of guessing', () => {
    process.env.AUTH_COOKIE_SECURE = 'https';

    expect(() => buildAuthCookieOptions(makeRequest(true))).toThrow(
      'AUTH_COOKIE_SECURE must be true, false, or auto',
    );
  });
});
