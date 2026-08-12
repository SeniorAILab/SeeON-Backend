import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setSessionCookie } from '../src/auth/cookie.util';
import { configureVersionedTestApp } from './helpers/versioned-app';

const TEST_SECRET = 'test-session-secret-minimum-32-characters';
const ORIGINAL_AUTH_COOKIE_SECURE = process.env.AUTH_COOKIE_SECURE;

type AuthResponseBody = {
  user: {
    id: string;
    email?: string;
    sessionVersion?: number;
    facilityId: string | null;
    role?: string;
  };
};

describe('auth cookie attributes', () => {
  it('sets bounded production cookie attributes for the session cookie', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalFrontOrigin = process.env.FRONT_ORIGIN;
    const originalAuthCookieSecure = process.env.AUTH_COOKIE_SECURE;
    process.env.NODE_ENV = 'production';
    process.env.FRONT_ORIGIN = 'http://senai.example.com';
    delete process.env.AUTH_COOKIE_SECURE;
    const sessionCookie = jest.fn();
    try {
      setSessionCookie(
        { secure: false } as Request,
        { cookie: sessionCookie } as unknown as Parameters<
          typeof setSessionCookie
        >[1],
        'session-token',
        123,
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalFrontOrigin === undefined) delete process.env.FRONT_ORIGIN;
      else process.env.FRONT_ORIGIN = originalFrontOrigin;
      if (originalAuthCookieSecure === undefined)
        delete process.env.AUTH_COOKIE_SECURE;
      else process.env.AUTH_COOKIE_SECURE = originalAuthCookieSecure;
    }

    expect(sessionCookie).toHaveBeenCalledWith(
      'app_session',
      'session-token',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
        maxAge: 123000,
      }),
    );
  });
});

describe('JWT-cookie auth tenant boundary (e2e)', () => {
  let app: INestApplication<App>;
  let direct: PrismaClient;

  beforeAll(async () => {
    process.env.SESSION_JWT_SECRET = TEST_SECRET;
    process.env.FRONT_ORIGIN = 'http://localhost:3000';
    process.env.AUTH_COOKIE_SECURE = 'auto';

    direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    await direct.$connect();
  });

  beforeEach(async () => {
    await direct.user.deleteMany({
      where: {
        email: {
          in: [
            'ulw-owner@example.test',
            'dup@example.test',
            'login-200@example.test',
          ],
        },
      },
    });
    await direct.facility.deleteMany({
      where: {
        name: { in: ['ULW 요양원', '중복 요양원', '로그인 요양원'] },
      },
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await direct.$disconnect();
    if (ORIGINAL_AUTH_COOKIE_SECURE === undefined) {
      delete process.env.AUTH_COOKIE_SECURE;
    } else {
      process.env.AUTH_COOKIE_SECURE = ORIGINAL_AUTH_COOKIE_SECURE;
    }
  });

  it('rejects unauthenticated protected requests with 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    await request(app.getHttpServer()).get('/api/v1/cameras').expect(401);
  });

  it('registers a password owner, returns identity from /auth/me, and rejects duplicate signup', async () => {
    const registered = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        name: '홍원장',
        email: ' ULW-OWNER@EXAMPLE.TEST ',
        password: 'care2026',
        phone: '010-1111-2222',
        facilityName: 'ULW 요양원',
      })
      .expect(201);
    const sessionCookie = extractSessionCookie(
      registered.headers['set-cookie'],
    );

    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Strict');
    expect(JSON.stringify(registered.body)).not.toContain('passwordHash');
    expect(JSON.stringify(registered.body)).not.toContain('care2026');
    const registeredBody = registered.body as unknown as AuthResponseBody;
    expect(registeredBody.user.facilityId).toBeTruthy();

    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('cookie', sessionCookie)
      .expect(200);
    expect(me.body as AuthResponseBody['user']).toMatchObject({
      email: 'ulw-owner@example.test',
      role: 'ADMIN',
      facilityId: registeredBody.user.facilityId,
    });

    await request(app.getHttpServer())
      .get('/api/v1/cameras')
      .set('cookie', sessionCookie)
      .expect(200);
    await request(app.getHttpServer()).get('/api/v1/cameras').expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        name: '다른 원장',
        email: 'ulw-owner@example.test',
        password: 'care2026',
        phone: '010-3333-4444',
        facilityName: '중복 요양원',
      })
      .expect(409);
  });

  it('logs in an existing password user with a strict httpOnly app_session JWT cookie and revokes it on logout', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        name: '로그인 원장',
        email: 'login-200@example.test',
        password: 'care2026',
        phone: '010-5555-6666',
        facilityName: '로그인 요양원',
      })
      .expect(201);

    const loggedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'login-200@example.test', password: 'care2026' })
      .expect(200);
    const sessionCookie = extractSessionCookie(loggedIn.headers['set-cookie']);
    expect(sessionCookie).toContain('app_session=');
    expect(sessionCookie).toContain('Path=/');
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Strict');
    expect(sessionCookie).not.toContain('; Secure');
    expect(sessionCookie).not.toContain('Domain=');
    expect(sessionCookie.split(';')[0].split('=')[1].split('.')).toHaveLength(
      3,
    );
    expect((loggedIn.body as unknown as AuthResponseBody).user).toMatchObject({
      email: 'login-200@example.test',
      role: 'ADMIN',
    });
    expect(JSON.stringify(loggedIn.body)).not.toContain('passwordHash');

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('cookie', sessionCookie)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/cameras')
      .set('cookie', sessionCookie)
      .expect(200);

    const loggedOut = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('cookie', sessionCookie)
      .expect(204);
    const clearedCookie = extractSessionCookie(loggedOut.headers['set-cookie']);
    for (const attribute of ['Path=/', 'HttpOnly', 'SameSite=Strict']) {
      expect(clearedCookie).toContain(attribute);
    }
    expect(clearedCookie).not.toContain('; Secure');
    expect(clearedCookie).not.toContain('Domain=');
    expect(clearedCookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('cookie', sessionCookie)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/cameras')
      .set('cookie', sessionCookie)
      .expect(401);
  });

  it('rejects signup when required fields are missing', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        name: '홍원장',
        email: 'missing-phone@example.test',
        password: 'care2026',
        facilityName: 'ULW 요양원',
      })
      .expect(400);
  });

  it('rejects signup passwords shorter than the public password policy', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        name: '홍원장',
        email: 'weak-password@example.test',
        password: '1234567',
        phone: '010-1111-2222',
        facilityName: 'ULW 요양원',
      })
      .expect(400);
  });
});

function extractSessionCookie(
  setCookie: string[] | string | undefined,
): string {
  const values = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  const cookie = values.find((value) => value.startsWith('app_session='));
  if (!cookie) throw new Error('app_session cookie missing');
  return cookie;
}
