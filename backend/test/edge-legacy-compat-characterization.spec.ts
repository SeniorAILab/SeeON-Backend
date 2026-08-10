import { join } from 'node:path';
import request from 'supertest';
import {
  assertFrozenErrorEnvelope,
  assertFrozenSuccessEnvelope,
  canonicalizeJson,
  EDGE_PROVISIONING_FIXTURE_SHA256,
  FixtureContractError,
  loadEdgeProvisioningFixtures,
  parseEdgeProvisioningFixtures,
  sha256CanonicalJson,
  type JsonValue,
} from './helpers/edge-contract-fixtures.js';
import {
  createEdgeLegacyFixture,
  EDGE_LEGACY_TOKEN,
  type EdgeLegacyFixture,
} from './helpers/edge-legacy-fixture.js';
import {
  mapLegacyCamera,
  postLegacyEvent,
  reportLegacyUnavailable,
} from './helpers/edge-legacy-requests.js';

const fixturesPath = join(
  __dirname,
  'fixtures',
  'edge-provisioning-v1',
  'contract-fixtures.json',
);
const eventIds = {
  first: 'f0d280cd-f900-48f2-bd73-96c10c147d20',
  second: '0cc338f4-3d60-429f-a697-1b8aa0731e11',
  missing: '83d9a2cc-e898-4b83-a4a3-ae619c2b9285',
} as const;

describe('edge provisioning fixture contract', () => {
  it('loads the frozen fixture corpus with RFC 8785 canonicalization and digest drift detection', () => {
    // Given: RFC 8785 ordering, Unicode, number, and nested-structure vectors.
    const vectors: readonly {
      readonly value: JsonValue;
      readonly expected: string;
    }[] = [
      { value: { z: 1, a: 2 }, expected: '{"a":2,"z":1}' },
      {
        value: { '€': 'Euro', '😀': 'Smile', a: 'Latin' },
        expected: '{"a":"Latin","€":"Euro","😀":"Smile"}',
      },
      {
        value: {
          tiny: 1e-7,
          small: 0.000001,
          integer: 1,
          large: 1e30,
          zero: -0,
        },
        expected:
          '{"integer":1,"large":1e+30,"small":0.000001,"tiny":1e-7,"zero":0}',
      },
      {
        value: {
          object: { z: 'last', a: false },
          array: [{ b: 2, a: 1 }, true, null],
        },
        expected:
          '{"array":[{"a":1,"b":2},true,null],"object":{"a":false,"z":"last"}}',
      },
    ];

    // When: the committed corpus and each JCS vector are canonicalized.
    const loaded = loadEdgeProvisioningFixtures(fixturesPath);

    // Then: recorded bytes are stable and a semantic change moves the digest.
    expect(loaded.digest).toBe(EDGE_PROVISIONING_FIXTURE_SHA256);
    for (const vector of vectors) {
      expect(canonicalizeJson(vector.value)).toBe(vector.expected);
    }
    expect(sha256CanonicalJson({ value: 'before' })).not.toBe(
      sha256CanonicalJson({ value: 'after' }),
    );
    const happy = readObject(loaded.document.happy, 'happy');
    assertFrozenSuccessEnvelope(
      readObject(happy['topology.put'], 'topology.put').response,
    );
    for (const rejection of Object.values(
      readObject(loaded.document.rejections, 'rejections'),
    )) {
      const rejectionRecord = readObject(rejection, 'rejection');
      assertFrozenErrorEnvelope({
        schemaVersion: 1,
        error: rejectionRecord.error,
      });
    }
  });

  it('rejects malformed fixture structures and invalid JCS values deterministically', () => {
    // Given: malformed corpus data and values outside RFC 8785's JSON domain.
    const malformed = {
      metadata: {
        sourceVersion: 'edge-provisioning-v1',
        canonicalization: 'RFC 8785 JSON Canonicalization Scheme (JCS)',
        digestAlgorithm: 'SHA-256',
        canonicalSha256: 'f'.repeat(64),
      },
      happy: {},
      rejections: {},
    };

    // When: the fixture parser and canonicalizer receive malformed values.
    const parseMalformed = () => parseEdgeProvisioningFixtures(malformed);
    const canonicalizeNonFinite = () => canonicalizeJson({ value: Number.NaN });
    const canonicalizeUnpairedSurrogate = () =>
      canonicalizeJson({ value: '\ud800' });

    // Then: each violation has the typed deterministic contract failure.
    expect(parseMalformed).toThrow(FixtureContractError);
    expect(canonicalizeNonFinite).toThrow(FixtureContractError);
    expect(canonicalizeUnpairedSurrogate).toThrow(FixtureContractError);
  });
});

