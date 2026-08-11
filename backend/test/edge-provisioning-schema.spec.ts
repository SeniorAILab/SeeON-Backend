import { join } from 'node:path';
import {
  assertNoRawCredential,
  expectSchemaCheck,
  loadArtifacts,
  openApiOperation,
  record,
  string,
  validateFixture,
  type SchemaCheck,
} from './helpers/edge-provisioning-schema';
const openApiPath = join(__dirname, '..', '..', 'docs', 'openapi', 'v1.json');
const fixturesPath = join(
  __dirname,
  'fixtures',
  'edge-provisioning-v1',
  'contract-fixtures.json',
);
const routes = `admin.issue post /api/v1/admin/edge-credentials
admin.list get /api/v1/admin/edge-credentials
admin.rotate post /api/v1/admin/edge-credentials/{tokenId}/rotate
admin.revoke post /api/v1/admin/edge-credentials/{tokenId}/revoke
admin.replace post /api/v1/admin/edge-installations/{edgeInstallationId}/replace
admin.recover-secret post /api/v1/admin/edge-operations/{operationId}/recover-secret
admin.transfer post /api/v1/admin/edge-installations/{edgeInstallationId}/transfers
admin.validation-run post /api/v1/admin/edge-installations/{edgeInstallationId}/validation-runs
edge.verify post /api/v1/edge/enrollments/verify
topology.put put /api/v1/edge/topology-snapshots/{snapshotId}
topology.confirm post /api/v1/edge/topology-snapshots/{snapshotId}/confirm
machine.edge-cameras.put put /api/v1/edge/cameras
machine.events.create post /api/v1/events
machine.events.heartbeat post /api/v1/events/heartbeat
machine.events.snapshot put /api/v1/events/{eventId}/snapshot
machine.ml-config.get get /api/v1/ml-config/{facilityId}
machine.events.capabilities.get get /api/v1/events/capabilities
machine.events.clips.put put /api/v1/events/clips/{clipId}
machine.events.clips.state.put put /api/v1/events/clips/{clipId}/state
admin.alert-media.download.get get /api/v1/alerts/{alertId}/media/download
admin.alert-media.download.head head /api/v1/alerts/{alertId}/media/download`
  .split('\n')
  .map((line) => {
    const [name, method, path] = line.split(' ');
    return [name, method, path] as const;
  });
const rejectionNames =
  'missing-schema-version wrong-schema-version duplicate-edge-refs duplicate-json-key two-cameras-in-one-room nonpositive-client-revision skipped-client-revision stale-server-revision stale-enrollment-generation facility-header-identity facility-body-identity unknown-field invalid-edge-ref rtsp-field camera-credential-field secret-shaped-field'.split(
    ' ',
  );
const errorCodes =
  'INVALID_SCHEMA INVALID_TOPOLOGY EDGE_CREDENTIAL_REQUIRED EDGE_CREDENTIAL_INVALID EDGE_CREDENTIAL_INACTIVE FACILITY_BINDING_MISMATCH INSTALLATION_CONFLICT IDEMPOTENCY_CONFLICT CLIENT_REVISION_OUT_OF_SEQUENCE STALE_SERVER_REVISION STALE_ENROLLMENT_GENERATION TOPOLOGY_CONFLICT TOPOLOGY_TRANSFER_CONFLICT LEGACY_MAPPING_REQUIRED CONFIRMATION_STALE CONFIRMATION_EXPIRED ENROLLMENT_RATE_LIMITED EDGE_AUTH_NOT_CONFIGURED'.split(
    ' ',
  );
