import { FacilityScopedNotFoundException } from '../common/domain-errors';
import type { PrismaService } from '../prisma/prisma.service';
import type { AlertWriterService } from './alert-writer.service';
import { AlertsService } from './alerts.service';

type FindManyArg = {
  where: { alertSeq?: { gt?: bigint; lt?: bigint } };
  take: number;
  orderBy: { alertSeq: 'desc' };
};

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
  const ackAlert = jest.fn();
  const resolveAlert = jest.fn();
  const writer = { ackAlert, resolveAlert } as unknown as AlertWriterService;
  return {
    service: new AlertsService(prisma, writer),
    alert,
    ackAlert,
    resolveAlert,
  };
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

  it('delegates ack to the lifecycle writer with the session actor', async () => {
    const { service, ackAlert } = setup();
    ackAlert.mockResolvedValue({ id: 'a1', status: 'ACKED' });
    const result = await service.ack('facility-1', 'a1', 'user-1');
    expect(ackAlert).toHaveBeenCalledWith({
      facilityId: 'facility-1',
      alertId: 'a1',
      actorUserId: 'user-1',
    });
    expect(result).toMatchObject({ status: 'ACKED' });
  });

  it('delegates resolve to the lifecycle writer with the session actor', async () => {
    const { service, resolveAlert } = setup();
    resolveAlert.mockResolvedValue({ id: 'a1', status: 'RESOLVED' });
    const result = await service.resolve('facility-1', 'a1', 'user-2');
    expect(resolveAlert).toHaveBeenCalledWith({
      facilityId: 'facility-1',
      alertId: 'a1',
      actorUserId: 'user-2',
    });
    expect(result).toMatchObject({ status: 'RESOLVED' });
  });

  it('does not write Alert state directly from the service (writer owns mutation)', async () => {
    const { service, alert, ackAlert } = setup();
    ackAlert.mockResolvedValue({ id: 'a1' });
    await service.ack('facility-1', 'a1', 'user-1');
    expect(alert.update).not.toHaveBeenCalled();
  });

  it('serializes room-only alerts with lifecycle fields', async () => {
    const { service, alert } = setup();
    alert.findUnique.mockResolvedValue(
      alertRow({
        space: { name: 'Room 101' },
      }),
    );

    const result = await service.getOne('facility-1', 'a1');

    expect(result).toMatchObject({
      spaceId: 'space-1',
      room: 'Room 101',
      ackedById: null,
      resolvedById: null,
    });
  });
});

function alertRow(overrides: Record<string, unknown> = {}) {
  return {
    alertSeq: 1n,
    id: 'a1',
    facilityId: 'facility-1',
    cameraId: 'c1',
    spaceId: 'space-1',
    type: 'fall',
    probability: 0.9,
    snapshotKey: null,
    detectedAt: new Date('2026-06-22T00:00:00Z'),
    status: 'NEW',
    ackedById: null,
    ackedAt: null,
    ackedBy: null,
    resolvedById: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: new Date('2026-06-22T00:00:01Z'),
    space: { name: 'Room 101' },
    ...overrides,
  };
}