describe('current legacy edge route compatibility', () => {
  let fixture: EdgeLegacyFixture | null = null;

  beforeAll(async () => {
    fixture = await createEdgeLegacyFixture();
  });

  afterAll(async () => {
    if (fixture !== null) await fixture.close();
  });

  it('accepts the shared legacy relay token while deriving edge-camera scope from its header', async () => {
    // Given: two persisted facility graphs and one shared legacy token.
    const current = requireFixture(fixture);
    const mapped = await request(current.app.getHttpServer())
      .put('/api/v1/edge/cameras')
      .set('x-edge-relay-token', EDGE_LEGACY_TOKEN)
      .set('x-facility-id', current.first.facilityId)
      .send({
        edge_camera_ref: 'legacy-camera-a',
        label: 'Legacy Camera A',
        spaceId: current.first.spaceId,
      })
      .expect(200);

    // When: the other facility header targets a foreign or absent space.
    const foreign = await mapLegacyCamera(current, current.first.spaceId);
    const missing = await mapLegacyCamera(
      current,
      `${current.first.spaceId}-missing`,
    );

    // Then: mapping belongs to the header facility and denial is non-disclosing.
    expect(mapped.body).toMatchObject({
      facilityId: current.first.facilityId,
      spaceId: current.first.spaceId,
    });
    expect(foreign.status).toBe(409);
    expect(missing.status).toBe(409);
    expect(foreign.body).toEqual(missing.body);
  });

  it('derives event and snapshot ownership from persisted camera and event records while ml-config follows its path', async () => {
    // Given: a request names facility B while addressing camera A.
    const current = requireFixture(fixture);
    const created = await postLegacyEvent(current, {
      cameraId: current.first.cameraId,
      edgeEventId: eventIds.first,
      ignoredFacilityId: current.second.facilityId,
    });
    const eventId = readResponseId(created.body);

    // When: legacy event, heartbeat, snapshot, and config routes use the shared token.
    const heartbeat = await request(current.app.getHttpServer())
      .post('/api/v1/events/heartbeat')
      .set('Authorization', `Bearer ${EDGE_LEGACY_TOKEN}`)
      .set('x-facility-id', current.second.facilityId)
      .send({ camera_id: current.first.cameraId })
      .expect(200);
    const snapshot = await request(current.app.getHttpServer())
      .put(`/api/v1/events/${eventId}/snapshot`)
      .set('Authorization', `Bearer ${EDGE_LEGACY_TOKEN}`)
      .set('Content-Type', 'image/jpeg')
      .set('x-facility-id', current.second.facilityId)
      .send(Buffer.from('current-legacy-snapshot'))
      .expect(201);
    const config = await request(current.app.getHttpServer())
      .get(`/api/v1/ml-config/${current.second.facilityId}`)
      .set('Authorization', `Bearer ${EDGE_LEGACY_TOKEN}`)
      .expect(200);

    // Then: server ownership wins for camera/event data while config remains path-scoped.
    expect(created.status).toBe(201);
    await expect(
      current.direct.event.findUniqueOrThrow({ where: { id: eventId } }),
    ).resolves.toMatchObject({ facilityId: current.first.facilityId });
    expect(heartbeat.body).toEqual({ ok: true });
    await expect(
      current.direct.camera.findUniqueOrThrow({
        where: { id: current.first.cameraId },
      }),
    ).resolves.toMatchObject({ online: true });
    expect(snapshot.body).toEqual({
      snapshotKey: `${current.first.facilityId}/${eventId}.jpg`,
    });
    const cameraIds = readArray(
      readObject(config.body, 'ml config response').cameras,
      'ml config cameras',
    ).map((camera) => readResponseId(camera));
    expect(cameraIds).toContain(current.second.cameraId);
  });

  it('rejects foreign media event references with the same response as absent references', async () => {
    // Given: one accepted event for each facility-owned camera.
    const current = requireFixture(fixture);
    await postLegacyEvent(current, {
      cameraId: current.second.cameraId,
      edgeEventId: eventIds.second,
    });

    // When: camera A reports a clip with a foreign event and then an absent event.
    const foreign = await reportLegacyUnavailable(
      current,
      'legacy-foreign',
      eventIds.second,
    );
    const missing = await reportLegacyUnavailable(
      current,
      'legacy-missing',
      eventIds.missing,
    );
    const allowed = await reportLegacyUnavailable(
      current,
      'legacy-owned',
      eventIds.first,
    );

    // Then: ownership is persisted for the allowed request and hidden for denied ones.
    expect(foreign.status).toBe(409);
    expect(missing.status).toBe(409);
    expect(foreign.body).toEqual(missing.body);
    expect(allowed.status).toBe(200);
    await expect(
      current.direct.mediaClip.findFirstOrThrow({
        where: { externalClipId: 'legacy-owned' },
      }),
    ).resolves.toMatchObject({
      facilityId: current.first.facilityId,
      status: 'UNAVAILABLE',
    });
  });
});

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new FixtureContractError(`${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value))
    throw new FixtureContractError(`${label} must be an array`);
  return value;
}

function readResponseId(value: unknown): string {
  const id = readObject(value, 'event response').id;
  if (typeof id !== 'string')
    throw new FixtureContractError('event response id must be a string');
  return id;
}

function requireFixture(fixture: EdgeLegacyFixture | null): EdgeLegacyFixture {
  if (fixture === null)
    throw new FixtureContractError('legacy fixture was not created');
  return fixture;
}
