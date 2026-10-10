import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod, ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import type * as AppModuleTypes from '../src/app.module.js';
import type * as OpenApiModuleTypes from '../src/openapi/adapters/openapi-document.adapter.js';
import type * as PrismaModuleTypes from '../src/prisma/prisma.service.js';
import type * as ClipStorageModuleTypes from '../src/media/services/clip-storage.service.js';
import type * as ClipBootModuleTypes from '../src/media/services/clip-storage-boot-reconciler.service.js';
import type * as DownloadAuditModuleTypes from '../src/media/services/media-download-audit.service.js';
import type * as ChannelModuleTypes from '../src/alerts/ports/channel.port.js';

jest.mock('../src/config/adapters/backend-env-files.adapter.js', () => ({
  backendEnvFilePaths: () => [],
}));

// Routes and components the backend must actually emit from code. They are
// asserted on the raw SwaggerModule document, never on the overlaid one: the
// adapter merges docs/openapi/v1.json over generation and lets the published
// file win every colliding key, so overlaid positives can be file-fed.
const RAW_OWNED_PATHS = [
  '/api/v1/alerts',
  '/api/v1/alerts/{id}',
  '/api/v1/alerts/{id}/resolve',
  '/api/v1/dashboard/stream',
] as const;
const RAW_OWNED_SCHEMAS = [
  'AlertActor',
  'AlertSpace',
  'Alert',
  'AlertNote',
  'AlertDetail',
  'AlertSseData',
  'AlertUpdatedSseData',
] as const;
// Backed by no DTO: the adapter synthesizes this array schema after the merge.
const OVERLAY_ONLY_SCHEMA = 'AlertList';
const RETIRED_VALIDATION_PATHS = [
  '/api/v1/admin/edge-installations/{edgeInstallationId}/validation-runs',
  '/api/v1/admin/edge-installations/{edgeInstallationId}/validation-runs/{validationRunId}/events',
] as const;
const RETIRED_VALIDATION_SCHEMAS = [
  'CreateValidationRunRequest',
  'ValidationRunResponse',
] as const;
const OPENAPI_PATH = join(__dirname, '..', '..', 'docs', 'openapi', 'v1.json');

