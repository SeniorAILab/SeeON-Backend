import { NotFoundException } from '@nestjs/common';
import { AlertStatus } from '@prisma/client';

import { FacilityScopedNotFoundException } from '../common/domain-errors';
import type { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from './alerts.service';

type FindManyArg = {
  where: { alertSeq?: { gt?: bigint; lt?: bigint } };
  take: number;
  orderBy: { alertSeq: 'desc' };
};

type UpdateArg = { data: { status: AlertStatus } };

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

    const [[arg]] = alert.findMany.mock.calls as [[FindManyArg]];
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
    alert.update.mockResolvedValue(alertRow({ status: AlertStatus.ACKED }));
    const result = await service.ack('facility-1', 'a1');
    const [[updateArg]] = alert.update.mock.calls as [[UpdateArg]];
    expect(updateArg.data).toEqual({
      status: AlertStatus.ACKED,
    });
    expect(result).toMatchObject({
      alertSeq: '1',
      spaceId: 'space-1',
      room: 'Room 101',
    });
  });
  it('serializes room-only alerts with null resident fields', async () => {
    const { service, alert } = setup();
    alert.findUnique.mockResolvedValue(
      alertRow({
        residentId: null,
        resident: null,
        space: { name: 'Room 101' },
      }),
    );

    const result = await service.getOne('facility-1', 'a1');

    expect(result).toMatchObject({
      residentId: null,
      resident: null,
      spaceId: 'space-1',
      room: 'Room 101',
    });
  });
});

function alertRow(overrides: Record<string, unknown> = {}) {
  return {
    alertSeq: 1n,
    id: 'a1',
    facilityId: 'facility-1',
    residentId: 'r1',
    cameraId: 'c1',
    spaceId: 'space-1',
    type: 'fall',
    probability: 0.9,
    snapshotKey: null,
    detectedAt: new Date('2026-06-22T00:00:00Z'),
    status: AlertStatus.NEW,
    createdAt: new Date('2026-06-22T00:00:01Z'),
    resident: { name: '홍길동' },
    space: { name: 'Room 101' },
    ...overrides,
  };
}
