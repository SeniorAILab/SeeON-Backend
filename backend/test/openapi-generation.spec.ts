import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { OpenAPIObject } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import { createOpenApiDocument } from '../src/openapi/openapi-document';
import { PrismaService } from '../src/prisma/prisma.service';

const OWNED_PATHS = [
  '/api/v1/alerts',
  '/api/v1/alerts/{id}',
  '/api/v1/alerts/{id}/resolve',
  '/api/v1/dashboard/stream',
] as const;
const OWNED_SCHEMAS = [
  'AlertActor',
  'AlertSpace',
  'Alert',
  'AlertList',
  'AlertNote',
  'AlertDetail',
  'AlertSseData',
  'AlertUpdatedSseData',
] as const;
const RETIRED_VALIDATION_PATHS = [
  '/api/v1/admin/edge-installations/{edgeInstallationId}/validation-runs',
  '/api/v1/admin/edge-installations/{edgeInstallationId}/validation-runs/{validationRunId}/events',
] as const;
const RETIRED_VALIDATION_SCHEMAS = [
  'CreateValidationRunRequest',
  'ValidationRunResponse',
] as const;
const OPENAPI_PATH = join(__dirname, '..', '..', 'docs', 'openapi', 'v1.json');

const prismaDouble = {
  onModuleInit: jest.fn(),
  onModuleDestroy: jest.fn(),
  db: {
    mediaDownloadProcessHeartbeat: {
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
  },
};

describe('generated ordinary Alert OpenAPI contract', () => {
  it('keeps the published REST/SSE slice equal to runtime metadata', async () => {
    const previousSecret = process.env.SESSION_JWT_SECRET;
    process.env.SESSION_JWT_SECRET =
      'openapi-generation-session-secret-32-characters';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaDouble)
      .compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', {
      exclude: [
        { path: '/', method: RequestMethod.ALL },
        { path: '/health', method: RequestMethod.ALL },
      ],
    });
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    try {
      const generated = createOpenApiDocument(app);
      let published = readPublishedDocument();
      if (process.env.UPDATE_OPENAPI === '1') {
        published = generated;
        writeFileSync(OPENAPI_PATH, `${JSON.stringify(generated, null, 2)}\n`);
      }
      expect(published).toEqual(generated);
      for (const path of OWNED_PATHS) {
        expect(generated.paths[path]).toBeDefined();
      }
      for (const schema of OWNED_SCHEMAS) {
        expect(generated.components?.schemas?.[schema]).toBeDefined();
      }
      for (const path of RETIRED_VALIDATION_PATHS) {
        expect(generated.paths[path]).toBeUndefined();
        expect(published.paths[path]).toBeUndefined();
      }
      for (const schema of RETIRED_VALIDATION_SCHEMAS) {
        expect(generated.components?.schemas?.[schema]).toBeUndefined();
        expect(published.components?.schemas?.[schema]).toBeUndefined();
      }
      expect(JSON.stringify(generated)).not.toContain('SYSTEM_TEST');
    } finally {
      await app.close();
      if (previousSecret === undefined) delete process.env.SESSION_JWT_SECRET;
      else process.env.SESSION_JWT_SECRET = previousSecret;
    }
  });
});

function readPublishedDocument(): OpenAPIObject {
  return JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as OpenAPIObject;
}
