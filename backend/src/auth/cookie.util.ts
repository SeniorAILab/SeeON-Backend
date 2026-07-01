import type { Response } from 'express';
import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from './auth.constants';

function secureCookiesEnabled(): boolean {
  const configured = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  const browserOrigin = cookieSecurityOrigin();
  if (browserOrigin?.protocol === 'https:') return true;
  if (browserOrigin?.protocol === 'http:') return false;
  return process.env.NODE_ENV === 'production';
}

function cookieSecurityOrigin(): URL | undefined {
  const rawOrigin =
    process.env.FRONT_ORIGIN?.trim() ?? process.env.KAKAO_REDIRECT_URI?.trim();
  if (!rawOrigin) return undefined;
  try {
    return new URL(rawOrigin);
  } catch {
    return undefined;
  }
}

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
    secure: secureCookiesEnabled(),
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
    secure: secureCookiesEnabled(),
    sameSite: 'lax',
    path: '/api/v1/auth',
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearOAuthStateCookie(response: Response): void {
  response.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/api/v1/auth' });
}
