import { SpacesService } from './spaces.service';

describe('SpacesService', () => {
  const space = {
    id: 'space-1',
    facilityId: 'facility-session',
    floorId: 'floor-1',
    name: '201',
    type: 'ROOM',
    capacity: 2,
    cameraId: null,
    isActive: true,
    assignedStaff: null,
    createdAt: new Date('2026-06-21T00:00:00.000Z'),
  };

  function serviceWith(tx: Record<string, unknown>) {
    const prisma = {
      withFacilityContext: jest.fn(
        (_facilityId: string, fn: (tx: unknown) => unknown) => fn(tx),
      ),
    };
    return { service: new SpacesService(prisma as never), prisma };
  }

  it('creates spaces under the session facility and returns nullable cameraId', async () => {
    const tx = { space: { create: jest.fn().mockResolvedValue(space) } };
    const { service } = serviceWith(tx);
    await expect(
      service.create('facility-session', {
        facilityId: 'evil',
        floorId: 'floor-1',
        name: '201',
        type: 'ROOM',
        capacity: 2,
        cameraId: '',
      }),
    ).resolves.toMatchObject({
      cameraId: null,
      facilityId: 'facility-session',
    });
    expect(tx.space.create).toHaveBeenCalledWith({
      data: {
        facilityId: 'facility-session',
        floorId: 'floor-1',
        name: '201',
        type: 'ROOM',
        capacity: 2,
        cameraId: null,
        isActive: undefined,
        assignedStaff: undefined,
      },
    });
  });

  it('soft deletes spaces and returns the updated body', async () => {
    const inactive = { ...space, isActive: false };
    const tx = {
      space: {
        findUnique: jest.fn().mockResolvedValue(space),
        update: jest.fn().mockResolvedValue(inactive),
      },
    };
    const { service } = serviceWith(tx);
    await expect(
      service.remove('facility-session', 'space-1'),
    ).resolves.toMatchObject({ isActive: false });
    expect(tx.space.update).toHaveBeenCalledWith({
      where: { id: 'space-1' },
      data: { isActive: false },
    });
  });
});
