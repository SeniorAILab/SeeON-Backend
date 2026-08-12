import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import type {
  AlertDetailWithContext,
  AlertWithContext,
} from '../src/alerts/alerts.presenter.js';
import {
  presentAlert,
  presentAlertDetail,
} from '../src/alerts/alerts.presenter.js';
import {
  formatAlertEvent,
  formatAlertUpdateEvent,
} from '../src/dashboard/sse.controller.js';
import { CSRF_ROUTE_INVENTORY } from '../src/security/csrf-route-inventory.js';

const openApi = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', 'docs', 'openapi', 'v1.json'),
    'utf8',
  ),
) as OpenApiDocument;

const SYSTEM_TEST_PATHS = [
  ['GET', '/api/v1/alerts'],
  ['GET', '/api/v1/alerts/{id}'],
  ['PATCH', '/api/v1/alerts/{id}/resolve'],
  ['GET', '/api/v1/dashboard/stream'],
  ['POST', '/api/v1/admin/system-test-retention/purge'],
] as const;

describe('SYSTEM_TEST OpenAPI runtime conformance', () => {
  it.each(['NEW', 'ACKED', 'RESOLVED'] as const)(
    'validates a real %s presenter result with no undocumented properties',
    (status) => {
      const validate = validatorFor('SystemTestAlert');
      const wire = toWire(presentAlert(systemTestSample(status)));

      expect(validate(wire)).toBe(true);
      expect(validate.errors).toBeNull();
      expect(validatorFor('Alert')(wire)).toBe(true);
    },
  );

  it('validates ordinary list and SYSTEM_TEST detail presenter DTOs', () => {
    const ordinary = toWire(presentAlert(ordinarySample()));
    expect(validatorFor('NormalAlert')(ordinary)).toBe(true);
    expect(validatorFor('AlertList')([ordinary])).toBe(true);

    const detail = toWire(presentAlertDetail(systemTestDetailSample()));
    expect(validatorFor('AlertDetail')(detail)).toBe(true);
  });

  it('rejects an undocumented field from the exact SYSTEM_TEST Alert DTO', () => {
    const wire = {
      ...(toWire(presentAlert(systemTestSample('NEW'))) as object),
      camera: { id: 'not-runtime-output' },
    };
    expect(validatorFor('SystemTestAlert')(wire)).toBe(false);
  });

  it('validates actual dashboard alert and lifecycle SSE data', () => {
    const alertData = parseSseData(formatAlertEvent(systemTestSample('NEW')));
    expect(validatorFor('DashboardAlertSseData')(alertData)).toBe(true);

    const updateData = parseSseData(
      formatAlertUpdateEvent({
        id: 'alert-system-test-17',
        alertSeq: 17n,
        facilityId: 'facility-contract',
        spaceId: null,
        status: 'RESOLVED',
        ackedById: null,
        ackedAt: null,
        resolvedById: 'operator-1',
        resolvedAt: new Date('2026-08-01T00:02:00.000Z'),
      }),
    );
    expect(validatorFor('AlertUpdatedSseData')(updateData)).toBe(true);
  });

  it('advertises the real alert list/read/resolve, SSE, and retention operations', () => {
    for (const [method, path] of SYSTEM_TEST_PATHS) {
      const operation = openApi.paths[path]?.[method.toLowerCase()];
      expect(operation).toBeDefined();
      expect(
        CSRF_ROUTE_INVENTORY.some(
          ([actualMethod, actualPath]) =>
            actualMethod === method && normalize(actualPath) === path,
        ),
      ).toBe(true);
    }

    expect(responseSchema('/api/v1/alerts', 'get', '200')).toBe(
      '#/components/schemas/AlertList',
    );
    expect(responseSchema('/api/v1/alerts/{id}', 'get', '200')).toBe(
      '#/components/schemas/AlertDetail',
    );
    expect(responseSchema('/api/v1/alerts/{id}/resolve', 'patch', '200')).toBe(
      '#/components/schemas/Alert',
    );
    expect(
      requestSchema('/api/v1/admin/system-test-retention/purge', 'post'),
    ).toBe('#/components/schemas/PurgeSystemTestRetentionRequest');
    expect(
      responseSchema(
        '/api/v1/admin/system-test-retention/purge',
        'post',
        '200',
      ),
    ).toBe('#/components/schemas/PurgeSystemTestRetentionResponse');

    const stream = openApi.paths['/api/v1/dashboard/stream']?.get;
    expect(
      stream?.responses?.['200']?.content?.['text/event-stream'],
    ).toBeDefined();
    expect(stream?.['x-sse-event-schemas']).toEqual({
      alert: '#/components/schemas/DashboardAlertSseData',
      'alert-updated': '#/components/schemas/AlertUpdatedSseData',
    });
  });
});