const checks: readonly SchemaCheck[] = [
  {
    name: 'FacilityCode',
    field: 'pattern',
    expected: '^NH-[0-9A-HJKMNP-TV-Z]{10}$',
  },
  {
    name: 'EdgeBearerToken',
    field: 'pattern',
    expected: String.raw`^eft_v1\.[0-9A-HJKMNP-TV-Z]{12}\.[A-Za-z0-9_-]{43}$`,
  },
  {
    name: 'UuidV7',
    field: 'pattern',
    expected:
      '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  },
  {
    name: 'Rfc3339MillisUtc',
    field: 'pattern',
    expected: String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`,
  },
  {
    name: 'CredentialLifecycle',
    field: 'enum',
    expected: ['ACTIVE', 'GRACE', 'REVOKED', 'EXPIRED'],
  },
  { name: 'EdgeErrorCode', field: 'enum', expected: errorCodes },
  {
    name: 'SuccessEnvelope',
    field: 'required',
    expected:
      'schemaVersion snapshotId clientRevision serverRevision result omissions'.split(
        ' ',
      ),
    contains: true,
  },
  {
    name: 'ErrorEnvelope',
    field: 'required',
    expected: ['schemaVersion', 'error'],
    contains: true,
  },
];
const forbidden = [
  ['rtsp-field', 'rtspUrl'],
  ['camera-credential-field', 'cameraPassword'],
  ['secret-shaped-field', 'secret'],
] as const;
describe('edge provisioning v1 schema artifacts', () => {
  let artifacts: ReturnType<typeof loadArtifacts>;
  beforeAll(() => {
    artifacts = loadArtifacts(openApiPath, fixturesPath);
  });
  it('freezes versioned routes, identity formats, lifecycle values, and envelopes', () => {
    const paths = record(artifacts.openApi.paths, 'OpenAPI paths');
    for (const [, method, path] of routes) {
      expect(path.startsWith('/api/v1')).toBe(true);
      expect(record(paths[path], path)[method]).toBeDefined();
    }
    const schemas = record(
      record(artifacts.openApi.components, 'OpenAPI components').schemas,
      'OpenAPI schemas',
    );
    for (const check of checks) expectSchemaCheck(schemas, check);
  });
  it('contains complete redacted happy fixtures for every frozen v1 operation', () => {
    const happy = record(artifacts.fixtures.happy, 'happy fixtures');
    expect(Object.keys(happy).sort()).toEqual(
      routes.map(([name]) => name).sort(),
    );
    for (const [name, method, path] of routes) {
      const fixture = record(happy[name], `${name} happy fixture`);
      expect(string(fixture.method, `${name} method`)).toBe(
        method.toUpperCase(),
      );
      expect(string(fixture.path, `${name} path`)).toBe(path);
      expect(record(fixture.request, `${name} request`)).toBeDefined();
      expect(record(fixture.response, `${name} response`)).toBeDefined();
      validateFixture(
        openApiOperation(artifacts.openApi, method, path),
        fixture,
        artifacts.openApi,
        name,
      );
      assertNoRawCredential(fixture);
    }
    assertNoRawCredential(record(artifacts.fixtures.metadata, 'metadata'));
  });
  it('contains rejection fixtures for frozen schema, topology, identity, and secret boundaries', () => {
    const rejections = record(
      artifacts.fixtures.rejections,
      'rejection fixtures',
    );
    expect(Object.keys(rejections).sort()).toEqual([...rejectionNames].sort());
    for (const name of rejectionNames) {
      const rejection = record(rejections[name], `${name} rejection`);
      expect(rejection.valid).toBe(false);
      const error = record(rejection.error, `${name} error`);
      expect(typeof error.code).toBe('string');
      expect(typeof error.message).toBe('string');
      expect(typeof error.retryable).toBe('boolean');
      expect(typeof error.requestId).toBe('string');
    }
    expect(
      string(
        record(rejections['duplicate-json-key'], 'duplicate JSON key').rawJson,
        'duplicate JSON key raw payload',
      ),
    ).toMatch(/"edgeRef"[\s\S]*"edgeRef"/);
    for (const [name, field] of forbidden)
      expect(
        string(
          record(rejections[name], `${name} rejection`).forbiddenField,
          `${name} forbidden field`,
        ),
      ).toBe(field);
  });
  it('publishes source version and canonical fixture digest without raw credentials', () => {
    const metadata = record(artifacts.fixtures.metadata, 'fixture metadata');
    expect(string(metadata.sourceVersion, 'fixture source version')).toBe(
      'edge-provisioning-v1',
    );
    expect(
      string(metadata.canonicalSha256, 'fixture canonical digest'),
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.rawCredential).toBeUndefined();
  });
});
