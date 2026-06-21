import { FacilitiesService } from './facilities.service';

describe('FacilitiesService', () => {
  const facility = {
    id: 'facility-session',
    name: 'Happy Home',
    code: 'happy-home',
    address: null,
    phone: null,
    businessRegistrationNumber: null,
    createdAt: new Date('2026-06-21T00:00:00.000Z'),
  };

  it('reads the facility root directly by session facilityId', async () => {
    const prisma = {
      db: { facility: { findUnique: jest.fn().mockResolvedValue(facility) } },
    };
    const service = new FacilitiesService(prisma as never);
    await expect(service.current('facility-session')).resolves.toMatchObject({
      code: 'happy-home',
    });
    expect(prisma.db.facility.findUnique).toHaveBeenCalledWith({
      where: { id: 'facility-session' },
    });
  });

  it('ignores immutable code updates', async () => {
    const prisma = {
      db: {
        facility: {
          update: jest
            .fn()
            .mockResolvedValue({ ...facility, name: 'New Name' }),
        },
      },
    };
    const service = new FacilitiesService(prisma as never);
    await service.update('facility-session', {
      name: 'New Name',
      code: 'evil',
    });
    expect(prisma.db.facility.update).toHaveBeenCalledWith({
      where: { id: 'facility-session' },
      data: { name: 'New Name', address: undefined, phone: undefined },
    });
  });
});
