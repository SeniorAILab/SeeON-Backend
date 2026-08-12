import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { CsrfOriginGuard } from './csrf-origin.guard.js';

function context(
  method: string,
  headers: Record<string, unknown>,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

describe('CsrfOriginGuard', () => {
  const origin = 'https://seeon-front.vercel.app';
  const config = {
    get: jest.fn(
      (key: string) =>
        (
          ({ NODE_ENV: 'production', FRONT_ORIGINS: origin }) as Record<
            string,
            string
          >
        )[key],
    ),
  } as unknown as ConfigService;
  const guard = new CsrfOriginGuard(new Reflector(), config);

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'allows safe %s requests without origin headers',
    (method) => {
      expect(guard.canActivate(context(method, {}))).toBe(true);
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'accepts exact Origin for %s',
    (method) => {
      expect(guard.canActivate(context(method, { origin }))).toBe(true);
    },
  );

  it('accepts an exact-origin Referer only when Origin is absent', () => {
    expect(
      guard.canActivate(
        context('POST', { referer: `${origin}/dashboard?view=alerts` }),
      ),
    ).toBe(true);
  });

  it.each([
    {},
    { origin: 'null' },
    { origin: `${origin}.evil.example` },
    { origin: ` ${origin}` },
    { origin: `${origin},${origin}` },
    { origin: 'https://evil.example', referer: `${origin}/dashboard` },
    { referer: 'https://evil.example/dashboard' },
  ])('rejects hostile or missing unsafe-request provenance %#', (headers) => {
    try {
      guard.canActivate(context('POST', headers));
      throw new Error('unsafe request unexpectedly passed');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      if (!(error instanceof ForbiddenException)) throw error;
      expect(error.getResponse()).toMatchObject({
        code: 'CSRF_ORIGIN_REJECTED',
      });
    }
  });
});
