import type { Response } from 'express';
import { SESSION_COOKIE_NAME } from './auth.constants';

function secureCookiesEnabled(): boolean {
  const configured = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  if (process.env.NODE_ENV === 'production') return true;
  const browserOrigin = cookieSecurityOrigin();
  if (browserOrigin?.protocol === 'https:') return true;
  if (browserOrigin?.protocol === 'http:') return false;
  return false;
}

function cookieSecurityOrigin(): URL | undefined {
  const rawOrigin = process.env.FRONT_ORIGIN?.trim();
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
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}
