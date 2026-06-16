import type { Response } from 'express';
import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from './auth.constants';

export function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const chunk of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = chunk.trim().split('=');
    if (rawKey === name) return decodeURIComponent(rawValue.join('='));
  }
  return undefined;
}

export function setSessionCookie(
  response: Response,
  token: string,
  maxAgeSeconds: number,
): void {
  response.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

export function setOAuthStateCookie(
  response: Response,
  state: string,
  maxAgeSeconds: number,
): void {
  response.cookie(OAUTH_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/auth',
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearOAuthStateCookie(response: Response): void {
  response.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/auth' });
}
