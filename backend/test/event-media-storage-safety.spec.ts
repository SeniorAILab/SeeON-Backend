import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import request from 'supertest';
import type { ClipInspector } from '../src/media/clip-storage.types.js';
import { EventMediaRepository } from '../src/media/event-media.repository.js';
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

  it('makes a permanent contract rejection terminal and replays a lost response', async () => {
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
    const upload = () =>
      harness.uploadReady({
        clipId: 'clip-duration-mismatch',
        cameraId: graph.cameraId,
        eventRefs: [EDGE_EVENT],
        sha256: digest(body),
        body,
      });

    // Then: the observed 422 is already terminal, and a response-loss replay
    // converges to the same receipt without trying storage again.
    await upload().expect(422);
    const replay = await upload().expect(200);
    expect(replay.body).toEqual({
      clip_id: 'clip-duration-mismatch',
      state: 'UNAVAILABLE',
      state_version: 1,
    });
    await expect(storage.listFiles()).resolves.toEqual([]);
    await expect(
      harness.direct.mediaClip.findFirstOrThrow({
        where: { externalClipId: 'clip-duration-mismatch' },
      }),
    ).resolves.toMatchObject({
      status: 'UNAVAILABLE',
      reason: 'CORRUPT',
      storageState: 'NONE',
      storageKey: null,
      stagingToken: null,
    });
  });

  it('lets an already accepted valid READY win a contract-rejection race without an orphan', async () => {
    // Given: two exact-manifest requests both reserve STAGED before persistence.
    storage = await createEventMediaStorage();
    await harness.start(storage.service);
    const graph = await seedEvent('contract-race');
    const validBody = Buffer.from('valid-race-h264');
    const sha256 = digest(validBody);
    const repository = harness.app.get(EventMediaRepository);
    const manifest = {
      externalClipId: 'clip-contract-race',
      cameraId: graph.cameraId,
      eventRefs: [EDGE_EVENT],
      clipStartAt: new Date('2026-07-16T00:00:00.000Z'),
      clipEndAt: new Date('2026-07-16T00:00:01.000Z'),
      finalizedAt: new Date('2026-07-16T00:00:02.000Z'),
      sha256,
      sizeBytes: validBody.length,
      durationMs: 1_000,
      stateVersion: 1,
    };
    const rejectedAttempt = await repository.prepareReady(
      graph.facilityId,
      manifest,
    );
    const validAttempt = await repository.prepareReady(
      graph.facilityId,
      manifest,
    );

    // When: invalid bytes terminalize first, then the already accepted valid
    // request publishes and finalizes the same immutable identity.
    await repository.rejectReadyContract(
      graph.facilityId,
      rejectedAttempt.id,
      rejectedAttempt.stagingToken,
    );
    const persisted = await storage.service.persist({
      facilityId: graph.facilityId,
      clipId: validAttempt.id,
      expectedSha256: sha256,
      expectedSizeBytes: validBody.length,
      expectedDurationMs: 1_000,
      source: Readable.from([validBody]),
    });
    const ready = await repository.finalizeReady(
      graph.facilityId,
      validAttempt.id,
      persisted,
      validAttempt.stagingToken,
      new Date('2026-09-14T00:00:02.000Z'),
    );

    // Then: READY wins and the sole published file is referenced by the row.
    expect(ready).toMatchObject({
      status: 'READY',
      reason: null,
      storageState: 'READY',
      stagingToken: null,
    });
    expect(ready.storageKey).not.toBeNull();
    await expect(storage.listFiles()).resolves.toEqual([
      `${graph.facilityId}/${ready.id}/${sha256}.mp4`,
    ]);
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
