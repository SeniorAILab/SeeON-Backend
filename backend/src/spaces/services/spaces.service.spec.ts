import { ConflictException } from '@nestjs/common';
import { ProvisioningSource } from '@prisma/client';
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
    provisioningSource: ProvisioningSource.PRODUCT,
    createdAt: new Date('2026-06-21T00:00:00.000Z'),
  };
  const edgeOwnedSpace = {
    ...space,
    provisioningSource: ProvisioningSource.EDGE,
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

  it('includes provisioningSource in the presented space response', async () => {
    const { service } = serviceWith({
      create: jest.fn().mockResolvedValue(space),
    });
    await expect(
      service.create('facility-session', {
        floorId: 'floor-1',
        name: '201',
        type: 'ROOM',
        capacity: 2,
      }),
    ).resolves.toMatchObject({
      provisioningSource: ProvisioningSource.PRODUCT,
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

  describe('Edge ownership lock', () => {
    it('rejects update on an EDGE-owned space', async () => {
      const { service, repository } = serviceWith({
        findById: jest.fn().mockResolvedValue(edgeOwnedSpace),
        update: jest.fn(),
      });

      await expect(
        service.update('facility-session', 'space-1', { name: 'Renamed' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('rejects a floorId move on an EDGE-owned space', async () => {
      const { service, repository } = serviceWith({
        findById: jest.fn().mockResolvedValue(edgeOwnedSpace),
        update: jest.fn(),
      });

      await expect(
        service.update('facility-session', 'space-1', {
          floorId: 'floor-2',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('rejects remove on an EDGE-owned space', async () => {
      const { service, repository } = serviceWith({
        findById: jest.fn().mockResolvedValue(edgeOwnedSpace),
        softDelete: jest.fn(),
      });

      await expect(
        service.remove('facility-session', 'space-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.softDelete).not.toHaveBeenCalled();
    });

    it('still allows update, floorId move, and remove on a PRODUCT-owned space', async () => {
      const { service } = serviceWith({
        findById: jest.fn().mockResolvedValue(space),
        update: jest.fn().mockResolvedValue({ ...space, floorId: 'floor-2' }),
        softDelete: jest.fn().mockResolvedValue({ ...space, isActive: false }),
      });

      await expect(
        service.update('facility-session', 'space-1', {
          floorId: 'floor-2',
        }),
      ).resolves.toMatchObject({ floorId: 'floor-2' });
      await expect(
        service.remove('facility-session', 'space-1'),
      ).resolves.toMatchObject({ isActive: false });
    });
  });
});
