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
import { SessionService } from '../src/auth/session.service';
import { createSignedSessionToken } from '../src/auth/signed-token';
import { configureVersionedTestApp } from './helpers/versioned-app';

const TEST_SECRET = 'test-session-secret-minimum-32-characters';

type AuthResponseBody = {
  user: {
    id: string;
    kakaoId: string;
    email?: string;
    sessionVersion: number;
    facilityId: string | null;
    role?: string;
  };
};

type FacilityProbeBody = {
  facilityId: string | null;
};

describe('auth fail-fast config and cookie attributes', () => {
  it('fails fast for missing/short session secrets and missing Kakao env', () => {
    expect(() =>
      new SessionService(
        {} as never,
        new ConfigService({ SESSION_JWT_SECRET: 'short' }),
      ).onModuleInit(),
    ).toThrow(ServiceUnavailableException);

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
    process.env.FRONT_ORIGIN = 'https://senai.example.com';
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
        sameSite: 'lax',
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

describe('Kakao auth/session tenant boundary (e2e)', () => {
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
    await direct.serverSession.deleteMany();
    await direct.user.deleteMany({ where: { kakaoId: 'kakao-e2e-user' } });
    await direct.user.deleteMany({
      where: { email: { in: ['ulw-owner@example.test', 'dup@example.test'] } },
    });
    await direct.facility.deleteMany({ where: { name: 'E2E Facility' } });
    await direct.facility.deleteMany({
      where: { name: { in: ['ULW 요양원', '중복 요양원'] } },
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
    await request(app.getHttpServer()).get('/api/v1/auth/session').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/protected-probe')
      .expect(401);
  });

  it('registers a password owner, restores the session, and rejects duplicate signup', async () => {
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
    expect(JSON.stringify(registered.body)).not.toContain('passwordHash');
    expect(JSON.stringify(registered.body)).not.toContain('care2026');
    const registeredBody = registered.body as unknown as AuthResponseBody;
    expect(registeredBody.user.facilityId).toBeTruthy();

    const restored = await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('cookie', sessionCookie)
      .expect(200);
    expect((restored.body as unknown as AuthResponseBody).user).toMatchObject({
      email: 'ulw-owner@example.test',
      role: 'ADMIN',
      facilityId: registeredBody.user.facilityId,
    });

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

  it('logs in an existing password user and returns 200 (not 201)', async () => {
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
    expect(extractSessionCookie(loggedIn.headers['set-cookie'])).toContain(
      'HttpOnly',
    );
    expect((loggedIn.body as unknown as AuthResponseBody).user).toMatchObject({
      email: 'login-200@example.test',
      role: 'ADMIN',
    });
    expect(JSON.stringify(loggedIn.body)).not.toContain('passwordHash');
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

  it('round-trips linked Kakao login, creates owner facility during onboarding, and revokes session on logout', async () => {
    await direct.user.create({
      data: {
        kakaoId: 'kakao-e2e-user',
        email: 'owner@example.test',
        nickname: '시설 원장',
        role: 'STAFF',
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
    expect(firstSessionCookie).toContain('SameSite=Lax');

    const sessionBeforeFacility = await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('cookie', firstSessionCookie)
      .expect(200);
    expect(
      (sessionBeforeFacility.body as unknown as AuthResponseBody).user
        .facilityId,
    ).toBeNull();
    expect(
      (sessionBeforeFacility.body as unknown as AuthResponseBody).user.role,
    ).toBe('STAFF');

    await request(app.getHttpServer())
      .get('/api/v1/facility-protected-probe')
      .set('cookie', firstSessionCookie)
      .expect(403);

    const facilityCreate = await request(app.getHttpServer())
      .post('/api/v1/facilities')
      .set('cookie', firstSessionCookie)
      .send({
        facilityName: 'E2E Facility',
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

    const facilityProbe = await request(app.getHttpServer())
      .get('/api/v1/facility-protected-probe')
      .set('cookie', facilitySessionCookie)
      .expect(200);
    expect(
      (facilityProbe.body as unknown as FacilityProbeBody).facilityId,
    ).toBe(facilityCreateBody.user.facilityId);

    const activeSession = await direct.serverSession.findFirstOrThrow({
      where: {
        userId: facilityCreateBody.user.id,
        facilityId: facilityCreateBody.user.facilityId,
        revokedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
    const sessionSecret = app
      .get(ConfigService)
      .getOrThrow<string>('SESSION_JWT_SECRET');
    const nowSeconds = Math.floor(Date.now() / 1000);
    const oldToken = createSignedSessionToken(
      {
        sessionId: activeSession.id,
        userId: facilityCreateBody.user.id,
        facilityId: facilityCreateBody.user.facilityId,
        sessionVersion: facilityCreateBody.user.sessionVersion,
        iat: nowSeconds - 700,
        exp: nowSeconds + 1800,
      },
      sessionSecret,
    );
    const expiredToken = createSignedSessionToken(
      {
        sessionId: activeSession.id,
        userId: facilityCreateBody.user.id,
        facilityId: facilityCreateBody.user.facilityId,
        sessionVersion: facilityCreateBody.user.sessionVersion,
        iat: nowSeconds - 3600,
        exp: nowSeconds - 1,
      },
      sessionSecret,
    );
    const staleVersionToken = createSignedSessionToken(
      {
        sessionId: activeSession.id,
        userId: facilityCreateBody.user.id,
        facilityId: facilityCreateBody.user.facilityId,
        sessionVersion: facilityCreateBody.user.sessionVersion + 1,
        iat: nowSeconds,
        exp: nowSeconds + 1800,
      },
      sessionSecret,
    );
    const tamperedToken = `${oldToken.slice(0, -1)}${oldToken.endsWith('a') ? 'b' : 'a'}`;

    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('cookie', `app_session=${tamperedToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('cookie', `app_session=${expiredToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('cookie', `app_session=${staleVersionToken}`)
      .expect(401);

    const rotated = await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('cookie', `app_session=${oldToken}`)
      .expect(200);
    const rotatedCookie = extractSessionCookie(rotated.headers['set-cookie']);
    expect(rotatedCookie).not.toContain(oldToken);
    await expect(
      direct.serverSession.findUniqueOrThrow({
        where: { id: activeSession.id },
      }),
    ).resolves.toMatchObject({ revokedAt: expect.any(Date) as Date });
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('cookie', `app_session=${oldToken}`)
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('cookie', rotatedCookie)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('cookie', rotatedCookie)
      .expect(204);

    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('cookie', rotatedCookie)
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/protected-probe')
      .set('cookie', rotatedCookie)
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/facility-protected-probe')
      .set('cookie', rotatedCookie)
      .expect(401);
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
