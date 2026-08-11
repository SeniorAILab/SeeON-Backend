import { ConflictException } from '@nestjs/common';
import { ProvisioningSource } from '@prisma/client';
import type { FloorsRepository } from '../repositories/floors.repository';
import { FloorsService } from './floors.service';

describe('FloorsService', () => {
  const floor = {
    id: 'floor-1',
    facilityId: 'facility-session',
    name: '2F',
    orderIndex: 2,
    isActive: true,
    provisioningSource: ProvisioningSource.PRODUCT,
    createdAt: new Date('2026-06-21T00:00:00.000Z'),
  };
  const edgeOwnedFloor = {
    ...floor,
    provisioningSource: ProvisioningSource.EDGE,
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
      deleteWithDescendants: jest.fn().mockResolvedValue({
        status: 'active_spaces',
      }),
    });
    await expect(
      service.remove('facility-session', 'floor-1'),
    ).rejects.toMatchObject({
      response: {
        error: 'conflict',
        message: 'Floor cannot be deleted while active spaces reference it',
      },
    });
    expect(repository.deleteWithDescendants).toHaveBeenCalledWith(
      'facility-session',
      'floor-1',
    );
  });

  it('rejects hard delete when inactive child spaces have references', async () => {
    const { service } = serviceWith({
      findById: jest.fn().mockResolvedValue(floor),
      deleteWithDescendants: jest.fn().mockResolvedValue({
        status: 'referenced_spaces',
      }),
    });

    await expect(
      service.remove('facility-session', 'floor-1'),
    ).rejects.toMatchObject({
      response: {
        error: 'conflict',
        message: '참조 이력이 있는 공간이 포함된 층은 삭제할 수 없습니다',
      },
    });
  });

  it('includes provisioningSource in the presented floor response', async () => {
    const { service } = serviceWith({
      create: jest.fn().mockResolvedValue(floor),
    });
    await expect(
      service.create('facility-session', { name: '2F', orderIndex: 2 }),
    ).resolves.toMatchObject({
      provisioningSource: ProvisioningSource.PRODUCT,
    });
  });

  it('cascade-removes eligible soft-deleted child spaces and the floor atomically', async () => {
    const { service, repository } = serviceWith({
      findById: jest.fn().mockResolvedValue(floor),
      deleteWithDescendants: jest.fn().mockResolvedValue({ status: 'deleted' }),
    });
    await expect(
      service.remove('facility-session', 'floor-1'),
    ).resolves.toBeUndefined();
    expect(repository.deleteWithDescendants).toHaveBeenCalledWith(
      'facility-session',
      'floor-1',
    );
  });

  describe('Edge ownership lock', () => {
    it('rejects update on an EDGE-owned floor', async () => {
      const { service, repository } = serviceWith({
        findById: jest.fn().mockResolvedValue(edgeOwnedFloor),
        update: jest.fn(),
      });

      await expect(
        service.update('facility-session', 'floor-1', { name: 'Renamed' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('rejects delete on an EDGE-owned floor', async () => {
      const { service, repository } = serviceWith({
        findById: jest.fn().mockResolvedValue(edgeOwnedFloor),
        deleteWithDescendants: jest.fn(),
      });

      await expect(
        service.remove('facility-session', 'floor-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.deleteWithDescendants).not.toHaveBeenCalled();
    });

    it('still allows update and delete on a PRODUCT-owned floor', async () => {
      const { service } = serviceWith({
        findById: jest.fn().mockResolvedValue(floor),
        update: jest.fn().mockResolvedValue(floor),
        deleteWithDescendants: jest.fn().mockResolvedValue({
          status: 'deleted',
        }),
      });

      await expect(
        service.update('facility-session', 'floor-1', { name: 'Renamed' }),
      ).resolves.toMatchObject({ id: 'floor-1' });
      await expect(
        service.remove('facility-session', 'floor-1'),
      ).resolves.toBeUndefined();
    });
  });
});
