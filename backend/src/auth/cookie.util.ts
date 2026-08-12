import type { CookieOptions, Request, Response } from 'express';
import { SESSION_COOKIE_NAME } from './auth.constants';

type CookieSecurityMode = 'true' | 'false' | 'auto';

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

export function buildAuthCookieOptions(
  request: Request,
  maxAgeMilliseconds?: number,
): CookieOptions {
  const options: CookieOptions = {
    httpOnly: true,
    secure: secureCookiesEnabled(request),
    sameSite: 'strict',
    path: '/',
  };
  if (maxAgeMilliseconds !== undefined) {
    options.maxAge = maxAgeMilliseconds;
  }
  return options;
}

export function setSessionCookie(
  request: Request,
  response: Response,
  token: string,
  maxAgeSeconds: number,
): void {
  response.cookie(
    SESSION_COOKIE_NAME,
    token,
    buildAuthCookieOptions(request, maxAgeSeconds * 1000),
  );
}

export function clearSessionCookie(request: Request, response: Response): void {
  response.clearCookie(SESSION_COOKIE_NAME, buildAuthCookieOptions(request));
}

function secureCookiesEnabled(request: Request): boolean {
  const mode = cookieSecurityMode();
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  return request.secure;
}

function cookieSecurityMode(): CookieSecurityMode {
  const configured = process.env.AUTH_COOKIE_SECURE?.trim();
  if (configured === undefined || configured.length === 0) {
    return process.env.NODE_ENV === 'production' ? 'true' : 'auto';
  }
  if (
    configured === 'true' ||
    configured === 'false' ||
    configured === 'auto'
  ) {
    return configured;
  }
  throw new Error('AUTH_COOKIE_SECURE must be true, false, or auto');
}
