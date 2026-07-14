import type { FloorsRepository } from '../repositories/floors.repository';
import { FloorsService } from './floors.service';

describe('FloorsService', () => {
  const floor = {
    id: 'floor-1',
    facilityId: 'facility-session',
    name: '2F',
    orderIndex: 2,
    isActive: true,
    createdAt: new Date('2026-06-21T00:00:00.000Z'),
  };

  function serviceWith(
    repository: Partial<Record<keyof FloorsRepository, jest.Mock>>,
  ) {
    return {
      service: new FloorsService(repository as never),
      repository,
    };
  }

  it('creates floors under the session facility and ignores body facilityId', async () => {
    const { service, repository } = serviceWith({
      create: jest.fn().mockResolvedValue(floor),
    });

    await expect(
      service.create('facility-session', {
        facilityId: 'evil',
        name: '2F',
        orderIndex: 2,
      }),
    ).resolves.toMatchObject({
      id: 'floor-1',
      facilityId: 'facility-session',
      orderIndex: 2,
    });
    expect(repository.create).toHaveBeenCalledWith('facility-session', {
      facilityId: 'facility-session',
      name: '2F',
      orderIndex: 2,
      isActive: true,
    });
  });

  it('rejects hard delete when active child spaces exist', async () => {
    const { service, repository } = serviceWith({
      findById: jest.fn().mockResolvedValue(floor),
      countActiveSpaces: jest.fn().mockResolvedValue(1),
      deleteWithDescendants: jest.fn(),
    });
    await expect(
      service.remove('facility-session', 'floor-1'),
    ).rejects.toMatchObject({
      response: {
        error: 'conflict',
        message: 'Floor cannot be deleted while active spaces reference it',
      },
    });
    expect(repository.deleteWithDescendants).not.toHaveBeenCalled();
  });
  it('rejects hard delete when inactive child spaces have references', async () => {
    const { service, repository } = serviceWith({
      findById: jest.fn().mockResolvedValue(floor),
      countActiveSpaces: jest.fn().mockResolvedValue(0),
      countDescendantSpaceReferences: jest.fn().mockResolvedValue(1),
      deleteWithDescendants: jest.fn(),
    });

    await expect(
      service.remove('facility-session', 'floor-1'),
    ).rejects.toMatchObject({
      response: {
        error: 'conflict',
        message: '참조 이력이 있는 공간이 포함된 층은 삭제할 수 없습니다',
      },
    });
    expect(repository.deleteWithDescendants).not.toHaveBeenCalled();
  });

  it('cascade-removes soft-deleted child spaces before deleting the floor', async () => {
    const { service, repository } = serviceWith({
      findById: jest.fn().mockResolvedValue(floor),
      countActiveSpaces: jest.fn().mockResolvedValue(0),
      countDescendantSpaceReferences: jest.fn().mockResolvedValue(0),
      deleteWithDescendants: jest.fn().mockResolvedValue(undefined),
    });
    await service.remove('facility-session', 'floor-1');
    expect(repository.countActiveSpaces).toHaveBeenCalledWith(
      'facility-session',
      'floor-1',
    );
    expect(repository.countDescendantSpaceReferences).toHaveBeenCalledWith(
      'facility-session',
      'floor-1',
    );
    expect(repository.deleteWithDescendants).toHaveBeenCalledWith(
      'facility-session',
      'floor-1',
    );
  });
});
