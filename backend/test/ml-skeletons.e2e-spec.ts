import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';

const TEST_SECRET = 'test-session-secret-minimum-32-characters';
const SKELETON_ADMIN_EMAIL = 'ml-skeleton-owner@example.test';
const SKELETON_ADMIN_PASSWORD = 'care2026';

const SKELETON_FACILITY = {
  name: 'ML Skeleton E2E Facility',
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
      where: { email: SKELETON_ADMIN_EMAIL },
    });
    await direct.facility.deleteMany({
      where: { name: SKELETON_FACILITY.name },
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
  const registered = await request(app.getHttpServer())
    .post('/auth/register')
    .send({
      name: 'ML Skeleton Owner',
      email: SKELETON_ADMIN_EMAIL,
      phone: '010-5555-0101',
      facilityName: SKELETON_FACILITY.name,
      password: SKELETON_ADMIN_PASSWORD,
    })
    .expect(201);

  return extractSessionCookie(registered.headers['set-cookie']);
}

function extractSessionCookie(cookies: string | string[] | undefined): string {
  const list = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
  const sessionCookie = list.find((cookie) =>
    cookie.startsWith('app_session='),
  );
  if (!sessionCookie) throw new Error('app_session cookie missing');
  return sessionCookie;
}
