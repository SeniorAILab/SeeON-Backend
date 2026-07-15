import { EventMediaHarness } from './helpers/event-media-harness.js';

const EDGE_EVENT = '823e4567-e89b-42d3-a456-426614174007';
const SHA256 = 'f'.repeat(64);

describe('event media terminal replay state', () => {
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

  it('acknowledges an exact READY replay after retention expiration', async () => {
    // Given: a READY clip that has crossed its retention boundary.
    const graph = await seedReady('expired-replay');
    await harness
      .mediaService()
      .expireReady(
        graph.facilityId,
        'clip-expired-replay',
        new Date('2026-09-14T00:00:02.000Z'),
      );

    // When: the edge retries the exact immutable READY payload.
    const replay = await harness
      .uploadReady({
        clipId: 'clip-expired-replay',
        cameraId: graph.cameraId,
        eventRefs: [EDGE_EVENT],
        sha256: SHA256,
        body: Buffer.from('expired-replay-h264'),
      })
      .expect(200);

    // Then: the receipt reports the current terminal state and version.
    expect(replay.body).toEqual({
      clip_id: 'clip-expired-replay',
      state: 'EXPIRED',
      state_version: 2,
    });
    expect(harness.persist).toHaveBeenCalledTimes(2);
  });

  it('rejects a mutated READY replay after retention expiration', async () => {
    // Given: a READY clip that has crossed its retention boundary.
    const graph = await seedReady('expired-mutation');
    await harness
      .mediaService()
      .expireReady(
        graph.facilityId,
        'clip-expired-mutation',
        new Date('2026-09-14T00:00:02.000Z'),
      );

    // When: the edge reuses the identity with a changed checksum.
    const replay = harness.uploadReady({
      clipId: 'clip-expired-mutation',
      cameraId: graph.cameraId,
      eventRefs: [EDGE_EVENT],
      sha256: '0'.repeat(64),
      body: Buffer.from('expired-replay-h264'),
    });

    // Then: immutable identity rejects the mutation.
    await replay.expect(409);
  });

  async function seedReady(suffix: string) {
    const graph = await harness.seedGraph(suffix);
    await harness
      .postEvent({
        cameraId: graph.cameraId,
        edgeEventId: EDGE_EVENT,
        detectedAt: '2026-07-16T00:00:00.000Z',
      })
      .expect(201);
    await harness
      .uploadReady({
        clipId: `clip-${suffix}`,
        cameraId: graph.cameraId,
        eventRefs: [EDGE_EVENT],
        sha256: SHA256,
        body: Buffer.from('expired-replay-h264'),
      })
      .expect(200);
    return graph;
  }
});
