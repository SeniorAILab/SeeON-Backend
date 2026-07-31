import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { Role } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureVersionedTestApp } from './helpers/versioned-app';

const TEST_SECRET = 'test-session-secret-minimum-32-characters';
const ADMIN_PASSWORD = 'care2026';
const ISSUED_PASSWORD = 'issued2026';

type UserBody = {
  id: string;
  name: string;
  email: string | null;
  role: Role;
};

describe('facility-scoped users API (e2e)', () => {
  let app: INestApplication<App>;
  let direct: PrismaClient;
  let facilityAId: string;
  let facilityBId: string;
  let adminACookie: string;
  let adminBCookie: string;

  beforeAll(async () => {
    process.env.SESSION_JWT_SECRET = TEST_SECRET;
    process.env.FRONT_ORIGIN = 'http://localhost:3000';

    direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    await direct.$connect();
  });

  beforeEach(async () => {
    await direct.user.deleteMany({
      where: { email: { endsWith: '@users-api.example.test' } },
    });
    await direct.facility.deleteMany({
      where: { name: { in: ['Users A 요양원', 'Users B 요양원'] } },
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();

    const adminA = await registerAdmin({
      name: 'A 원장',
      email: 'admin-a@users-api.example.test',
      phone: '010-1000-0001',
      facilityName: 'Users A 요양원',
    });
    const adminB = await registerAdmin({
      name: 'B 원장',
      email: 'admin-b@users-api.example.test',
      phone: '010-1000-0002',
      facilityName: 'Users B 요양원',
    });
    adminACookie = adminA.cookie;
    adminBCookie = adminB.cookie;
    facilityAId = adminA.facilityId;
    facilityBId = adminB.facilityId;
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await direct.$disconnect();
  });

  it('lists, creates, and changes roles only inside the effective facility scope', async () => {
    const create = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('cookie', adminACookie)
      .send({
        name: 'A 스태프',
        email: ' Staff-A@Users-Api.Example.Test ',
        role: 'STAFF',
        initialPassword: ISSUED_PASSWORD,
      })
      .expect(201);

    expect(create.body).toEqual({
      user: {
        id: expect.any(String),
        name: 'A 스태프',
        email: 'staff-a@users-api.example.test',
        role: 'STAFF',
      },
      initialPassword: ISSUED_PASSWORD,
    });
    expect(Object.keys(create.body.user).sort()).toEqual([
      'email',
      'id',
      'name',
      'role',
    ]);
    expect(JSON.stringify(create.body)).not.toContain('passwordHash');

    const createdUser = create.body.user as UserBody;
    const storedUser = await direct.user.findUniqueOrThrow({
      where: { id: createdUser.id },
    });
    expect(storedUser.facilityId).toBe(facilityAId);
    expect(storedUser.passwordHash).toBeTruthy();
    expect(storedUser.passwordHash).not.toBe(ISSUED_PASSWORD);

    const listA = await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('cookie', adminACookie)
      .expect(200);
    expect(listA.body).toEqual(
      expect.arrayContaining([
        {
          id: createdUser.id,
          name: 'A 스태프',
          email: 'staff-a@users-api.example.test',
          role: 'STAFF',
        },
      ]),
    );
    for (const user of listA.body as UserBody[]) {
      expect(Object.keys(user).sort()).toEqual(['email', 'id', 'name', 'role']);
    }
    expect(JSON.stringify(listA.body)).not.toContain('passwordHash');

    const listB = await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('cookie', adminBCookie)
      .expect(200);
    expect((listB.body as UserBody[]).map((user) => user.id)).not.toContain(
      createdUser.id,
    );

    const roleChange = await request(app.getHttpServer())
      .patch(`/api/v1/users/${createdUser.id}/role`)
      .set('cookie', adminACookie)
      .send({ role: 'ADMIN' })
      .expect(200);
    expect(roleChange.body).toEqual({
      id: createdUser.id,
      name: 'A 스태프',
      email: 'staff-a@users-api.example.test',
      role: 'ADMIN',
    });
    expect(JSON.stringify(roleChange.body)).not.toContain('passwordHash');

    await request(app.getHttpServer())
      .patch(`/api/v1/users/${createdUser.id}/role`)
      .set('cookie', adminBCookie)
      .send({ role: 'STAFF' })
      .expect(404);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'staff-a@users-api.example.test',
        password: ISSUED_PASSWORD,
      })
      .expect(200);
    const issuedCookie = extractSessionCookie(login.headers['set-cookie']);
    expect(login.body).toEqual({
      user: expect.objectContaining({
        id: createdUser.id,
        email: 'staff-a@users-api.example.test',
        role: 'ADMIN',
        facilityId: facilityAId,
      }),
    });
    expect(JSON.stringify(login.body)).not.toContain('passwordHash');

    await request(app.getHttpServer())
      .patch(`/api/v1/users/${createdUser.id}/role`)
      .set('cookie', adminACookie)
      .send({ role: 'STAFF' })
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('cookie', issuedCookie)
      .expect(401);
    const relogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'staff-a@users-api.example.test',
        password: ISSUED_PASSWORD,
      })
      .expect(200);
    expect(relogin.body).toEqual({
      user: expect.objectContaining({ role: 'STAFF', facilityId: facilityAId }),
    });
  });

  it('rejects SUPER_ADMIN assignment and duplicate emails with fixed error codes', async () => {
    const superCreate = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('cookie', adminACookie)
      .send({
        name: '슈퍼 금지',
        email: 'super@users-api.example.test',
        role: 'SUPER_ADMIN',
        initialPassword: ISSUED_PASSWORD,
      })
      .expect(400);
    // ValidationPipe's default exception factory wraps class-validator
    // messages as message: string[] (rather than the single string the old
    // manual BadRequestException threw); statusCode stays 400 either way.
    expect(superCreate.body).toEqual(
      expect.objectContaining({
        statusCode: 400,
        message: expect.arrayContaining([
          expect.stringContaining('Only ADMIN and STAFF roles may be assigned'),
        ]),
      }),
    );

    const create = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('cookie', adminACookie)
      .send({
        name: '중복 사용자',
        email: 'duplicate@users-api.example.test',
        role: 'STAFF',
        initialPassword: ISSUED_PASSWORD,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('cookie', adminACookie)
      .send({
        name: '중복 사용자2',
        email: 'duplicate@users-api.example.test',
        role: 'STAFF',
        initialPassword: ISSUED_PASSWORD,
      })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toEqual(
          expect.objectContaining({
            statusCode: 409,
            message: expect.any(String),
          }),
        );
      });

    const superPatch = await request(app.getHttpServer())
      .patch(`/api/v1/users/${(create.body.user as UserBody).id}/role`)
      .set('cookie', adminACookie)
      .send({ role: 'SUPER_ADMIN' })
      .expect(400);
    // ValidationPipe's default exception factory wraps class-validator
    // messages as message: string[] (rather than the single string the old
    // manual BadRequestException threw); statusCode stays 400 either way.
    expect(superPatch.body).toEqual(
      expect.objectContaining({
        statusCode: 400,
        message: expect.arrayContaining([
          expect.stringContaining('Only ADMIN and STAFF roles may be assigned'),
        ]),
      }),
    );
  });

  it('requires facilityAdmin capability for all user-management routes', async () => {
    const create = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('cookie', adminACookie)
      .send({
        name: '권한 스태프',
        email: 'capability-staff@users-api.example.test',
        role: 'STAFF',
        initialPassword: ISSUED_PASSWORD,
      })
      .expect(201);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'capability-staff@users-api.example.test',
        password: ISSUED_PASSWORD,
      })
      .expect(200);
    const staffCookie = extractSessionCookie(login.headers['set-cookie']);

    const forbidden = await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('cookie', staffCookie)
      .expect(403);
    expect(forbidden.body).toEqual(
      expect.objectContaining({ statusCode: 403, message: expect.any(String) }),
    );

    await request(app.getHttpServer())
      .patch(`/api/v1/users/${(create.body.user as UserBody).id}/role`)
      .set('cookie', staffCookie)
      .send({ role: 'ADMIN' })
      .expect(403);
  });

  async function registerAdmin(input: {
    name: string;
    email: string;
    phone: string;
    facilityName: string;
  }): Promise<{ cookie: string; facilityId: string }> {
    const registered = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ ...input, password: ADMIN_PASSWORD })
      .expect(201);
    return {
      cookie: extractSessionCookie(registered.headers['set-cookie']),
      facilityId: registered.body.user.facilityId,
    };
  }
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
