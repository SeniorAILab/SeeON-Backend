import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  EventRecorderService,
  buildEventDedupKey,
} from './event-recorder.service.js';

describe('EventRecorderService', () => {
  const detectedAt = new Date('2026-06-26T12:34:56.789Z');
  const edgeEventId = '123e4567-e89b-42d3-a456-426614174000';
  const camera = { id: 'cam_sp_202', facilityId: 'fac_1', spaceId: 'space_1' };

  function makeSubject() {
    const tx = {
      $queryRaw: jest.fn(),
      event: {
        create: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      alert: {
        updateMany: jest.fn(),
      },
    };
    const prisma = {
      $queryRaw: jest.fn(),
      withFacilityContext: jest.fn(
        (_facilityId: string, fn: (txArg: typeof tx) => Promise<unknown>) =>
          fn(tx),
      ),
    };
    const cameras = {
      resolveForEventIngest: jest.fn().mockResolvedValue(camera),
    };
    return {
      subject: new EventRecorderService(prisma as never, cameras as never),
      prisma,
      cameras,
      tx,
    };
  }

  it('builds the canonical dedup key from trimmed camera, iso detectedAt, and lower-case trimmed type', () => {
    expect(buildEventDedupKey(' cam_sp_202 ', detectedAt, ' FALL ')).toBe(
      'b86400e65ce82c34dfb08c6a629607aac0251fcf4042cdb6bcb135a76ac972b5',
    );
  });

  it('creates an event with the resolved facility, space, and canonical lower-case type', async () => {
    const { subject, tx } = makeSubject();
    const created = { id: 'evt_1' };
    tx.event.create.mockResolvedValue(created);

    await expect(
      subject.record({
        cameraId: ' cam_sp_202 ',
        type: ' FALL ',
        detectedAt,
        confidence: 0.91,
        clipId: 'clip-123',
      }),
    ).resolves.toEqual({ event: created, duplicate: false });

    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        facilityId: 'fac_1',
        cameraId: 'cam_sp_202',
        spaceId: 'space_1',
        type: 'fall',
        confidence: 0.91,
        detectedAt,
        clipId: 'clip-123',
        configVersion: null,
        modelVersion: null,
        detectorVersion: null,
        operatingThreshold: null,
        snapshotKey: null,
        clockSource: null,
      }),
    });
  });
  it('persists optional audit envelope fields but ignores client-supplied snapshot_key (server-derived only)', async () => {
    const { subject, tx } = makeSubject();
    const created = { id: 'evt_1' };
    tx.event.create.mockResolvedValue(created);

    await expect(
      subject.record({
        cameraId: 'cam_sp_202',
        type: 'fall',
        detectedAt,
        confidence: 0.91,
        configVersion: 7,
        modelVersion: 'rf-nh-2026-07-04',
        detectorVersion: 'edge-detector-1.2.3',
        operatingThreshold: 0.42,
        snapshotKey: 'events/evt_1.jpg',
        clockSource: 'edge_wall_clock',
      }),
    ).resolves.toEqual({ event: created, duplicate: false });

    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        configVersion: 7,
        modelVersion: 'rf-nh-2026-07-04',
        detectorVersion: 'edge-detector-1.2.3',
        operatingThreshold: 0.42,
        snapshotKey: null,
        clockSource: 'edge_wall_clock',
      }),
    });
  });

  it('uses a canonical edge event id as the stable idempotency identity', async () => {
    // Given: the edge persisted a UUIDv4 before attempting network delivery.
    const { subject, tx } = makeSubject();
    const created = { id: 'evt_edge', edgeEventId };
    tx.event.create.mockResolvedValue(created);

    // When: the event is recorded.
    await expect(
      subject.record({
        cameraId: camera.id,
        type: 'fall',
        detectedAt,
        edgeEventId,
      }),
    ).resolves.toEqual({ event: created, duplicate: false });

    // Then: the backend stores the edge identity and derives deduplication from it.
    const createCalls = tx.event.create.mock.calls as unknown as Array<
      [
        {
          data: { edgeEventId: string; dedupKey: string };
        },
      ]
    >;
    expect(createCalls[0]?.[0].data).toMatchObject({
      edgeEventId,
      dedupKey:
        '7b7c6d41ca592336c550e5ff38554707a1791797734195fe8a595dac42b82dfd',
    });
  });

  it('rejects non-canonical or non-v4 edge event identities before camera lookup', async () => {
    // Given: identifiers that are UUID-like but violate the event-clip contract.
    const { subject, cameras, tx } = makeSubject();

    // When: the invalid identities cross the event boundary.
    const attempts = [
      '123E4567-E89B-42D3-A456-426614174000',
      '123e4567-e89b-12d3-a456-426614174000',
      'not-a-uuid',
    ].map((invalidEdgeEventId) =>
      subject.record({
        cameraId: camera.id,
        type: 'fall',
        detectedAt,
        edgeEventId: invalidEdgeEventId,
      }),
    );

    // Then: none reaches camera or persistence ownership resolution.
    await Promise.all(
      attempts.map((attempt) =>
        expect(attempt).rejects.toThrow(
          'edge_event_id must be a canonical lowercase UUIDv4',
        ),
      ),
    );
    expect(cameras.resolveForEventIngest).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it('rejects an immutable payload mismatch for a replayed edge event id', async () => {
    // Given: the UUID already owns an event with different immutable facts.
    const { subject, tx } = makeSubject();
    const duplicate = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['facility_id', 'edge_event_id'] },
      },
    );
    tx.event.create.mockRejectedValue(duplicate);
    tx.event.findUniqueOrThrow.mockResolvedValue({
      cameraId: camera.id,
      type: 'fall',
      detectedAt: new Date(detectedAt.getTime() + 1_000),
      confidence: null,
      edgeEventId,
    });

    // When/Then: an at-least-once retry cannot mutate the original event.
    await expect(
      subject.record({
        cameraId: camera.id,
        type: 'fall',
        detectedAt,
        edgeEventId,
      }),
    ).rejects.toThrow('edge_event_id payload conflict');
  });

  it('rejects unknown event types before writing', async () => {
    const { subject, tx } = makeSubject();

    await expect(
      subject.record({ cameraId: 'cam_sp_202', type: 'wandering', detectedAt }),
    ).rejects.toThrow('type must be one of: detection-lost, bed-exit, fall');
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it('returns the existing event as duplicate on facility/dedup unique conflict', async () => {
    const { subject, tx } = makeSubject();
    const duplicate = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['facility_id', 'dedup_key'] },
      },
    );
    const existing = { id: 'evt_existing' };
    tx.event.create.mockRejectedValue(duplicate);
    tx.event.findUniqueOrThrow.mockResolvedValue(existing);

    await expect(
      subject.record({ cameraId: 'cam_sp_202', type: 'fall', detectedAt }),
    ).resolves.toEqual({
      event: existing,
      duplicate: true,
    });
    expect(tx.event.findUniqueOrThrow).toHaveBeenCalledWith({
      where: {
        facilityId_dedupKey: {
          facilityId: 'fac_1',
          dedupKey: buildEventDedupKey('cam_sp_202', detectedAt, 'fall'),
        },
      },
    });
  });

  it('rejects an unknown camera before writing', async () => {
    const { subject, cameras, tx } = makeSubject();
    cameras.resolveForEventIngest.mockRejectedValue(
      new Error('unknown_camera'),
    );

    await expect(
      subject.record({ cameraId: 'missing', type: 'fall', detectedAt }),
    ).rejects.toThrow('unknown_camera');
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it('resolves event snapshot ownership through the security definer function', async () => {
    const { subject, prisma } = makeSubject();
    prisma.$queryRaw.mockResolvedValue([
      { id: 'evt_1', facilityId: 'fac_1' },
    ] as never);

    await expect(subject.resolveForSnapshot('evt_1')).resolves.toEqual({
      id: 'evt_1',
      facilityId: 'fac_1',
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown events for snapshot upload', async () => {
    const { subject, prisma } = makeSubject();
    prisma.$queryRaw.mockResolvedValue([] as never);

    await expect(subject.resolveForSnapshot('missing')).rejects.toThrow(
      'unknown_event',
    );
  });

  it('persists snapshot keys and alert propagation in one facility transaction', async () => {
    const { subject, prisma, tx } = makeSubject();
    tx.alert.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      subject.persistSnapshotKey('fac_1', 'evt_1', 'fac_1/evt_1.jpg'),
    ).resolves.toBeUndefined();

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.withFacilityContext).toHaveBeenCalledWith(
      'fac_1',
      expect.any(Function),
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.alert.updateMany).toHaveBeenCalledWith({
      where: { originEventId: 'evt_1' },
      data: { snapshotKey: 'fac_1/evt_1.jpg' },
    });
    expect(tx.event.update).not.toHaveBeenCalled();
  });
  it('returns a bounded keyset page and opaque cursor for the last returned event', async () => {
    const { subject, tx } = makeSubject();
    const events = [
      { id: 'evt_3', detectedAt: new Date('2026-06-26T03:00:00.000Z') },
      { id: 'evt_2', detectedAt: new Date('2026-06-26T02:00:00.000Z') },
      { id: 'evt_1', detectedAt: new Date('2026-06-26T01:00:00.000Z') },
    ];
    tx.event.findMany.mockResolvedValue(events);

    await expect(subject.list('fac_1', { limit: 2 })).resolves.toEqual({
      items: events.slice(0, 2),
      nextCursor: Buffer.from('2026-06-26T02:00:00.000Z|evt_2').toString(
        'base64',
      ),
    });
    expect(tx.event.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      take: 3,
    });
  });

  it('uses an exclusive compound boundary for a valid cursor', async () => {
    const { subject, tx } = makeSubject();
    const cursor = Buffer.from('2026-06-26T02:00:00.000Z|evt_2').toString(
      'base64',
    );
    tx.event.findMany.mockResolvedValue([]);

    await expect(subject.list('fac_1', { cursor })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(tx.event.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { detectedAt: { lt: new Date('2026-06-26T02:00:00.000Z') } },
          {
            detectedAt: new Date('2026-06-26T02:00:00.000Z'),
            id: { lt: 'evt_2' },
          },
        ],
      },
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
  });

  it.each([
    '%%%',
    Buffer.from('2026-06-26T02:00:00Z|evt_2').toString('base64'),
    Buffer.from('2026-06-26T02:00:00.000Z|').toString('base64'),
    Buffer.from('2026-06-26T02:00:00.000Z|evt_2|extra').toString('base64'),
  ])('rejects invalid cursor %s before querying', async (cursor) => {
    const { subject, tx } = makeSubject();

    await expect(subject.list('fac_1', { cursor, limit: 500 })).rejects.toThrow(
      BadRequestException,
    );
    expect(tx.event.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { cursor: undefined, limit: undefined, take: 51 },
    { cursor: '', limit: 500, take: 201 },
  ])(
    'uses the first page without a cursor (%o)',
    async ({ cursor, limit, take }) => {
      const { subject, tx } = makeSubject();
      tx.event.findMany.mockResolvedValue([]);

      await subject.list('fac_1', { cursor, limit });
      expect(tx.event.findMany).toHaveBeenLastCalledWith({
        where: undefined,
        orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
        take,
      });
    },
  );
  it('does not invoke side-effect dependencies', async () => {
    const { subject, tx } = makeSubject();
    tx.event.create.mockResolvedValue({ id: 'evt_1' });

    await subject.record({ cameraId: 'cam_sp_202', type: 'fall', detectedAt });

    expect(Object.keys(subject)).toEqual(['prisma', 'cameras']);
  });
});
