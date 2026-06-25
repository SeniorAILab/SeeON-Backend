import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { KakaoClient } from '../src/auth/kakao.client';

const TEST_SECRET = 'test-session-secret-minimum-32-characters';

const SKELETON_FACILITY = {
  name: 'ML Skeleton E2E Facility',
  businessRegistrationNumber: '990-00-00001',
};

describe('ML skeleton controllers (e2e)', () => {
  let app: INestApplication<App>;
  let direct: PrismaClient;
  let facilitySessionCookie: string;

  beforeAll(async () => {
    process.env.SESSION_JWT_SECRET = TEST_SECRET;
    process.env.KAKAO_REST_API_KEY = 'test-rest-api-key';
    process.env.KAKAO_REDIRECT_URI =
      'http://localhost:3001/auth/kakao/callback';
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
    await direct.user.deleteMany({
      where: { kakaoId: 'kakao-ml-skeleton-user' },
    });
    await direct.facility.deleteMany({
      where: { name: SKELETON_FACILITY.name },
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
          kakaoId: 'kakao-ml-skeleton-user',
          email: 'ml-skeleton@example.test',
          nickname: 'ML Skeleton Owner',
        }),
        resolveScopes: () => 'talk_message',
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    facilitySessionCookie = await createFacilitySessionCookie(app);
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await direct.$disconnect();
  });

  it.each([
    ['GET', '/api/alert-rules'],
    ['POST', '/api/alert-rules'],
    ['PATCH', '/api/alert-rules/rule-1'],
    ['DELETE', '/api/alert-rules/rule-1'],
    ['GET', '/api/space-statuses'],
    ['GET', '/api/detection-events'],
    ['PATCH', '/api/detection-events/det-1'],
    ['GET', '/api/resident-risk-summaries'],
  ] as const)(
    'requires auth before returning skeleton 501 for %s %s',
    async (method, path) => {
      await performRequest(app, method, path).expect(401);
    },
  );

  it.each([
    ['GET', '/api/alert-rules', 'alert-rules is not implemented yet'],
    ['POST', '/api/alert-rules', 'alert-rules is not implemented yet'],
    ['PATCH', '/api/alert-rules/rule-1', 'alert-rules is not implemented yet'],
    ['DELETE', '/api/alert-rules/rule-1', 'alert-rules is not implemented yet'],
    ['GET', '/api/space-statuses', 'space-statuses is not implemented yet'],
    ['GET', '/api/detection-events', 'detection-events is not implemented yet'],
    [
      'PATCH',
      '/api/detection-events/det-1',
      'detection-events is not implemented yet',
    ],
    [
      'GET',
      '/api/resident-risk-summaries',
      'resident-risk-summaries is not implemented yet',
    ],
  ] as const)(
    'returns guarded 501 for facility-scoped %s %s',
    async (method, path, message) => {
      const res = await performRequest(app, method, path)
        .set('cookie', facilitySessionCookie)
        .expect(501);

      expect(res.body).toEqual({
        error: 'not_implemented',
        message,
      });
    },
  );
});

function performRequest(
  app: INestApplication<App>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
) {
  const agent = request(app.getHttpServer());

  switch (method) {
    case 'GET':
      return agent.get(path);
    case 'POST':
      return agent.post(path);
    case 'PATCH':
      return agent.patch(path);
    case 'DELETE':
      return agent.delete(path);
    default:
      throw new Error(`Unsupported method: ${String(method)}`);
  }
}

async function createFacilitySessionCookie(
  app: INestApplication<App>,
): Promise<string> {
  const login = await request(app.getHttpServer())
    .get('/auth/kakao/login')
    .expect(302);
  const stateCookie = login.headers['set-cookie'][0];
  const state = /kakao_oauth_state=([^;]+)/.exec(stateCookie)?.[1];
  expect(state).toBeTruthy();

  const callback = await request(app.getHttpServer())
    .get(`/auth/kakao/callback?code=test-code&state=${state}`)
    .set('cookie', stateCookie)
    .expect(302);
  const onboardingSessionCookie = extractSessionCookie(
    callback.headers['set-cookie'],
  );

  const facilityCreate = await request(app.getHttpServer())
    .post('/api/facilities')
    .set('cookie', onboardingSessionCookie)
    .send({
      facilityName: SKELETON_FACILITY.name,
      businessRegistrationNumber: SKELETON_FACILITY.businessRegistrationNumber,
    })
    .expect(201);

  return extractSessionCookie(facilityCreate.headers['set-cookie']);
}

function extractSessionCookie(cookies: string | string[] | undefined): string {
  const list = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
  const sessionCookie = list.find((cookie) =>
    cookie.startsWith('app_session='),
  );
  if (!sessionCookie) throw new Error('app_session cookie missing');
  return sessionCookie;
}
