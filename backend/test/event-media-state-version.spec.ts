import request from 'supertest';
import {
  EVENT_MEDIA_EDGE_TOKEN,
  EventMediaHarness,
} from './helpers/event-media-harness.js';

const EDGE_EVENT = '723e4567-e89b-42d3-a456-426614174006';
const SHA256 = 'e'.repeat(64);
const POSTGRES_INTEGER_OVERFLOW = 2_147_483_648;

describe('event media state version bounds', () => {
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

  it('rejects a READY state version outside PostgreSQL INTEGER', async () => {
    // Given: a camera-owned event and an otherwise valid READY upload.
    const graph = await seedEvent('ready-overflow');

    // When: the edge sends the first value outside PostgreSQL INTEGER.
    const response = harness.uploadReady({
      clipId: 'clip-ready-state-overflow',
      cameraId: graph.cameraId,
      eventRefs: [EDGE_EVENT],
      sha256: SHA256,
      body: Buffer.from('state-version-h264'),
      stateVersion: POSTGRES_INTEGER_OVERFLOW,
    });

    // Then: request validation rejects it permanently before persistence.
    await response.expect(400);
  });

  it('rejects an UNAVAILABLE state version outside PostgreSQL INTEGER', async () => {
    // Given: a camera-owned event and an otherwise valid terminal report.
    const graph = await seedEvent('unavailable-overflow');

    // When: the edge sends the first value outside PostgreSQL INTEGER.
    const response = request(harness.app.getHttpServer())
      .put('/api/v1/events/clips/clip-unavailable-state-overflow/state')
      .set('Authorization', `Bearer ${EVENT_MEDIA_EDGE_TOKEN}`)
      .send({
        camera_id: graph.cameraId,
        event_refs: [EDGE_EVENT],
        state_version: POSTGRES_INTEGER_OVERFLOW,
        reason: 'CAPTURE_FAILED',
      });

    // Then: DTO validation rejects it permanently before persistence.
    await response.expect(400);
  });

  async function seedEvent(suffix: string) {
    const graph = await harness.seedGraph(suffix);
    await harness
      .postEvent({
        cameraId: graph.cameraId,
        edgeEventId: EDGE_EVENT,
        detectedAt: '2026-07-16T00:00:00.000Z',
      })
      .expect(201);
    return graph;
  }
});