describe('generated ordinary Alert OpenAPI contract', () => {
  it('keeps published overlay compatibility and raw-generated ownership of the Alert surface', async () => {
    const previousEnv = process.env;
    const previousBigIntToJSON = Object.getOwnPropertyDescriptor(
      BigInt.prototype,
      'toJSON',
    );
    const updateOpenApi = previousEnv.UPDATE_OPENAPI === '1';
    const prismaFactory = jest.fn(() => {
      throw new Error('Preview must not instantiate PrismaService');
    });
    const storageFactory = jest.fn(() => {
      throw new Error('Preview must not instantiate ClipStorageService');
    });
    const bootFactory = jest.fn(() => {
      throw new Error(
        'Preview must not instantiate ClipStorageBootReconcilerService',
      );
    });
    const auditFactory = jest.fn(() => {
      throw new Error('Preview must not instantiate MediaDownloadAuditService');
    });
    const channelFactory = jest.fn(() => {
      throw new Error('Preview must not instantiate ALERT_CHANNEL_PORT');
    });
    const snapshotWriter = jest.fn((path: string, content: string): void =>
      writeFileSync(path, content),
    );
    let app: INestApplication | undefined;
    try {
      process.env = {
        NODE_ENV: 'test',
        FRONT_ORIGINS: 'http://localhost:3000',
        SESSION_JWT_SECRET: 'openapi-generation-session-secret-32-characters',
        UPDATE_OPENAPI: updateOpenApi ? '1' : '0',
      };
      const { AppModule } = jest.requireActual<typeof AppModuleTypes>(
        '../src/app.module.js',
      );
      const { createOpenApiDocument } = jest.requireActual<
        typeof OpenApiModuleTypes
      >('../src/openapi/adapters/openapi-document.adapter.js');
      const { PrismaService } = jest.requireActual<typeof PrismaModuleTypes>(
        '../src/prisma/prisma.service.js',
      );
      const { ClipStorageService } = jest.requireActual<
        typeof ClipStorageModuleTypes
      >('../src/media/services/clip-storage.service.js');
      const { ClipStorageBootReconcilerService } = jest.requireActual<
        typeof ClipBootModuleTypes
      >('../src/media/services/clip-storage-boot-reconciler.service.js');
      const { MediaDownloadAuditService } = jest.requireActual<
        typeof DownloadAuditModuleTypes
      >('../src/media/services/media-download-audit.service.js');
      const { ALERT_CHANNEL_PORT } = jest.requireActual<
        typeof ChannelModuleTypes
      >('../src/alerts/ports/channel.port.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useFactory({ factory: prismaFactory })
        .overrideProvider(ClipStorageService)
        .useFactory({ factory: storageFactory })
        .overrideProvider(ClipStorageBootReconcilerService)
        .useFactory({ factory: bootFactory })
        .overrideProvider(MediaDownloadAuditService)
        .useFactory({ factory: auditFactory })
        .overrideProvider(ALERT_CHANNEL_PORT)
        .useFactory({ factory: channelFactory })
        .compile({ preview: true });
      app = moduleRef.createNestApplication({ preview: true });
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
      const overlaid = createOpenApiDocument(app);
      // Same preview app without the published overlay. The DocumentBuilder
      // config mirrors the adapter's own (default title plus the app_session
      // cookie scheme) so raw and overlaid differ only by the merge step.
      const raw = SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle('Eldercare backend API')
          .addCookieAuth('app_session')
          .build(),
      );
      let published = readPublishedDocument();
      if (process.env.UPDATE_OPENAPI === '1') {
        published = overlaid;
        snapshotWriter(OPENAPI_PATH, `${JSON.stringify(overlaid, null, 2)}\n`);
      }
      // Overlay compatibility, not raw contract parity: published keys win on
      // collision, so this proves only that preview generation adds no path or
      // component schema the published contract lacks, and that published
      // AlertList plus the /api/v1/alerts 200 content still match the shape the
      // adapter forces. Colliding operation and schema bodies come verbatim
      // from the file, so they are not proof that code reproduces them.
      expect(published).toEqual(overlaid);
      for (const path of RAW_OWNED_PATHS) {
        expect(raw.paths[path]).toBeDefined();
      }
      for (const schema of RAW_OWNED_SCHEMAS) {
        expect(raw.components?.schemas?.[schema]).toBeDefined();
      }
      expect(overlaid.components?.schemas?.[OVERLAY_ONLY_SCHEMA]).toBeDefined();
      // Negatives stay on the overlaid document because it is the union of raw
      // and published keys, so absence there proves absence in both. The string
      // scan is therefore an assertion about the merged artifact.
      for (const path of RETIRED_VALIDATION_PATHS) {
        expect(overlaid.paths[path]).toBeUndefined();
        expect(published).not.toHaveProperty(['paths', path]);
      }
      for (const schema of RETIRED_VALIDATION_SCHEMAS) {
        expect(overlaid.components?.schemas?.[schema]).toBeUndefined();
        expect(published).not.toHaveProperty(['components', 'schemas', schema]);
      }
      expect(JSON.stringify(overlaid)).not.toContain('SYSTEM_TEST');
    } finally {
      try {
        // TestingModule.close() does not inherit compile's preview option.
        // Only the preview application may dispatch shutdown hooks.
        await app?.close();
      } finally {
        process.env = previousEnv;
        if (previousBigIntToJSON === undefined) {
          Reflect.deleteProperty(BigInt.prototype, 'toJSON');
        } else {
          Object.defineProperty(
            BigInt.prototype,
            'toJSON',
            previousBigIntToJSON,
          );
        }
      }
      expect(prismaFactory).not.toHaveBeenCalled();
      expect(storageFactory).not.toHaveBeenCalled();
      expect(bootFactory).not.toHaveBeenCalled();
      expect(auditFactory).not.toHaveBeenCalled();
      expect(channelFactory).not.toHaveBeenCalled();
      if (!updateOpenApi) expect(snapshotWriter).not.toHaveBeenCalled();
    }
  });
});

function readPublishedDocument(): unknown {
  return JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'));
}
