import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { KakaoClient } from '../src/auth/kakao.client';
import { setOAuthStateCookie, setSessionCookie } from '../src/auth/cookie.util';
import { SessionService } from '../src/auth/session.service';
import { createSignedSessionToken } from '../src/auth/signed-token';

const TEST_SECRET = 'test-session-secret-minimum-32-characters';

type AuthResponseBody = {
  user: {
    id: string;
    kakaoId: string;
    sessionVersion: number;
    orgId: string | null;
    role?: string;
  };
};

type OrgProbeBody = {
  orgId: string | null;
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
    process.env.NODE_ENV = 'production';
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
        path: '/auth',
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
      'http://localhost:3001/auth/kakao/callback';

    direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    await direct.$connect();
  });

  beforeEach(async () => {
    await direct.kakaoIdentity.deleteMany();
    await direct.serverSession.deleteMany();
    await direct.user.deleteMany({ where: { kakaoId: 'kakao-e2e-user' } });
    await direct.organization.deleteMany({ where: { name: 'E2E Facility' } });

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
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await direct.$disconnect();
  });

  it('rejects unauthenticated protected requests with 401', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
    await request(app.getHttpServer()).get('/auth/session').expect(401);
    await request(app.getHttpServer()).get('/api/protected-probe').expect(401);
  });

  it('round-trips Kakao login, creates owner org during onboarding, and revokes session on logout', async () => {
    const login = await request(app.getHttpServer())
      .get('/auth/kakao/login')
      .expect(302);
    const stateCookie = login.headers['set-cookie'][0];
    const state = /kakao_oauth_state=([^;]+)/.exec(stateCookie)?.[1];
    expect(state).toBeTruthy();
    expect(login.headers.location).toBe(
      `https://kauth.kakao.test/oauth?state=${state}`,
    );

    const callback = await request(app.getHttpServer())
      .get(`/auth/kakao/callback?code=test-code&state=${state}`)
      .set('cookie', stateCookie)
      .expect(302);
    const firstSessionCookie = extractSessionCookie(
      callback.headers['set-cookie'],
    );
    expect(callback.headers.location).toBe('/onboarding');
    expect(firstSessionCookie).toContain('HttpOnly');
    expect(firstSessionCookie).toContain('SameSite=Lax');

    const meBeforeOrg = await request(app.getHttpServer())
      .get('/auth/me')
      .set('cookie', firstSessionCookie)
      .expect(200);
    expect(
      (meBeforeOrg.body as unknown as AuthResponseBody).user.orgId,
    ).toBeNull();

    await request(app.getHttpServer())
      .get('/api/org-protected-probe')
      .set('cookie', firstSessionCookie)
      .expect(403);

    await request(app.getHttpServer())
      .get('/sse')
      .set('cookie', firstSessionCookie)
      .expect(403);

    const orgCreate = await request(app.getHttpServer())
      .post('/orgs')
      .set('cookie', firstSessionCookie)
      .send({
        facilityName: 'E2E Facility',
        businessRegistrationNumber: '123-45-67890',
      })
      .expect(201);
    const orgSessionCookie = extractSessionCookie(
      orgCreate.headers['set-cookie'],
    );
    const orgCreateBody = orgCreate.body as unknown as AuthResponseBody;
    expect(orgCreateBody.user.orgId).toBeTruthy();
    expect(orgCreateBody.user.role).toBe('OWNER');
    const kakaoIdentity = await direct.kakaoIdentity.findUniqueOrThrow({
      where: { userId: orgCreateBody.user.id },
    });
    expect(JSON.stringify(kakaoIdentity)).not.toContain('test-access-token');

    const orgProbe = await request(app.getHttpServer())
      .get('/api/org-protected-probe')
      .set('cookie', orgSessionCookie)
      .expect(200);
    expect((orgProbe.body as unknown as OrgProbeBody).orgId).toBe(
      orgCreateBody.user.orgId,
    );

    const activeSession = await direct.serverSession.findFirstOrThrow({
      where: { userId: orgCreateBody.user.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const oldToken = createSignedSessionToken(
      {
        sessionId: activeSession.id,
        userId: orgCreateBody.user.id,
        orgId: orgCreateBody.user.orgId,
        sessionVersion: orgCreateBody.user.sessionVersion,
        iat: nowSeconds - 700,
        exp: nowSeconds + 1800,
      },
      TEST_SECRET,
    );
    const expiredToken = createSignedSessionToken(
      {
        sessionId: activeSession.id,
        userId: orgCreateBody.user.id,
        orgId: orgCreateBody.user.orgId,
        sessionVersion: orgCreateBody.user.sessionVersion,
        iat: nowSeconds - 3600,
        exp: nowSeconds - 1,
      },
      TEST_SECRET,
    );
    const staleVersionToken = createSignedSessionToken(
      {
        sessionId: activeSession.id,
        userId: orgCreateBody.user.id,
        orgId: orgCreateBody.user.orgId,
        sessionVersion: orgCreateBody.user.sessionVersion + 1,
        iat: nowSeconds,
        exp: nowSeconds + 1800,
      },
      TEST_SECRET,
    );
    const tamperedToken = `${oldToken.slice(0, -1)}${oldToken.endsWith('a') ? 'b' : 'a'}`;

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('cookie', `app_session=${tamperedToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('cookie', `app_session=${expiredToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('cookie', `app_session=${staleVersionToken}`)
      .expect(401);

    const serverRenderSession = await request(app.getHttpServer())
      .get('/auth/session')
      .set('cookie', `app_session=${oldToken}`)
      .expect(200);
    expect(
      extractSessionCookieOptional(serverRenderSession.headers['set-cookie']),
    ).toBeNull();
    await expect(
      direct.serverSession.findUniqueOrThrow({
        where: { id: activeSession.id },
      }),
    ).resolves.toMatchObject({ revokedAt: null });
    const rotated = await request(app.getHttpServer())
      .get('/sse')
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
      .get('/auth/me')
      .set('cookie', `app_session=${oldToken}`)
      .expect(401);

    await request(app.getHttpServer())
      .get('/sse')
      .set('cookie', rotatedCookie)
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('cookie', rotatedCookie)
      .expect(204);

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('cookie', rotatedCookie)
      .expect(401);

    await request(app.getHttpServer())
      .get('/api/protected-probe')
      .set('cookie', rotatedCookie)
      .expect(401);

    await request(app.getHttpServer())
      .get('/sse')
      .set('cookie', rotatedCookie)
      .expect(401);
  });

  it('rejects OAuth callbacks when a state cookie is present but query state is missing or different', async () => {
    const login = await request(app.getHttpServer())
      .get('/auth/kakao/login')
      .expect(302);
    const stateCookie = login.headers['set-cookie'][0];

    const missingState = await request(app.getHttpServer())
      .get('/auth/kakao/callback?code=test-code')
      .set('cookie', stateCookie)
      .expect(400);
    expect(
      extractSessionCookieOptional(missingState.headers['set-cookie']),
    ).toBeNull();

    const mismatchedState = await request(app.getHttpServer())
      .get('/auth/kakao/callback?code=test-code&state=different')
      .set('cookie', stateCookie)
      .expect(400);
    expect(
      extractSessionCookieOptional(mismatchedState.headers['set-cookie']),
    ).toBeNull();
  });

  it('rejects callback requests with missing or mismatched OAuth state', async () => {
    await request(app.getHttpServer())
      .get('/auth/kakao/callback?code=test-code&state=bad')
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
