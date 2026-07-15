import { EventMediaHarness } from './helpers/event-media-harness.js';

const EDGE_EVENT_A = '523e4567-e89b-42d3-a456-426614174004';
const EDGE_EVENT_B = '623e4567-e89b-42d3-a456-426614174005';
const SHA256 = 'd'.repeat(64);

describe('ordered event media bindings', () => {
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

  it('rejects a READY replay when event references are reversed', async () => {
    // Given: a READY clip owns two event references in producer order.
    const graph = await seedTwoEvents('reverse');
    const body = Buffer.from('ordered-h264');
    await harness
      .uploadReady({
        clipId: 'clip-ordered-reverse',
        cameraId: graph.cameraId,
        eventRefs: [EDGE_EVENT_A, EDGE_EVENT_B],
        sha256: SHA256,
        body,
      })
      .expect(200);

    // When: the same clip identity is replayed with reversed event_refs.
    const replay = harness.uploadReady({
      clipId: 'clip-ordered-reverse',
      cameraId: graph.cameraId,
      eventRefs: [EDGE_EVENT_B, EDGE_EVENT_A],
      sha256: SHA256,
      body,
    });

    // Then: ordered immutable identity rejects the replay permanently.
    await replay.expect(409);
  });

  async function seedTwoEvents(suffix: string) {
    const graph = await harness.seedGraph(suffix);
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
    return graph;
  }
});
