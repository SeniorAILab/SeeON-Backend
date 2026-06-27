import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/prisma/prisma.service';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureVersionedTestApp } from './helpers/versioned-app';
const prismaDouble = {
  onModuleInit: jest.fn(),
  onModuleDestroy: jest.fn(),
  $connect: jest.fn(),
  $disconnect: jest.fn(),
  db: {
    serverSession: {
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  },
};
describe('global api/v1 route matrix (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
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
  });

  it('keeps root unprefixed and unversioned', async () => {
    await request(app.getHttpServer()).get('/').expect(200, 'Hello World!');
  });

  it('keeps auth session unprefixed and unversioned', async () => {
    await request(app.getHttpServer()).get('/auth/session').expect(401);
    await request(app.getHttpServer()).get('/api/v1/auth/session').expect(404);
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
    await request(app.getHttpServer()).get('/api/v1/protected-probe').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/facility-protected-probe')
      .expect(401);
    await request(app.getHttpServer()).post('/api/facilities').expect(404);
  });

  it('legacy ingest routes are removed (404)', async () => {
    await request(app.getHttpServer()).post('/ingest/alerts').expect(404);
    await request(app.getHttpServer()).post('/ingest/heartbeat').expect(404);
    await request(app.getHttpServer()).post('/api/v1/ingest/alerts').expect(404);
  });

  it('keeps swagger docs at /api/docs', async () => {
    await request(app.getHttpServer()).get('/api/docs').expect(200);
    await request(app.getHttpServer()).get('/api/v1/docs').expect(404);
  });
});
