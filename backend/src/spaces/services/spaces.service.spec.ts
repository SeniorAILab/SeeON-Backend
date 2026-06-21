import { SpacesRepository } from '../repositories/spaces.repository';
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

  function serviceWith(
    repository: Partial<Record<keyof SpacesRepository, jest.Mock>>,
  ) {
    return {
      service: new SpacesService(repository as never),
      repository,
    };
  }

  it('creates spaces under the session facility and returns nullable cameraId', async () => {
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
        cameraId: '',
      }),
    ).resolves.toMatchObject({
      cameraId: null,
      facilityId: 'facility-session',
    });
    expect(repository.create).toHaveBeenCalledWith('facility-session', {
      facilityId: 'facility-session',
      floorId: 'floor-1',
      name: '201',
      type: 'ROOM',
      capacity: 2,
      cameraId: null,
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
});
