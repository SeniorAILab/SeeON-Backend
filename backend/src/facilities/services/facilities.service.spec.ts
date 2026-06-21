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
    const repository = {
      getByFacilityId: jest.fn().mockResolvedValue(facility),
    };
    const service = new FacilitiesService(repository as never);
    await expect(service.current('facility-session')).resolves.toMatchObject({
      code: 'happy-home',
    });
    expect(repository.getByFacilityId).toHaveBeenCalledWith('facility-session');
  });

  it('ignores immutable code updates', async () => {
    const repository = {
      updateByFacilityId: jest
        .fn()
        .mockResolvedValue({ ...facility, name: 'New Name' }),
    };
    const service = new FacilitiesService(repository as never);
    await service.update('facility-session', {
      name: 'New Name',
      code: 'evil',
    });
    expect(repository.updateByFacilityId).toHaveBeenCalledWith(
      'facility-session',
      { name: 'New Name', address: undefined, phone: undefined },
    );
  });
});
