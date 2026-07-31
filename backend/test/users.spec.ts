import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { Role } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import {
  readArray,
  readArrayField,
  readNullableStringField,
  readNumber,
  readObject,
  readObjectField,
  readString,
  readStringField,
} from './helpers/json-response';
import { configureVersionedTestApp } from './helpers/versioned-app';

const TEST_SECRET = 'test-session-secret-minimum-32-characters';
const ADMIN_PASSWORD = 'care2026';
const ISSUED_PASSWORD = 'issued2026';

type UserBody = {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly role: Role;
};

function readRole(value: unknown): Role {
  if (value === 'SUPER_ADMIN' || value === 'ADMIN' || value === 'STAFF') {
    return value;
  }
  throw new Error('role must be a recognized role');
}

function readUserBody(value: unknown): UserBody {
  const body = readObject(value, 'user response');
  return {
    id: readStringField(body, 'id'),
    name: readStringField(body, 'name'),
    email: readNullableStringField(body, 'email'),
    role: readRole(body['role']),
  };
}

function readCreatedUser(value: unknown): UserBody {
  return readUserBody(
    readObjectField(readObject(value, 'create user response'), 'user'),
  );
}

describe('facility-scoped users API (e2e)', () => {
  let app: INestApplication<App>;
  let direct: PrismaClient;
  let facilityAId: string;
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

    const createBody = readObject(create.body, 'create user response');
    const createdUserResponse = readObjectField(createBody, 'user');
    const createdUser = readUserBody(createdUserResponse);
    expect(createdUser.id.length).toBeGreaterThan(0);
    expect(createdUser.name).toBe('A 스태프');
    expect(createdUser.email).toBe('staff-a@users-api.example.test');
    expect(createdUser.role).toBe('STAFF');
    expect(readStringField(createBody, 'initialPassword')).toBe(
      ISSUED_PASSWORD,
    );
    expect(Object.keys(createdUserResponse).sort()).toEqual([
      'email',
      'id',
      'name',
      'role',
    ]);
    expect(JSON.stringify(createBody)).not.toContain('passwordHash');

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
    const listAResponses = readArray(listA.body, 'facility A users response');
    const listAUsers = listAResponses.map(readUserBody);
    expect(listAUsers).toEqual(
      expect.arrayContaining([
        {
          id: createdUser.id,
          name: 'A 스태프',
          email: 'staff-a@users-api.example.test',
          role: 'STAFF',
        },
      ]),
    );
    for (const userResponse of listAResponses) {
      expect(
        Object.keys(readObject(userResponse, 'listed user')).sort(),
      ).toEqual(['email', 'id', 'name', 'role']);
    }
    expect(JSON.stringify(listAUsers)).not.toContain('passwordHash');

    const listB = await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('cookie', adminBCookie)
      .expect(200);
    const listBUsers = readArray(listB.body, 'facility B users response').map(
      readUserBody,
    );
    expect(listBUsers.map((user) => user.id)).not.toContain(createdUser.id);

    const roleChange = await request(app.getHttpServer())
      .patch(`/api/v1/users/${createdUser.id}/role`)
      .set('cookie', adminACookie)
      .send({ role: 'ADMIN' })
      .expect(200);
    expect(readUserBody(roleChange.body)).toEqual({
      id: createdUser.id,
      name: 'A 스태프',
      email: 'staff-a@users-api.example.test',
      role: 'ADMIN',
    });
    expect(JSON.stringify(readUserBody(roleChange.body))).not.toContain(
      'passwordHash',
    );

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
    const loginBody = readObject(login.body, 'login response');
    const loginUser = readObjectField(loginBody, 'user');
    expect(readStringField(loginUser, 'id')).toBe(createdUser.id);
    expect(readStringField(loginUser, 'email')).toBe(
      'staff-a@users-api.example.test',
    );
    expect(readStringField(loginUser, 'role')).toBe('ADMIN');
    expect(readStringField(loginUser, 'facilityId')).toBe(facilityAId);
    expect(JSON.stringify(loginBody)).not.toContain('passwordHash');

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
    const reloginUser = readObjectField(
      readObject(relogin.body, 'relogin response'),
      'user',
    );
    expect(readStringField(reloginUser, 'role')).toBe('STAFF');
    expect(readStringField(reloginUser, 'facilityId')).toBe(facilityAId);
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
    const superCreateBody = readObject(
      superCreate.body,
      'super user create error',
    );
    expect(readNumber(superCreateBody['statusCode'], 'statusCode')).toBe(400);
    expect(
      readArrayField(superCreateBody, 'message').some((message) =>
        readString(message, 'validation message').includes(
          'Only ADMIN and STAFF roles may be assigned',
        ),
      ),
    ).toBe(true);

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
    const duplicate = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('cookie', adminACookie)
      .send({
        name: '중복 사용자2',
        email: 'duplicate@users-api.example.test',
        role: 'STAFF',
        initialPassword: ISSUED_PASSWORD,
      })
      .expect(409);
    const duplicateBody = readObject(duplicate.body, 'duplicate user error');
    expect(readNumber(duplicateBody['statusCode'], 'statusCode')).toBe(409);
    expect(readStringField(duplicateBody, 'message')).not.toHaveLength(0);

    const createdDuplicateUser = readCreatedUser(create.body);

    const superPatch = await request(app.getHttpServer())
      .patch(`/api/v1/users/${createdDuplicateUser.id}/role`)
      .set('cookie', adminACookie)
      .send({ role: 'SUPER_ADMIN' })
      .expect(400);
    // ValidationPipe's default exception factory wraps class-validator
    // messages as message: string[] (rather than the single string the old
    // manual BadRequestException threw); statusCode stays 400 either way.
    const superPatchBody = readObject(superPatch.body, 'super user role error');
    expect(readNumber(superPatchBody['statusCode'], 'statusCode')).toBe(400);
    expect(
      readArrayField(superPatchBody, 'message').some((message) =>
        readString(message, 'validation message').includes(
          'Only ADMIN and STAFF roles may be assigned',
        ),
      ),
    ).toBe(true);
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
    const forbiddenBody = readObject(forbidden.body, 'forbidden users error');
    expect(readNumber(forbiddenBody['statusCode'], 'statusCode')).toBe(403);
    expect(readStringField(forbiddenBody, 'message')).not.toHaveLength(0);

    const createdStaffUser = readCreatedUser(create.body);

    await request(app.getHttpServer())
      .patch(`/api/v1/users/${createdStaffUser.id}/role`)
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
    const user = readObjectField(
      readObject(registered.body, 'registration response'),
      'user',
    );
    return {
      cookie: extractSessionCookie(registered.headers['set-cookie']),
      facilityId: readStringField(user, 'facilityId'),
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
