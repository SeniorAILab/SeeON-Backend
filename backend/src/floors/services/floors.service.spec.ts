import { ConflictException } from '@nestjs/common';
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

  function serviceWith(tx: Record<string, unknown>) {
    const prisma = {
      withFacilityContext: jest.fn(
        (_facilityId: string, fn: (tx: unknown) => unknown) => fn(tx),
      ),
    };
    return { service: new FloorsService(prisma as never), prisma };
  }

  it('creates floors under the session facility and ignores body facilityId', async () => {
    const tx = { floor: { create: jest.fn().mockResolvedValue(floor) } };
    const { service } = serviceWith(tx);

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
    expect(tx.floor.create).toHaveBeenCalledWith({
      data: {
        facilityId: 'facility-session',
        name: '2F',
        orderIndex: 2,
        isActive: true,
      },
    });
  });

  it('rejects hard delete when active child spaces exist', async () => {
    const tx = {
      floor: { findUnique: jest.fn().mockResolvedValue(floor) },
      space: { count: jest.fn().mockResolvedValue(1) },
    };
    const { service } = serviceWith(tx);
    await expect(
      service.remove('facility-session', 'floor-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('cascade-removes soft-deleted child spaces and their zones before deleting the floor', async () => {
    const tx = {
      floor: {
        findUnique: jest.fn().mockResolvedValue(floor),
        delete: jest.fn().mockResolvedValue(floor),
      },
      space: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([{ id: 'space-inactive-1' }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      zone: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    const { service } = serviceWith(tx);
    await service.remove('facility-session', 'floor-1');
    expect(tx.zone.deleteMany).toHaveBeenCalledWith({
      where: { spaceId: { in: ['space-inactive-1'] } },
    });
    expect(tx.space.deleteMany).toHaveBeenCalledWith({
      where: { floorId: 'floor-1' },
    });
    expect(tx.floor.delete).toHaveBeenCalledWith({ where: { id: 'floor-1' } });
  });
});
