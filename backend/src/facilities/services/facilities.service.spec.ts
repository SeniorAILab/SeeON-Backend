import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { FacilitiesService } from './facilities.service';

describe('FacilitiesService', () => {
  const facility = {
    id: 'facility-session',
    name: 'Happy Home',
    address: null,
    phone: null,
    businessRegistrationNumber: null,
    createdAt: new Date('2026-06-21T00:00:00.000Z'),
  };
  const otherFacility = {
    ...facility,
    id: 'other-facility',
    name: 'Other Home',
  };

  it('reads the facility root directly by session facilityId', async () => {
    const repository = {
      getByFacilityId: jest.fn().mockResolvedValue(facility),
    };
    const service = new FacilitiesService(repository as never);
    await expect(service.current('facility-session')).resolves.toMatchObject({
      name: 'Happy Home',
    });
    expect(repository.getByFacilityId).toHaveBeenCalledWith('facility-session');
  });

  it('gets the requested facility when it matches the effective facility scope', async () => {
    const repository = {
      getByFacilityId: jest.fn().mockResolvedValue(facility),
    };
    const service = new FacilitiesService(repository as never);
    await expect(
      service.getScoped('facility-session', 'facility-session'),
    ).resolves.toMatchObject({
      id: 'facility-session',
      name: 'Happy Home',
    });
    expect(repository.getByFacilityId).toHaveBeenCalledWith('facility-session');
  });

  it('returns not found when the requested facility is outside the effective facility scope', async () => {
    const repository = {
      getByFacilityId: jest.fn(),
    };
    const service = new FacilitiesService(repository as never);
    await expect(
      service.getScoped('other-facility', 'facility-session'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.getByFacilityId).not.toHaveBeenCalled();
  });

  it('updates only name, address, and phone', async () => {
    const repository = {
      updateByFacilityId: jest
        .fn()
        .mockResolvedValue({ ...facility, name: 'New Name' }),
    };
    const service = new FacilitiesService(repository as never);
    await service.update('facility-session', { name: 'New Name' });
    expect(repository.updateByFacilityId).toHaveBeenCalledWith(
      'facility-session',
      { name: 'New Name', address: undefined, phone: undefined },
    );
  });

  it('lists every facility for facility-less super admins', async () => {
    const repository = {
      listAll: jest.fn().mockResolvedValue([facility, otherFacility]),
    };
    const service = new FacilitiesService(repository as never);

    await expect(
      service.listForUser({ role: Role.SUPER_ADMIN, facilityId: null }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'facility-session' }),
      expect.objectContaining({ id: 'other-facility' }),
    ]);
    expect(repository.listAll).toHaveBeenCalledWith();
  });

  it('lists only the caller facility for facility-bound users', async () => {
    const repository = {
      listByFacilityId: jest.fn().mockResolvedValue([facility]),
    };
    const service = new FacilitiesService(repository as never);

    await expect(
      service.listForUser({ role: Role.ADMIN, facilityId: 'facility-session' }),
    ).resolves.toEqual([expect.objectContaining({ id: 'facility-session' })]);
    expect(repository.listByFacilityId).toHaveBeenCalledWith(
      'facility-session',
    );
  });

  it('rejects facility-less non-super users', async () => {
    const repository = {
      listAll: jest.fn(),
      listByFacilityId: jest.fn(),
    };
    const service = new FacilitiesService(repository as never);

    await expect(
      service.listForUser({ role: Role.STAFF, facilityId: null }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.listAll).not.toHaveBeenCalled();
    expect(repository.listByFacilityId).not.toHaveBeenCalled();
  });

  describe('getEdgeStatus', () => {
    it('reports NOT_ENROLLED with null timestamps when no active installation exists', async () => {
      const repository = {
        findActiveEdgeInstallation: jest.fn().mockResolvedValue(null),
        getCameraHealthCounts: jest
          .fn()
          .mockResolvedValue({ healthy: 0, total: 0 }),
      };
      const service = new FacilitiesService(repository as never);

      await expect(service.getEdgeStatus('facility-session')).resolves.toEqual({
        connectionState: 'NOT_ENROLLED',
        lastHeartbeatAt: null,
        lastSyncedAt: null,
        healthyCameraCount: 0,
        totalCameraCount: 0,
      });
      expect(repository.findActiveEdgeInstallation).toHaveBeenCalledWith(
        'facility-session',
      );
      expect(repository.getCameraHealthCounts).toHaveBeenCalledWith(
        'facility-session',
      );
    });

    it('reports CONNECTED with pass-through timestamps and counts within the staleness window', async () => {
      const lastHeartbeatAt = new Date(Date.now() - 60 * 1000);
      const lastSyncedAt = new Date('2026-08-01T00:00:00.000Z');
      const repository = {
        findActiveEdgeInstallation: jest.fn().mockResolvedValue({
          lastHeartbeatAt,
          lastSyncedAt,
        }),
        getCameraHealthCounts: jest
          .fn()
          .mockResolvedValue({ healthy: 3, total: 4 }),
      };
      const service = new FacilitiesService(repository as never);

      await expect(service.getEdgeStatus('facility-session')).resolves.toEqual({
        connectionState: 'CONNECTED',
        lastHeartbeatAt: lastHeartbeatAt.toISOString(),
        lastSyncedAt: lastSyncedAt.toISOString(),
        healthyCameraCount: 3,
        totalCameraCount: 4,
      });
    });

    it('reports STALE when enrolled but the heartbeat is missing or older than the staleness window', async () => {
      const staleHeartbeat = new Date(Date.now() - 10 * 60 * 1000);
      const withStaleHeartbeat = {
        findActiveEdgeInstallation: jest.fn().mockResolvedValue({
          lastHeartbeatAt: staleHeartbeat,
          lastSyncedAt: null,
        }),
        getCameraHealthCounts: jest
          .fn()
          .mockResolvedValue({ healthy: 0, total: 2 }),
      };
      await expect(
        new FacilitiesService(withStaleHeartbeat as never).getEdgeStatus(
          'facility-session',
        ),
      ).resolves.toMatchObject({ connectionState: 'STALE' });

      const withNoHeartbeat = {
        findActiveEdgeInstallation: jest.fn().mockResolvedValue({
          lastHeartbeatAt: null,
          lastSyncedAt: null,
        }),
        getCameraHealthCounts: jest
          .fn()
          .mockResolvedValue({ healthy: 0, total: 0 }),
      };
      await expect(
        new FacilitiesService(withNoHeartbeat as never).getEdgeStatus(
          'facility-session',
        ),
      ).resolves.toMatchObject({ connectionState: 'STALE' });
    });
  });
});
