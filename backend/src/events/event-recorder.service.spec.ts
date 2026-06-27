import { Prisma } from '@prisma/client';
import { EventRecorderService, buildEventDedupKey } from './event-recorder.service.js';

describe('EventRecorderService', () => {
  const detectedAt = new Date('2026-06-26T12:34:56.789Z');
  const camera = { id: 'cam_sp_202', facilityId: 'fac_1', spaceId: 'space_1' };

  function makeSubject() {
    const tx = {
      event: {
        create: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
    };
    const prisma = {
      withFacilityContext: jest.fn((_facilityId: string, fn: (txArg: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
    };
    const cameras = { resolveForEventIngest: jest.fn().mockResolvedValue(camera) };
    return { subject: new EventRecorderService(prisma as never, cameras as never), prisma, cameras, tx };
  }

  it('builds the canonical dedup key from trimmed camera, iso detectedAt, and lower-case trimmed type', () => {
    expect(buildEventDedupKey(' cam_sp_202 ', detectedAt, ' FALL ')).toBe(
      'b86400e65ce82c34dfb08c6a629607aac0251fcf4042cdb6bcb135a76ac972b5',
    );
  });

  it('creates an event with the resolved facility and space', async () => {
    const { subject, tx } = makeSubject();
    const created = { id: 'evt_1' };
    tx.event.create.mockResolvedValue(created);

    await expect(
      subject.record({ cameraId: ' cam_sp_202 ', type: ' FALL ', detectedAt, confidence: 0.91 }),
    ).resolves.toEqual({ event: created, duplicate: false });

    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        facilityId: 'fac_1',
        cameraId: 'cam_sp_202',
        spaceId: 'space_1',
        type: 'FALL',
        confidence: 0.91,
        detectedAt,
      }),
    });
  });

  it('returns the existing event as duplicate on facility/dedup unique conflict', async () => {
    const { subject, tx } = makeSubject();
    const duplicate = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['facility_id', 'dedup_key'] },
    });
    const existing = { id: 'evt_existing' };
    tx.event.create.mockRejectedValue(duplicate);
    tx.event.findUniqueOrThrow.mockResolvedValue(existing);

    await expect(subject.record({ cameraId: 'cam_sp_202', type: 'fall', detectedAt })).resolves.toEqual({
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
    cameras.resolveForEventIngest.mockRejectedValue(new Error('unknown_camera'));

    await expect(subject.record({ cameraId: 'missing', type: 'fall', detectedAt })).rejects.toThrow(
      'unknown_camera',
    );
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it('does not invoke side-effect dependencies', async () => {
    const { subject, tx } = makeSubject();
    tx.event.create.mockResolvedValue({ id: 'evt_1' });

    await subject.record({ cameraId: 'cam_sp_202', type: 'fall', detectedAt });

    expect(Object.keys(subject)).toEqual(['prisma', 'cameras']);
  });
});
