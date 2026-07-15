import request from 'supertest';
import {
  EVENT_MEDIA_EDGE_TOKEN,
  EventMediaHarness,
} from './helpers/event-media-harness.js';

const EDGE_EVENT_A = '123e4567-e89b-42d3-a456-426614174000';
const EDGE_EVENT_B = '223e4567-e89b-42d3-a456-426614174001';
const EDGE_EVENT_C = '323e4567-e89b-42d3-a456-426614174002';
const SHA256_A = 'a'.repeat(64);
const SHA256_B = 'b'.repeat(64);

describe('edge event media ingest', () => {
  const harness = new EventMediaHarness();

  beforeAll(() => harness.connect());
  beforeEach(async () => {
    await harness.cleanup();
    await harness.start();
  });
  afterEach(async () => {
    await harness.stop();
    await harness.cleanup();
  });
  afterAll(() => harness.disconnect());

  it('authenticates capability probes and advertises capacity conservatively', async () => {
    // Given: one camera and a storage volume above its reserve.
    const graph = await harness.seedGraph('capability');

    // When: an unauthenticated probe, then an authenticated probe, is sent.
    await request(harness.app.getHttpServer())
      .get('/api/v1/events/capabilities')
      .query({ camera_id: graph.cameraId })
      .expect(401);
    const available = await request(harness.app.getHttpServer())
      .get('/api/v1/events/capabilities')
      .set('Authorization', `Bearer ${EVENT_MEDIA_EDGE_TOKEN}`)
      .query({ camera_id: graph.cameraId })
      .expect(200);

    // Then: event idempotency and locally proven clip capacity are explicit.
    expect(available.body).toEqual({ event_idempotency: 1, clip_export: 1 });
    harness.canAcceptMaximumClip.mockResolvedValueOnce(false);
    const lowWater = await request(harness.app.getHttpServer())
      .get('/api/v1/events/capabilities')
      .set('Authorization', `Bearer ${EVENT_MEDIA_EDGE_TOKEN}`)
      .query({ camera_id: graph.cameraId })
      .expect(200);
    expect(lowWater.body).toEqual({ event_idempotency: 1, clip_export: 0 });
  });

  it('accepts exact edge event replays and rejects immutable mismatches', async () => {
    // Given: a camera-owned stable edge identity.
    const graph = await harness.seedGraph('event-idempotency');
    const input = {
      cameraId: graph.cameraId,
      edgeEventId: EDGE_EVENT_A,
      detectedAt: '2026-07-16T00:00:00.000Z',
    };

    // When: the same event is delivered twice, then mutated under the UUID.
    const first = await harness.postEvent(input).expect(201);
    const replay = await harness.postEvent(input).expect(201);
    await harness
      .postEvent({ ...input, detectedAt: '2026-07-16T00:00:01.000Z' })
      .expect(409);

    // Then: both receipts ACK one durable backend event.
    const firstBody = readAcceptedEvent(first.body);
    const replayBody = readAcceptedEvent(replay.body);
    expect(firstBody).toEqual({
      id: firstBody.id,
      event_id: firstBody.id,
      edge_event_id: EDGE_EVENT_A,
      status: 'accepted',
    });
    expect(replayBody).toEqual(firstBody);
    await expect(
      harness.direct.event.count({ where: { edgeEventId: EDGE_EVENT_A } }),
    ).resolves.toBe(1);
  });

  it('binds many events to one immutable READY clip and rejects rebinding', async () => {
    // Given: two event-first ACKs from one camera and one finalized payload.
    const graph = await harness.seedGraph('ready');
    await harness
      .postEvent({
        cameraId: graph.cameraId,
        edgeEventId: EDGE_EVENT_A,
        detectedAt: '2026-07-16T00:00:00.000Z',
      })
      .expect(201);
    await harness
      .postEvent({
        cameraId: graph.cameraId,
        edgeEventId: EDGE_EVENT_B,
        detectedAt: '2026-07-16T00:00:01.000Z',
      })
      .expect(201);
    const body = Buffer.from('h264-payload');

    // When: the clip is uploaded, replayed, then reused with changed identity.
    const ready = await harness
      .uploadReady({
        clipId: 'clip-ready-a',
        cameraId: graph.cameraId,
        eventRefs: [EDGE_EVENT_A, EDGE_EVENT_B],
        sha256: SHA256_A,
        body,
      })
      .expect(200);
    await harness
      .uploadReady({
        clipId: 'clip-ready-a',
        cameraId: graph.cameraId,
        eventRefs: [EDGE_EVENT_A, EDGE_EVENT_B],
        sha256: SHA256_A,
        body,
      })
      .expect(200);
    await harness
      .uploadReady({
        clipId: 'clip-ready-a',
        cameraId: graph.cameraId,
        eventRefs: [EDGE_EVENT_A, EDGE_EVENT_B],
        sha256: SHA256_B,
        body,
      })
      .expect(409);
    await harness
      .uploadReady({
        clipId: 'clip-ready-b',
        cameraId: graph.cameraId,
        eventRefs: [EDGE_EVENT_A],
        sha256: SHA256_B,
        body,
      })
      .expect(409);

    // Then: the public receipt leaks no internal id/path and bindings converge.
    expect(ready.body).toEqual({
      clip_id: 'clip-ready-a',
      state: 'READY',
      state_version: 1,
      sha256: SHA256_A,
      size_bytes: body.length,
    });
    expect(ready.body).not.toHaveProperty('storageKey');
    expect(ready.body).not.toHaveProperty('id');
    expect(harness.persist).toHaveBeenCalledTimes(2);
    const clip = await harness.direct.mediaClip.findUniqueOrThrow({
      where: {
        facilityId_externalClipId: {
          facilityId: graph.facilityId,
          externalClipId: 'clip-ready-a',
        },
      },
      include: { events: true },
    });
    expect(clip.status).toBe('READY');
    expect(clip.events).toHaveLength(2);
    expect(clip.expiresAt?.toISOString()).toBe('2026-09-14T00:00:02.000Z');
  });

  it('records an immutable UNAVAILABLE terminal state without cross-facility binding', async () => {
    // Given: events exist in two separately owned camera facilities.
    const first = await harness.seedGraph('unavailable-a');
    const second = await harness.seedGraph('unavailable-b');
    await harness
      .postEvent({
        cameraId: first.cameraId,
        edgeEventId: EDGE_EVENT_A,
        detectedAt: '2026-07-16T01:00:00.000Z',
      })
      .expect(201);
    await harness
      .postEvent({
        cameraId: second.cameraId,
        edgeEventId: EDGE_EVENT_C,
        detectedAt: '2026-07-16T01:00:01.000Z',
      })
      .expect(201);
    const state = {
      camera_id: first.cameraId,
      event_refs: [EDGE_EVENT_A],
      state_version: 1,
      reason: 'CAPTURE_FAILED',
    };

    // When: UNAVAILABLE is replayed, changed, and given a foreign event ref.
    const report = () =>
      request(harness.app.getHttpServer())
        .put('/api/v1/events/clips/clip-unavailable/state')
        .set('Authorization', `Bearer ${EVENT_MEDIA_EDGE_TOKEN}`)
        .send(state);
    const unavailable = await report().expect(200);
    await report().expect(200);
    await request(harness.app.getHttpServer())
      .put('/api/v1/events/clips/clip-unavailable/state')
      .set('Authorization', `Bearer ${EVENT_MEDIA_EDGE_TOKEN}`)
      .send({ ...state, reason: 'QUEUE_FULL' })
      .expect(409);
    await request(harness.app.getHttpServer())
      .put('/api/v1/events/clips/clip-foreign/state')
      .set('Authorization', `Bearer ${EVENT_MEDIA_EDGE_TOKEN}`)
      .send({ ...state, event_refs: [EDGE_EVENT_C] })
      .expect(409);

    // Then: only the original facility event owns the durable terminal row.
    expect(unavailable.body).toEqual({
      clip_id: 'clip-unavailable',
      state: 'UNAVAILABLE',
      state_version: 1,
    });
    await expect(
      harness.direct.mediaClip.findFirstOrThrow({
        where: { externalClipId: 'clip-unavailable' },
      }),
    ).resolves.toMatchObject({
      facilityId: first.facilityId,
      status: 'UNAVAILABLE',
      reason: 'CAPTURE_FAILED',
    });
  });
});

interface AcceptedEvent {
  readonly id: string;
  readonly event_id: string;
  readonly edge_event_id: string;
  readonly status: string;
}

function readAcceptedEvent(value: unknown): AcceptedEvent {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('event_id' in value) ||
    typeof value.event_id !== 'string' ||
    !('edge_event_id' in value) ||
    typeof value.edge_event_id !== 'string' ||
    !('status' in value) ||
    typeof value.status !== 'string'
  ) {
    throw new Error('invalid accepted event response');
  }
  return {
    id: value.id,
    event_id: value.event_id,
    edge_event_id: value.edge_event_id,
    status: value.status,
  };
}
