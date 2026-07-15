import { EVENT_MEDIA_ERROR_CODES } from '../src/media/event-media.types.js';
import { EventMediaHarness } from './helpers/event-media-harness.js';

const EDGE_EVENT = '423e4567-e89b-42d3-a456-426614174003';
const SHA256 = 'c'.repeat(64);

describe('event media tenant lifecycle policy', () => {
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

  it('enforces app guard, PostgreSQL RLS, and no-delete grants for media rows', async () => {
    // Given: a READY clip owned by one facility.
    const graph = await seedReadyClip('rls');
    const other = await harness.seedGraph('rls-other');
    const clip = await harness.direct.mediaClip.findFirstOrThrow({
      where: { facilityId: graph.facilityId },
    });

    // When/Then: unscoped and wrong-facility readers see no media.
    await expect(
      harness.prismaService().db.mediaClip.findMany(),
    ).rejects.toThrow('without a facility context');
    await expect(harness.appRole.mediaClip.findMany()).resolves.toEqual([]);
    const wrongFacility = await harness.appRole.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.facility_id', ${other.facilityId}, true)`;
      return tx.mediaClip.findMany();
    });
    expect(wrongFacility).toEqual([]);

    // Then: even correctly scoped app-role SQL cannot erase tombstone ownership.
    await expect(
      harness.appRole.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.facility_id', ${graph.facilityId}, true)`;
        await tx.mediaClip.delete({ where: { id: clip.id } });
      }),
    ).rejects.toThrow(/permission denied|privilege/i);
  });

  it('expires after sixty days while active holds and phase-one policy block deletion', async () => {
    // Given: a READY clip at its retention boundary.
    const graph = await seedReadyClip('hold');
    const media = harness.mediaService();

    // When: backend lifecycle expires it and an incident hold is placed.
    const expired = await media.expireReady(
      graph.facilityId,
      'clip-policy-hold',
      new Date('2026-09-14T00:00:02.000Z'),
    );
    const hold = await media.placeHold({
      facilityId: graph.facilityId,
      externalClipId: 'clip-policy-hold',
      kind: 'INCIDENT',
      reason: 'incident review',
    });

    // Then: the hold blocks deletion before the global disabled policy does.
    expect(expired).toMatchObject({
      status: 'EXPIRED',
      reason: 'RETENTION_EXPIRED',
      stateVersion: 2,
    });
    await expect(
      media.requestDeletion(graph.facilityId, 'clip-policy-hold'),
    ).rejects.toMatchObject({ code: EVENT_MEDIA_ERROR_CODES.HOLD_ACTIVE });

    // When: the hold is released and deletion is requested again.
    await media.releaseHold(graph.facilityId, hold.id);

    // Then: phase one remains fail-closed and durable bytes/tombstone row remain.
    await expect(
      media.requestDeletion(graph.facilityId, 'clip-policy-hold'),
    ).rejects.toMatchObject({
      code: EVENT_MEDIA_ERROR_CODES.DELETION_DISABLED,
    });
    const retained = await harness.direct.mediaClip.findUniqueOrThrow({
      where: { id: expired.id },
    });
    expect(retained).toMatchObject({
      status: 'EXPIRED',
      storageState: 'READY',
      storageKey: expired.storageKey,
      deletedAt: null,
    });
  });

  it('rejects early expiration and preserves READY state', async () => {
    // Given: a clip whose minimum retention date has not arrived.
    const graph = await seedReadyClip('early-expiry');

    // When: lifecycle tries to expire it one millisecond early.
    const action = harness
      .mediaService()
      .expireReady(
        graph.facilityId,
        'clip-policy-early-expiry',
        new Date('2026-09-14T00:00:01.999Z'),
      );

    // Then: the invalid transition is typed and the row remains READY.
    await expect(action).rejects.toMatchObject({
      code: EVENT_MEDIA_ERROR_CODES.INVALID_TRANSITION,
    });
    await expect(
      harness.direct.mediaClip.findFirstOrThrow({
        where: { facilityId: graph.facilityId },
      }),
    ).resolves.toMatchObject({ status: 'READY', expiredAt: null });
  });

  async function seedReadyClip(suffix: string) {
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
        clipId: `clip-policy-${suffix}`,
        cameraId: graph.cameraId,
        eventRefs: [EDGE_EVENT],
        sha256: SHA256,
        body: Buffer.from('policy-h264'),
      })
      .expect(200);
    return graph;
  }
});
