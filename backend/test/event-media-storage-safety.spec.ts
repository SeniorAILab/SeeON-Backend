import { createHash } from 'node:crypto';
import request from 'supertest';
import type { ClipInspector } from '../src/media/clip-storage.types.js';
import {
  EVENT_MEDIA_EDGE_TOKEN,
  EventMediaHarness,
} from './helpers/event-media-harness.js';
import {
  createEventMediaStorage,
  type RealEventMediaStorage,
} from './helpers/event-media-storage.js';

const EDGE_EVENT = '923e4567-e89b-42d3-a456-426614174008';

class GatedInspector implements ClipInspector {
  readonly entered: Promise<void>;
  private readonly inspectionGate: Promise<void>;
  private signalEntered: () => void = () => undefined;
  private openGate: () => void = () => undefined;

  constructor() {
    this.entered = new Promise((resolve) => {
      this.signalEntered = resolve;
    });
    this.inspectionGate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  async inspect() {
    this.signalEntered();
    await this.inspectionGate;
    return { codec: 'h264' as const, durationMs: 1_000 };
  }

  release(): void {
    this.openGate();
  }
}

describe('event media storage transition safety', () => {
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

  it('rejects duration mismatch before publish and preserves retryable DB state', async () => {
    // Given: valid bytes whose inspected duration differs from the manifest.
    storage = await createEventMediaStorage({
      inspector: {
        inspect: () =>
          Promise.resolve({ codec: 'h264' as const, durationMs: 1_001 }),
      },
    });
    await harness.start(storage.service);
    const graph = await seedEvent('duration');
    const body = Buffer.from('duration-mismatch-h264');

    // When: READY persistence inspects the staged bytes.
    const response = harness.uploadReady({
      clipId: 'clip-duration-mismatch',
      cameraId: graph.cameraId,
      eventRefs: [EDGE_EVENT],
      sha256: digest(body),
      body,
    });

    // Then: 422 leaves no file and a safe, retryable STAGED reservation.
    await response.expect(422);
    await expect(storage.listFiles()).resolves.toEqual([]);
    await expect(
      harness.direct.mediaClip.findFirstOrThrow({
        where: { externalClipId: 'clip-duration-mismatch' },
      }),
    ).resolves.toMatchObject({
      status: 'PENDING',
      storageState: 'STAGED',
      storageKey: null,
      stagingToken: digest(body),
    });
  });

  it('fences UNAVAILABLE while READY owns STAGED and leaves no orphan', async () => {
    // Given: READY has committed its DB reservation and pauses in inspection.
    const inspector = new GatedInspector();
    storage = await createEventMediaStorage({ inspector });
    await harness.start(storage.service);
    const graph = await seedEvent('fence');
    const body = Buffer.from('ready-wins-h264');
    const sha256 = digest(body);
    const upload = harness
      .uploadReady({
        clipId: 'clip-ready-fence',
        cameraId: graph.cameraId,
        eventRefs: [EDGE_EVENT],
        sha256,
        body,
      })
      .then((response) => response);
    await inspector.entered;

    // When: UNAVAILABLE races after READY owns the STAGED transition.
    await request(harness.app.getHttpServer())
      .put('/api/v1/events/clips/clip-ready-fence/state')
      .set('Authorization', `Bearer ${EVENT_MEDIA_EDGE_TOKEN}`)
      .send({
        camera_id: graph.cameraId,
        event_refs: [EDGE_EVENT],
        state_version: 1,
        reason: 'CAPTURE_FAILED',
      })
      .expect(409);
    inspector.release();
    const ready = await upload;

    // Then: READY is the only terminal result and every byte is referenced.
    expect(ready.status).toBe(200);
    const clip = await harness.direct.mediaClip.findFirstOrThrow({
      where: { externalClipId: 'clip-ready-fence' },
    });
    expect(clip).toMatchObject({
      status: 'READY',
      storageState: 'READY',
      stagingToken: null,
    });
    expect(clip.storageKey).not.toBeNull();
    await expect(storage.listFiles()).resolves.toEqual([
      `${graph.facilityId}/${clip.id}/${sha256}.mp4`,
    ]);
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

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