function validatorFor(name: string) {
  const schemas = JSON.parse(
    JSON.stringify(openApi.components.schemas).replaceAll(
      '#/components/schemas/',
      '#/$defs/',
    ),
  ) as Record<string, unknown>;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });
  ajv.addKeyword({ keyword: 'example' });
  return ajv.compile({ $ref: `#/$defs/${name}`, $defs: schemas });
}

function responseSchema(path: string, method: string, status: string): unknown {
  return openApi.paths[path]?.[method]?.responses?.[status]?.content?.[
    'application/json'
  ]?.schema?.$ref;
}

function requestSchema(path: string, method: string): unknown {
  return openApi.paths[path]?.[method]?.requestBody?.content?.[
    'application/json'
  ]?.schema?.$ref;
}

function normalize(path: string): string {
  return path.replaceAll(/:([^/]+)/g, '{$1}');
}

function toWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function parseSseData(frame: string): unknown {
  const line = frame.split('\n').find((entry) => entry.startsWith('data: '));
  if (line === undefined) throw new Error('SSE frame has no data line');
  return JSON.parse(line.slice('data: '.length)) as unknown;
}

function systemTestSample(
  status: 'NEW' | 'ACKED' | 'RESOLVED',
): AlertWithContext {
  const actor = { nickname: 'Operator' };
  return {
    alertSeq: 17n,
    id: 'alert-system-test-17',
    facilityId: 'facility-contract',
    cameraId: null,
    spaceId: null,
    type: 'SYSTEM_TEST',
    probability: null,
    snapshotKey: null,
    detectedAt: new Date('2026-08-01T00:00:00.000Z'),
    status,
    idempotencyKey: 'system-test-contract',
    originEventId: 'event-system-test-17',
    createdAt: new Date('2026-08-01T00:00:01.000Z'),
    ackedById: status === 'ACKED' ? 'operator-1' : null,
    ackedAt: status === 'ACKED' ? new Date('2026-08-01T00:01:00.000Z') : null,
    resolvedById: status === 'RESOLVED' ? 'operator-1' : null,
    resolvedAt:
      status === 'RESOLVED' ? new Date('2026-08-01T00:02:00.000Z') : null,
    space: null,
    ackedBy: status === 'ACKED' ? actor : null,
    resolvedBy: status === 'RESOLVED' ? actor : null,
  };
}

function ordinarySample(): AlertWithContext {
  return {
    ...systemTestSample('NEW'),
    id: 'alert-fall-18',
    originEventId: 'event-fall-18',
    cameraId: 'camera-1',
    spaceId: 'space-1',
    type: 'fall',
    probability: 0.97,
    snapshotKey: 'snapshots/fall-18.jpg',
    space: { name: 'Room 101' },
  };
}

function systemTestDetailSample(): AlertDetailWithContext {
  return {
    ...systemTestSample('RESOLVED'),
    notes: [
      {
        id: 'note-1',
        note: 'Verified system test',
        createdById: 'operator-1',
        authorRole: 'STAFF',
        createdAt: new Date('2026-08-01T00:03:00.000Z'),
      },
    ],
  };
}

type OpenApiOperation = {
  requestBody?: {
    content?: Record<string, { schema?: { $ref?: string } }>;
  };
  responses?: Record<
    string,
    {
      content?: Record<string, { schema?: { $ref?: string } }>;
    }
  >;
  'x-sse-event-schemas'?: Record<string, string>;
};

type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation> | undefined>;
  components: { schemas: Record<string, unknown> };
};
