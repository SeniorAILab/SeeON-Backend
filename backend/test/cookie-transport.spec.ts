import {
  Controller,
  Post,
  Req,
  Res,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  clearSessionCookie,
  setSessionCookie,
} from '../src/auth/cookie.util.js';
import { configureTrustedIngressProxy } from '../src/config/trusted-ingress-proxy.js';

@Controller()
class CookieProbeController {
  @Post('session')
  set(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    setSessionCookie(req, res, 'opaque-token', 60);
    return { secure: req.secure };
  }

  @Post('session/clear')
  clear(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    clearSessionCookie(req, res);
    return { secure: req.secure };
  }
}

describe('request-aware cookie transport (e2e)', () => {
  const originalMode = process.env.AUTH_COOKIE_SECURE;

  afterEach(() => {
    if (originalMode === undefined) delete process.env.AUTH_COOKIE_SECURE;
    else process.env.AUTH_COOKIE_SECURE = originalMode;
  });

  it('sets Secure in auto mode for a request from a trusted HTTPS ingress', async () => {
    process.env.AUTH_COOKIE_SECURE = 'auto';
    const app = await makeApp('loopback');
    try {
      const response = await request(app.getHttpServer())
        .post('/session')
        .set('x-forwarded-proto', 'https')
        .expect(201, { secure: true });

      expect(sessionCookie(response.headers['set-cookie'])).toContain(
        '; Secure;',
      );
    } finally {
      await app.close();
    }
  });

  it('keeps legacy HTTP non-Secure in auto mode', async () => {
    process.env.AUTH_COOKIE_SECURE = 'auto';
    const app = await makeApp('loopback');
    try {
      const response = await request(app.getHttpServer())
        .post('/session')
        .set('x-forwarded-proto', 'http')
        .expect(201, { secure: false });

      expect(sessionCookie(response.headers['set-cookie'])).not.toContain(
        '; Secure;',
      );
    } finally {
      await app.close();
    }
  });

  it('ignores spoofed forwarded proto from an untrusted direct client', async () => {
    process.env.AUTH_COOKIE_SECURE = 'auto';
    const app = await makeApp();
    try {
      const response = await request(app.getHttpServer())
        .post('/session')
        .set('x-forwarded-proto', 'https')
        .expect(201, { secure: false });

      expect(sessionCookie(response.headers['set-cookie'])).not.toContain(
        '; Secure;',
      );
    } finally {
      await app.close();
    }
  });

  it('pins Secure in true mode and mirrors literal attributes on clear', async () => {
    process.env.AUTH_COOKIE_SECURE = 'true';
    const app = await makeApp();
    try {
      const setResponse = await request(app.getHttpServer())
        .post('/session')
        .expect(201);
      const clearResponse = await request(app.getHttpServer())
        .post('/session/clear')
        .expect(201);
      const setCookie = sessionCookie(setResponse.headers['set-cookie']);
      const clearCookie = sessionCookie(clearResponse.headers['set-cookie']);

      for (const attribute of [
        'Path=/',
        'HttpOnly',
        'Secure',
        'SameSite=Strict',
      ]) {
        expect(setCookie).toContain(attribute);
        expect(clearCookie).toContain(attribute);
      }
      expect(setCookie).not.toContain('Domain=');
      expect(clearCookie).not.toContain('Domain=');
      expect(clearCookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    } finally {
      await app.close();
    }
  });
});

async function makeApp(trustedProxy?: string): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    controllers: [CookieProbeController],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureTrustedIngressProxy(app, trustedProxy);
  await app.init();
  return app;
}

function sessionCookie(setCookie: string[] | string | undefined): string {
  const values = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  const cookie = values.find((value) => value.startsWith('app_session='));
  if (cookie === undefined) throw new Error('app_session cookie missing');
  return cookie;
}
