import { NotFoundException } from '@nestjs/common';
import { AlertStatus } from '@prisma/client';

import { FacilityScopedNotFoundException } from '../common/domain-errors';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from './alerts.service';

type AlertDelegate = {
  findMany: jest.Mock;
  findUnique: jest.Mock;
  update: jest.Mock;
};

function setup() {
  const alert: AlertDelegate = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  };
  const prisma = {
    withFacilityContext: jest.fn(
      (_facilityId: string, cb: (tx: { alert: AlertDelegate }) => unknown) =>
        cb({ alert }),
    ),
  } as unknown as PrismaService;
  return { service: new AlertsService(prisma), alert };
}

describe('AlertsService (read-model)', () => {
  it('applies the afterSeq forward cursor and caps the page size at 200', async () => {
    const { service, alert } = setup();
    alert.findMany.mockResolvedValue([]);
    await service.list('facility-1', { afterSeq: 10n, limit: 9999 });

    const arg = alert.findMany.mock.calls[0][0];
    expect(arg.where.alertSeq).toEqual({ gt: 10n });
    expect(arg.take).toBe(200);
    expect(arg.orderBy).toEqual({ alertSeq: 'desc' });
  });

  it('throws FacilityScopedNotFoundException when getOne misses', async () => {
    const { service, alert } = setup();
    alert.findUnique.mockResolvedValue(null);
    await expect(
      service.getOne('facility-1', 'missing'),
    ).rejects.toBeInstanceOf(FacilityScopedNotFoundException);
  });

  it('throws NotFound when acking a missing alert', async () => {
    const { service, alert } = setup();
    alert.findUnique.mockResolvedValue(null);
    await expect(service.ack('facility-1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(alert.update).not.toHaveBeenCalled();
  });

  it('marks an existing alert ACKED', async () => {
    const { service, alert } = setup();
    alert.findUnique.mockResolvedValue({ id: 'a1' });
    alert.update.mockResolvedValue({ id: 'a1', status: AlertStatus.ACKED });
    await service.ack('facility-1', 'a1');
    expect(alert.update.mock.calls[0][0].data).toEqual({
      status: AlertStatus.ACKED,
    });
  });
});
