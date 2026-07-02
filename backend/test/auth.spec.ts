import type { INestApplication } from '@nestjs/common';
import { ServiceUnavailableException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { KakaoClient } from '../src/auth/kakao.client';
import { setOAuthStateCookie, setSessionCookie } from '../src/auth/cookie.util';
import { configureVersionedTestApp } from './helpers/versioned-app';

const TEST_SECRET = 'test-session-secret-minimum-32-characters';

type AuthResponseBody = {
  user: {
    id: string;
    email?: string;
    sessionVersion?: number;
    facilityId: string | null;
    role?: string;
  };
};

describe('auth fail-fast config and cookie attributes', () => {
  it('fails fast for missing Kakao env', () => {
    const originalKakaoKey = process.env.KAKAO_REST_API_KEY;
    const originalRedirectUri = process.env.KAKAO_REDIRECT_URI;
    delete process.env.KAKAO_REST_API_KEY;
    delete process.env.KAKAO_REDIRECT_URI;
    try {
      expect(() =>
        new KakaoClient(new ConfigService({})).onModuleInit(),
      ).toThrow(ServiceUnavailableException);
      expect(() =>
        new KakaoClient(
          new ConfigService({
            KAKAO_REST_API_KEY: 'rest-key',
          }),
        ).onModuleInit(),
      ).toThrow(ServiceUnavailableException);
    } finally {
      if (originalKakaoKey === undefined) delete process.env.KAKAO_REST_API_KEY;
      else process.env.KAKAO_REST_API_KEY = originalKakaoKey;
      if (originalRedirectUri === undefined)
        delete process.env.KAKAO_REDIRECT_URI;
      else process.env.KAKAO_REDIRECT_URI = originalRedirectUri;
    }
  });

  it('sets bounded production cookie attributes for session and OAuth state', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalFrontOrigin = process.env.FRONT_ORIGIN;
    const originalAuthCookieSecure = process.env.AUTH_COOKIE_SECURE;
    process.env.NODE_ENV = 'production';
    process.env.FRONT_ORIGIN = 'http://senai.example.com';
    delete process.env.AUTH_COOKIE_SECURE;
    const sessionCookie = jest.fn();
    const stateCookie = jest.fn();
    try {
      setSessionCookie(
        { cookie: sessionCookie } as unknown as Parameters<
          typeof setSessionCookie
        >[0],
        'session-token',
        123,
      );
      setOAuthStateCookie(
        { cookie: stateCookie } as unknown as Parameters<
          typeof setOAuthStateCookie
        >[0],
        'state-token',
        45,
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
    expect(stateCookie).toHaveBeenCalledWith(
      'kakao_oauth_state',
      'state-token',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/api/v1/auth',
        maxAge: 45000,
      }),
    );
  });
});

