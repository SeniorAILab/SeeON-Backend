import type { SpacesRepository } from '../repositories/spaces.repository';
import { SpacesService } from './spaces.service';

describe('SpacesService', () => {
  const space = {
    id: 'space-1',
    facilityId: 'facility-session',
    floorId: 'floor-1',
    name: '201',
    type: 'ROOM',
    capacity: 2,
    isActive: true,
    assignedStaff: null,
    createdAt: new Date('2026-06-21T00:00:00.000Z'),
  };

  function serviceWith(
    repository: Partial<Record<keyof SpacesRepository, jest.Mock>>,
  ) {
    return {
      service: new SpacesService(repository as never),
      repository,
    };
  }

  it('creates spaces under the session facility without legacy cameraId', async () => {
    const { service, repository } = serviceWith({
      create: jest.fn().mockResolvedValue(space),
    });
    await expect(
      service.create('facility-session', {
        facilityId: 'evil',
        floorId: 'floor-1',
        name: '201',
        type: 'ROOM',
        capacity: 2,
      }),
    ).resolves.toMatchObject({
      facilityId: 'facility-session',
    });
    expect(repository.create).toHaveBeenCalledWith('facility-session', {
      facilityId: 'facility-session',
      floorId: 'floor-1',
      name: '201',
      type: 'ROOM',
      capacity: 2,
      isActive: undefined,
      assignedStaff: undefined,
    });
  });

  it('soft deletes spaces and returns the updated body', async () => {
    const inactive = { ...space, isActive: false };
    const { service, repository } = serviceWith({
      findById: jest.fn().mockResolvedValue(space),
      softDelete: jest.fn().mockResolvedValue(inactive),
    });
    await expect(
      service.remove('facility-session', 'space-1'),
    ).resolves.toMatchObject({ isActive: false });
    expect(repository.softDelete).toHaveBeenCalledWith(
      'facility-session',
      'space-1',
    );
  });
  it('restores soft-deleted spaces through an isActive update', async () => {
    const inactive = { ...space, isActive: false };
    const restored = { ...space, isActive: true };
    const { service, repository } = serviceWith({
      findById: jest.fn().mockResolvedValue(inactive),
      update: jest.fn().mockResolvedValue(restored),
    });

    await expect(
      service.update('facility-session', 'space-1', { isActive: true }),
    ).resolves.toMatchObject({ isActive: true });
    expect(repository.update).toHaveBeenCalledWith(
      'facility-session',
      'space-1',
      {
        floorId: undefined,
        name: undefined,
        type: undefined,
        capacity: undefined,
        isActive: true,
        assignedStaff: undefined,
      },
    );
  });
});
