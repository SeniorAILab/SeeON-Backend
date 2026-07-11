import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppController } from '../src/app.controller';
import { AppService } from '../src/app.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureVersionedTestApp } from './helpers/versioned-app';

const DEPLOY_SHA = '0123456789abcdef0123456789abcdef01234567';

describe('health (e2e)', () => {
  let app: INestApplication<App>;
  const prisma = { $queryRaw: jest.fn() };
  const originalDeploySha = process.env.DEPLOY_SHA;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEPLOY_SHA = DEPLOY_SHA;
    prisma.$queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(() => {
    if (originalDeploySha === undefined) delete process.env.DEPLOY_SHA;
    else process.env.DEPLOY_SHA = originalDeploySha;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns the exact deploy SHA after a successful database probe', async () => {
    await request(app.getHttpServer()).get('/health').expect(200).expect({
      status: 'ok',
      sha: DEPLOY_SHA,
      database: 'ok',
    });
  });

  it.each([undefined, 'not-a-sha'])(
    'returns service unavailable when DEPLOY_SHA is %p',
    async (deploySha) => {
      if (deploySha === undefined) delete process.env.DEPLOY_SHA;
      else process.env.DEPLOY_SHA = deploySha;

      await request(app.getHttpServer()).get('/health').expect(503).expect({
        status: 'unhealthy',
        sha: 'unknown',
        database: 'ok',
      });
    },
  );

  it('returns service unavailable without database failure details', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(503);

    expect(response.body).toEqual({
      status: 'unhealthy',
      sha: DEPLOY_SHA,
      database: 'unhealthy',
    });
    expect(response.text).not.toContain('connection refused');
  });

  it.each(['/api/health', '/api/v1/health'])(
    'does not expose health through %s',
    async (path) => {
      await request(app.getHttpServer()).get(path).expect(404);
    },
  );
});
