import { createHash } from 'node:crypto';
import request from 'supertest';
import {
  EVENT_MEDIA_EDGE_TOKEN,
  EventMediaHarness,
} from './helpers/event-media-harness.js';
import {
  createEventMediaStorage,
  type RealEventMediaStorage,
} from './helpers/event-media-storage.js';

const EDGE_EVENT = 'a23e4567-e89b-42d3-a456-426614174009';

describe('event media READY body replay', () => {
  const harness = new EventMediaHarness();
  let storage: RealEventMediaStorage | null = null;

  beforeAll(() => harness.connect());
  beforeEach(() => harness.cleanup());
  afterEach(async () => {
    await harness.stop();
    await harness.cleanup();
    if (storage !== null) await storage.cleanup();
    storage = null;
  });
  afterAll(() => harness.disconnect());

  it('validates every exact replay body and drains rejected keep-alive requests', async () => {
    // Given: one READY clip persisted through a reusable HTTP agent.
    storage = await createEventMediaStorage();
    await harness.start(storage.service);
    const graph = await harness.seedGraph('body-replay');
    await harness
      .postEvent({
        cameraId: graph.cameraId,
        edgeEventId: EDGE_EVENT,
        detectedAt: '2026-07-16T00:00:00.000Z',
      })
      .expect(201);
    const agent = request.agent(harness.app.getHttpServer());
    const body = Buffer.from('replay-body-h264');
    const sha256 = digest(body);
    const upload = (payload: Buffer, declaredSize = payload.length) =>
      agent
        .put('/api/v1/events/clips/clip-body-replay')
        .set('Authorization', `Bearer ${EVENT_MEDIA_EDGE_TOKEN}`)
        .set('Content-Type', 'video/mp4')
        .set('x-edge-camera-id', graph.cameraId)
        .set('x-edge-event-refs', JSON.stringify([EDGE_EVENT]))
        .set('x-clip-start-at', '2026-07-16T00:00:00.000Z')
        .set('x-clip-end-at', '2026-07-16T00:00:01.000Z')
        .set('x-clip-finalized-at', '2026-07-16T00:00:02.000Z')
        .set('x-clip-sha256', sha256)
        .set('x-clip-size-bytes', String(declaredSize))
        .set('x-clip-duration-ms', '1000')
        .set('x-clip-state-version', '1')
        .send(payload);
    await upload(body).expect(200);

    // When: exact manifest replays send bad checksum, short, then valid bodies.
    await upload(Buffer.alloc(body.length, 0x78)).expect(422);
    await upload(Buffer.from('short'), body.length).expect(422);
    const replay = await upload(body).expect(200);

    // Then: each body was consumed and only the confirmed immutable file remains.
    expect(replay.body).toEqual({
      clip_id: 'clip-body-replay',
      state: 'READY',
      state_version: 1,
      sha256,
      size_bytes: body.length,
    });
    const clip = await harness.direct.mediaClip.findFirstOrThrow({
      where: { externalClipId: 'clip-body-replay' },
    });
    await expect(storage.listFiles()).resolves.toEqual([
      `${graph.facilityId}/${clip.id}/${sha256}.mp4`,
    ]);
  });
});

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
