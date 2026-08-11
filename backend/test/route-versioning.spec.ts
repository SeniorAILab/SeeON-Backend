import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureVersionedTestApp } from './helpers/versioned-app';

const prismaDouble = {
  onModuleInit: jest.fn(),
  onModuleDestroy: jest.fn(),
  $connect: jest.fn(),
  $disconnect: jest.fn(),
  db: {
    mediaDownloadProcessHeartbeat: {
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  },
};
describe('global api/v1 route matrix (e2e)', () => {
  let app: INestApplication<App>;
  const originalEnv = {
    SESSION_JWT_SECRET: process.env.SESSION_JWT_SECRET,
  };

  beforeAll(async () => {
    process.env.SESSION_JWT_SECRET =
      'test-session-secret-minimum-32-characters';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaDouble)
      .compile();

    app = moduleRef.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    restoreEnv(originalEnv);
  });

  it('keeps root unprefixed and unversioned', async () => {
    await request(app.getHttpServer()).get('/').expect(200, 'Hello World!');
  });

  it('moves auth session under /api/v1 and removes the unversioned alias', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    await request(app.getHttpServer()).get('/auth/me').expect(404);
  });

  it('moves guarded API controllers under /api/v1', async () => {
    await request(app.getHttpServer()).get('/api/v1/cameras').expect(401);
    await request(app.getHttpServer()).get('/api/cameras').expect(404);
  });
  it('rejects accidentally double-prefixed API paths', async () => {
    await request(app.getHttpServer()).get('/api/api/cameras').expect(404);
    await request(app.getHttpServer()).get('/api/v1/v1/cameras').expect(404);
  });

  it('versions mixed auth API routes under /api/v1', async () => {
    await request(app.getHttpServer()).post('/api/v1/facilities').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/protected-probe')
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/facility-protected-probe')
      .expect(404);
    await request(app.getHttpServer()).post('/api/facilities').expect(404);
  });

  it('legacy ingest routes are removed (404)', async () => {
    await request(app.getHttpServer()).post('/ingest/alerts').expect(404);
    await request(app.getHttpServer()).post('/ingest/heartbeat').expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/ingest/alerts')
      .expect(404);
  });

  it('keeps swagger docs at /api/docs', async () => {
    await request(app.getHttpServer()).get('/api/docs').expect(200);
    await request(app.getHttpServer()).get('/api/v1/docs').expect(404);
  });
});

function restoreEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
