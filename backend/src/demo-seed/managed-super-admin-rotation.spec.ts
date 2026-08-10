import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { hashPassword } from '../auth/password';
import { bootstrapSuperAdmin } from '../../prisma/seed-super-admin';
import { assertManagedSuperAdminDriftFree } from '../../prisma/check-admin-secret-drift';
import { configureVersionedTestApp } from '../../test/helpers/versioned-app';

const MANAGED_KEY = 'senior-ai-lab-primary' as const;
const SOURCE_EMAIL = 'task16-source@example.test';
const TARGET_EMAIL = 'task16-managed@example.test';
const UNRELATED_EMAIL = 'task16-unrelated@example.test';
const OLD_PASSWORD = 'task16-old-password';
const NEW_PASSWORD = 'task16-new-password';
const SESSION_SECRET = 'task16-session-secret-at-least-32-characters';

const config = {
  managedIdentityKey: MANAGED_KEY,
  email: TARGET_EMAIL,
  password: NEW_PASSWORD,
  bootstrapSourceEmail: SOURCE_EMAIL,
};

describe('managed SUPER_ADMIN rotation', () => {
  let app: INestApplication<App>;
  let direct: PrismaClient;

  beforeAll(async () => {
    assertLocalTestDatabase(process.env.DIRECT_URL);
    process.env.SESSION_JWT_SECRET = SESSION_SECRET;
    process.env.FRONT_ORIGIN = 'http://localhost:3000';

    direct = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    await direct.$connect();
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();
  });

  beforeEach(async () => {
    await cleanupFixtures();
    const foreignManagedCount = await direct.user.count({
      where: { managedIdentityKey: { not: null } },
    });
    if (foreignManagedCount !== 0) {
      throw new Error('local test database already has a managed identity');
    }
  });

  afterEach(async () => {
    await cleanupFixtures();
  });

  afterAll(async () => {
    await app.close();
    await direct.$disconnect();
  });

  it('claims the source row, rotates identity/password, invalidates the old session, and no-ops on rerun', async () => {
    const source = await direct.user.create({
      data: {
        email: SOURCE_EMAIL,
        nickname: 'Original product admin',
        passwordHash: await hashPassword(OLD_PASSWORD),
        role: 'SUPER_ADMIN',
        sessionVersion: 4,
      },
    });
    const unrelated = await direct.user.create({
      data: {
        email: UNRELATED_EMAIL,
        nickname: 'Independent admin',
        passwordHash: await hashPassword('unrelated-password'),
        role: 'SUPER_ADMIN',
        sessionVersion: 9,
      },
    });
    const oldLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: SOURCE_EMAIL, password: OLD_PASSWORD })
      .expect(200);
    const oldCookie = extractSessionCookie(oldLogin.headers['set-cookie']);

    await expect(bootstrapSuperAdmin(direct, config)).resolves.toBe('update');

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('cookie', oldCookie)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: TARGET_EMAIL, password: NEW_PASSWORD })
      .expect(200);

    const managed = await direct.user.findUniqueOrThrow({
      where: { managedIdentityKey: MANAGED_KEY },
    });
    expect(managed).toMatchObject({
      id: source.id,
      email: TARGET_EMAIL,
      managedIdentityKey: MANAGED_KEY,
      role: 'SUPER_ADMIN',
      facilityId: null,
      sessionVersion: 5,
    });
    expect(
      await direct.user.count({ where: { managedIdentityKey: MANAGED_KEY } }),
    ).toBe(1);
    expect(
      await direct.user.findUniqueOrThrow({ where: { id: unrelated.id } }),
    ).toEqual(unrelated);

    const passwordHashBeforeNoop = managed.passwordHash;
    await expect(bootstrapSuperAdmin(direct, config)).resolves.toBe('noop');
    expect(
      await direct.user.findUniqueOrThrow({
        where: { managedIdentityKey: MANAGED_KEY },
        select: { passwordHash: true, sessionVersion: true },
      }),
    ).toEqual({ passwordHash: passwordHashBeforeNoop, sessionVersion: 5 });
  });

  it('aborts without mutation when the target email belongs to another row', async () => {
    const source = await direct.user.create({
      data: {
        email: SOURCE_EMAIL,
        nickname: 'Source admin',
        passwordHash: await hashPassword(OLD_PASSWORD),
        role: 'SUPER_ADMIN',
      },
    });
    const collision = await direct.user.create({
      data: {
        email: TARGET_EMAIL,
        nickname: 'Unrelated target owner',
        passwordHash: await hashPassword('collision-password'),
        role: 'SUPER_ADMIN',
      },
    });

    await expect(bootstrapSuperAdmin(direct, config)).rejects.toThrow(
      'collision',
    );

    expect(
      await direct.user.findUniqueOrThrow({ where: { id: source.id } }),
    ).toEqual(source);
    expect(
      await direct.user.findUniqueOrThrow({ where: { id: collision.id } }),
    ).toEqual(collision);
    expect(
      await direct.user.count({ where: { managedIdentityKey: { not: null } } }),
    ).toBe(0);
  });

  it('aborts without altering unrelated admins when another managed identity exists', async () => {
    const source = await direct.user.create({
      data: {
        email: SOURCE_EMAIL,
        nickname: 'Source admin',
        passwordHash: await hashPassword(OLD_PASSWORD),
        role: 'SUPER_ADMIN',
      },
    });
    const foreignManaged = await direct.user.create({
      data: {
        email: UNRELATED_EMAIL,
        managedIdentityKey: 'another-managed-identity',
        nickname: 'Foreign managed admin',
        passwordHash: await hashPassword('foreign-password'),
        role: 'SUPER_ADMIN',
      },
    });

    await expect(bootstrapSuperAdmin(direct, config)).rejects.toThrow(
      'collision',
    );

    expect(
      await direct.user.findUniqueOrThrow({ where: { id: source.id } }),
    ).toEqual(source);
    expect(
      await direct.user.findUniqueOrThrow({ where: { id: foreignManaged.id } }),
    ).toEqual(foreignManaged);
  });

  it('detects managed identity and password drift without changing rows', async () => {
    await direct.user.create({
      data: {
        email: SOURCE_EMAIL,
        nickname: 'Source admin',
        passwordHash: await hashPassword(OLD_PASSWORD),
        role: 'SUPER_ADMIN',
      },
    });
    await bootstrapSuperAdmin(direct, config);
    await expect(
      assertManagedSuperAdminDriftFree(direct, config),
    ).resolves.toBeUndefined();
    const managedBeforeDrift = await direct.user.findUniqueOrThrow({
      where: { managedIdentityKey: MANAGED_KEY },
    });
    await direct.user.update({
      where: { id: managedBeforeDrift.id },
      data: { passwordHash: await hashPassword('drifted-password') },
    });

    await expect(
      assertManagedSuperAdminDriftFree(direct, config),
    ).rejects.toThrow('drift');

    expect(
      await direct.user.findUniqueOrThrow({
        where: { managedIdentityKey: MANAGED_KEY },
        select: { id: true, email: true, sessionVersion: true },
      }),
    ).toEqual({
      id: managedBeforeDrift.id,
      email: TARGET_EMAIL,
      sessionVersion: managedBeforeDrift.sessionVersion,
    });
  });

  async function cleanupFixtures(): Promise<void> {
    await direct.user.deleteMany({
      where: {
        OR: [
          { email: { in: [SOURCE_EMAIL, TARGET_EMAIL, UNRELATED_EMAIL] } },
          {
            managedIdentityKey: {
              in: [MANAGED_KEY, 'another-managed-identity'],
            },
          },
        ],
      },
    });
  }
});

function assertLocalTestDatabase(directUrl: string | undefined): void {
  if (!directUrl)
    throw new Error('DIRECT_URL is required for this integration spec');
  const database = new URL(directUrl).pathname.replace(/^\//, '');
  if (database !== 'fall_dev') {
    throw new Error(
      'managed rotation spec requires the local fall_dev database',
    );
  }
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
