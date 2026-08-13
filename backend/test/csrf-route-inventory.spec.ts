import type { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { EdgeFacilityTokenGuard } from '../src/cameras/edge-facility-token.guard.js';
import { EdgeCamerasController } from '../src/cameras/cameras.controller.js';
import { EdgeEnrollmentController } from '../src/edge-credentials/edge-credential.controller.js';
import { EdgeEnrollmentGuard } from '../src/edge-credentials/edge-enrollment.guard.js';
import { EdgeTopologyController } from '../src/edge-topology/edge-topology.controller.js';
import { EventsController } from '../src/events/events.controller.js';
import { EdgeIngestTokenGuard } from '../src/events/edge-ingest-token.guard.js';
import { EdgeMediaController } from '../src/media/edge-media.controller.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { CSRF_ROUTE_INVENTORY } from '../src/security/csrf-route-inventory.js';
import { SKIP_CSRF_METADATA_KEY } from '../src/security/skip-csrf.decorator.js';
import { configureVersionedTestApp } from './helpers/versioned-app.js';

const prismaDouble = {
  onModuleInit: jest.fn(),
  onModuleDestroy: jest.fn(),
  db: {
    mediaDownloadProcessHeartbeat: { upsert: jest.fn(), updateMany: jest.fn() },
  },
};

describe('compiled CSRF route inventory', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.SESSION_JWT_SECRET =
      'test-session-secret-minimum-32-characters';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaDouble)
      .compile();
    app = moduleRef.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();
  });

  afterAll(async () => app.close());

  it('matches all 66 compiled application routes and explicit classifications', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('inventory').build(),
    );
    const compiled = new Set<string>();
    for (const [path, item] of Object.entries(document.paths)) {
      if (path === '/api/docs' || path.startsWith('/api/docs/')) continue;
      for (const method of Object.keys(item)) {
        if (method === 'parameters') continue;
        compiled.add(`${method.toUpperCase()} ${normalizePath(path)}`);
      }
    }
    const expected = new Set(
      CSRF_ROUTE_INVENTORY.map(([method, path]) => `${method} ${path}`),
    );
    expect([...compiled].sort()).toEqual([...expected].sort());
    expect(CSRF_ROUTE_INVENTORY).toHaveLength(66);
    expect(
      CSRF_ROUTE_INVENTORY.filter((route) => route[2] === 'BROWSER'),
    ).toHaveLength(31);
    expect(
      CSRF_ROUTE_INVENTORY.filter((route) => route[2] === 'EDGE'),
    ).toHaveLength(9);
  });

  it.each([
    [EdgeCamerasController, 'upsert', EdgeFacilityTokenGuard],
    [EdgeEnrollmentController, 'verify', EdgeEnrollmentGuard],
    [EdgeTopologyController, 'apply', EdgeFacilityTokenGuard],
    [EdgeTopologyController, 'confirm', EdgeFacilityTokenGuard],
    [EventsController, 'record', EdgeIngestTokenGuard],
    [EventsController, 'heartbeat', EdgeIngestTokenGuard],
    [EventsController, 'uploadSnapshot', EdgeIngestTokenGuard],
    [EdgeMediaController, 'uploadReady', EdgeIngestTokenGuard],
    [EdgeMediaController, 'reportUnavailable', EdgeIngestTokenGuard],
  ] as const)(
    '%s.%s has explicit skip metadata and its approved credential guard',
    (controller, method, guard) => {
      const prototype = controller.prototype as unknown as Record<
        string,
        unknown
      >;
      const handler = prototype[method];
      if (typeof handler !== 'function') {
        throw new Error(`Missing inventory handler: ${method}`);
      }
      const methodSkip = metadata(SKIP_CSRF_METADATA_KEY, handler);
      const skip =
        methodSkip === undefined
          ? metadata(SKIP_CSRF_METADATA_KEY, controller)
          : methodSkip;
      const classGuards = metadata(GUARDS_METADATA, controller);
      const methodGuards = metadata(GUARDS_METADATA, handler);
      const guards = unknownArray(classGuards).concat(
        unknownArray(methodGuards),
      );
      expect(skip).toBe(true);
      expect(guards).toContain(guard);
    },
  );
});

function unknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function metadata(key: string, target: object): unknown {
  return Reflect.getMetadata(key, target) as unknown;
}

function normalizePath(path: string): string {
  return path.replaceAll(/\{([^}]+)\}/g, ':$1');
}