describe('JWT-cookie auth tenant boundary (e2e)', () => {
  let app: INestApplication<App>;
  let direct: PrismaClient;

  beforeAll(async () => {
    process.env.SESSION_JWT_SECRET = TEST_SECRET;
    process.env.KAKAO_REST_API_KEY = 'test-rest-api-key';
    process.env.KAKAO_REDIRECT_URI =
      'http://localhost:3001/api/v1/auth/kakao/callback';
    process.env.KAKAO_TOKEN_ENC_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.FRONT_ORIGIN = 'http://localhost:3000';

    direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    await direct.$connect();
  });

  beforeEach(async () => {
    await direct.kakaoIdentity.deleteMany();
    await direct.user.deleteMany({ where: { kakaoId: 'kakao-e2e-user' } });
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
    })
      .overrideProvider(KakaoClient)
      .useValue({
        buildAuthorizeUrl: (state: string) =>
          `https://kauth.kakao.test/oauth?state=${state}`,
        exchangeCode: jest.fn().mockResolvedValue({
          access_token: 'test-access-token',
          expires_in: 3600,
        }),
        getProfile: jest.fn().mockResolvedValue({
          kakaoId: 'kakao-e2e-user',
          email: 'owner@example.test',
          nickname: '시설 원장',
        }),
        resolveScopes: () => 'talk_message',
      })
      .compile();

    app = moduleFixture.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await direct.$disconnect();
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
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Strict');
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

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('cookie', sessionCookie)
      .expect(204);

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

  it('rejects Kakao login when the Kakao account is not registered locally', async () => {
    const login = await request(app.getHttpServer())
      .get('/api/v1/auth/kakao/login')
      .expect(302);
    const stateCookie = login.headers['set-cookie'][0];
    const state = /kakao_oauth_state=([^;]+)/.exec(stateCookie)?.[1];
    expect(state).toBeTruthy();

    const callback = await request(app.getHttpServer())
      .get(`/api/v1/auth/kakao/callback?code=test-code&state=${state}`)
      .set('cookie', stateCookie)
      .expect(302);

    expect(callback.headers.location).toBe(
      'http://localhost:3000/login?auth_error=kakao_unregistered',
    );
    expect(
      extractSessionCookieOptional(callback.headers['set-cookie']),
    ).toBeNull();
  });

  it('round-trips linked Kakao login, creates owner facility during onboarding, and exposes the facility by scoped id', async () => {
    await direct.user.create({
      data: {
        kakaoId: 'kakao-e2e-user',
        email: 'owner@example.test',
        nickname: '시설 원장',
        role: 'ADMIN',
      },
    });

    const login = await request(app.getHttpServer())
      .get('/api/v1/auth/kakao/login')
      .expect(302);
    const stateCookie = login.headers['set-cookie'][0];
    const state = /kakao_oauth_state=([^;]+)/.exec(stateCookie)?.[1];
    expect(state).toBeTruthy();
    expect(login.headers.location).toBe(
      `https://kauth.kakao.test/oauth?state=${state}`,
    );

    const callback = await request(app.getHttpServer())
      .get(`/api/v1/auth/kakao/callback?code=test-code&state=${state}`)
      .set('cookie', stateCookie)
      .expect(302);
    const firstSessionCookie = extractSessionCookie(
      callback.headers['set-cookie'],
    );
    expect(callback.headers.location).toBe('http://localhost:3000/onboarding');
    expect(firstSessionCookie).toContain('HttpOnly');
    expect(firstSessionCookie).toContain('SameSite=Strict');

    const meBeforeFacility = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('cookie', firstSessionCookie)
      .expect(200);
    expect(
      (meBeforeFacility.body as AuthResponseBody['user']).facilityId,
    ).toBeNull();
    expect((meBeforeFacility.body as AuthResponseBody['user']).role).toBe(
      'ADMIN',
    );

    const facilityCreate = await request(app.getHttpServer())
      .post('/api/v1/facilities')
      .set('cookie', firstSessionCookie)
      .send({
        facilityName: 'ULW 요양원',
      })
      .expect(201);
    const facilitySessionCookie = extractSessionCookie(
      facilityCreate.headers['set-cookie'],
    );
    const facilityCreateBody =
      facilityCreate.body as unknown as AuthResponseBody;
    expect(facilityCreateBody.user.facilityId).toBeTruthy();
    expect(facilityCreateBody.user.role).toBe('ADMIN');
    const kakaoIdentity = await direct.kakaoIdentity.findUniqueOrThrow({
      where: { userId: facilityCreateBody.user.id },
    });
    expect(JSON.stringify(kakaoIdentity)).not.toContain('test-access-token');

    const currentFacility = await request(app.getHttpServer())
      .get(`/api/v1/facilities/${facilityCreateBody.user.facilityId}`)
      .set('cookie', facilitySessionCookie)
      .expect(200);
    expect((currentFacility.body as { id: string }).id).toBe(
      facilityCreateBody.user.facilityId,
    );

    await request(app.getHttpServer())
      .get('/api/v1/facilities/not-the-caller-facility')
      .set('cookie', facilitySessionCookie)
      .expect(404);
  });

  it('rejects OAuth callbacks when a state cookie is present but query state is missing or different', async () => {
    const login = await request(app.getHttpServer())
      .get('/api/v1/auth/kakao/login')
      .expect(302);
    const stateCookie = login.headers['set-cookie'][0];

    const missingState = await request(app.getHttpServer())
      .get('/api/v1/auth/kakao/callback?code=test-code')
      .set('cookie', stateCookie)
      .expect(400);
    expect(
      extractSessionCookieOptional(missingState.headers['set-cookie']),
    ).toBeNull();

    const mismatchedState = await request(app.getHttpServer())
      .get('/api/v1/auth/kakao/callback?code=test-code&state=different')
      .set('cookie', stateCookie)
      .expect(400);
    expect(
      extractSessionCookieOptional(mismatchedState.headers['set-cookie']),
    ).toBeNull();
  });

  it('rejects callback requests with missing or mismatched OAuth state', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/auth/kakao/callback?code=test-code&state=bad')
      .expect(400);
  });
});

function extractSessionCookieOptional(
  setCookie: string[] | string | undefined,
): string | null {
  const values = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  return values.find((value) => value.startsWith('app_session=')) ?? null;
}
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
