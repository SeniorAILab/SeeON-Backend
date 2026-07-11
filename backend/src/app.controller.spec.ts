import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { PrismaService } from './prisma/prisma.service';
import { AppController } from './app.controller';
import { AppService } from './app.service';

const DEPLOY_SHA = '0123456789abcdef0123456789abcdef01234567';

describe('AppController', () => {
  let appController: AppController;
  const prisma = { $queryRaw: jest.fn() };
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDeploySha = process.env.DEPLOY_SHA;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEPLOY_SHA = DEPLOY_SHA;
    prisma.$queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDeploySha === undefined) delete process.env.DEPLOY_SHA;
    else process.env.DEPLOY_SHA = originalDeploySha;
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('health', () => {
    it('returns the exact deployed SHA and healthy database status', async () => {
      await expect(appController.getHealth()).resolves.toEqual({
        status: 'ok',
        sha: DEPLOY_SHA,
        database: 'ok',
      });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['test', undefined],
      ['production', undefined],
      ['test', 'not-a-sha'],
      ['production', 'not-a-sha'],
    ])(
      'fails closed with NODE_ENV=%s and DEPLOY_SHA=%p',
      async (nodeEnv, deploySha) => {
        process.env.NODE_ENV = nodeEnv;
        if (deploySha === undefined) delete process.env.DEPLOY_SHA;
        else process.env.DEPLOY_SHA = deploySha;

        await expect(appController.getHealth()).rejects.toMatchObject({
          response: {
            status: 'unhealthy',
            sha: 'unknown',
            database: 'ok',
          },
          status: 503,
        });
      },
    );

    it('returns healthy in production with an exact deploy SHA', async () => {
      process.env.NODE_ENV = 'production';

      await expect(appController.getHealth()).resolves.toEqual({
        status: 'ok',
        sha: DEPLOY_SHA,
        database: 'ok',
      });
    });

    it('returns service unavailable without database error details', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

      await expect(appController.getHealth()).rejects.toMatchObject({
        response: {
          status: 'unhealthy',
          sha: DEPLOY_SHA,
          database: 'unhealthy',
        },
        status: 503,
      });
    });
  });
});
