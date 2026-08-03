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

type AlertNoteDelegate = {
  create: jest.Mock;
  count: jest.Mock;
};

function setup() {
  const alert: AlertDelegate = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  };
  const alertNote: AlertNoteDelegate = {
    create: jest.fn(),
    // 기본은 조치 기록이 하나 있는 상태(해결 가능).
    count: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    withFacilityContext: jest.fn(
      (
        _facilityId: string,
        cb: (tx: {
          alert: AlertDelegate;
          alertNote: AlertNoteDelegate;
        }) => unknown,
      ) => cb({ alert, alertNote }),
    ),
  } as unknown as PrismaService;
  const ackAlert = jest.fn();
  const resolveAlert = jest.fn();
  const writer = { ackAlert, resolveAlert } as unknown as AlertWriterService;
  return {
    service: new AlertsService(prisma, writer),
    alert,
    alertNote,
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

  it('creates an alert note with alert-derived facility and snapshotted actor role', async () => {
    const { service, alert, alertNote } = setup();
    alert.findUnique.mockResolvedValue({ id: 'a1', facilityId: 'facility-1' });
    alertNote.create.mockResolvedValue({
      id: 'note-1',
      note: 'checked with nurse',
      createdById: 'user-1',
      authorRole: 'STAFF',
      createdAt: new Date('2026-07-03T00:00:00Z'),
    });

    const result = await service.addNote({
      facilityId: 'facility-1',
      alertId: 'a1',
      note: ' checked with nurse ',
      actorUserId: 'user-1',
      actorRole: 'STAFF',
    });

    expect(alertNote.create).toHaveBeenCalledWith({
      data: {
        facilityId: 'facility-1',
        alertId: 'a1',
        note: 'checked with nurse',
        createdById: 'user-1',
        authorRole: 'STAFF',
      },
      select: {
        id: true,
        note: true,
        createdById: true,
        authorRole: true,
        createdAt: true,
      },
    });
    expect(result).toMatchObject({
      note: 'checked with nurse',
      createdBy: 'user-1',
      authorRole: 'STAFF',
    });
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
    notes: [],
    ...overrides,
  };
}

describe('AlertsService — 확인/해결 2단계 분리 (I4)', () => {
  it('ack는 ACKED 전이만 하고 resolve를 부르지 않는다', async () => {
    const { service, ackAlert, resolveAlert } = setup();

    await service.ack('facility-1', 'alert-1', 'user-1');

    expect(ackAlert).toHaveBeenCalledWith({
      facilityId: 'facility-1',
      alertId: 'alert-1',
      actorUserId: 'user-1',
    });
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it('조치 기록이 없으면 해결 완료를 거부한다', async () => {
    const { service, alertNote, resolveAlert } = setup();
    alertNote.count.mockResolvedValue(0);

    await expect(
      service.resolve('facility-1', 'alert-1', 'user-1'),
    ).rejects.toThrow('조치 결과를 먼저 기록해야 해결 완료로 바꿀 수 있습니다.');
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it('조치 기록이 있으면 해결 완료가 통과한다', async () => {
    const { service, alertNote, resolveAlert } = setup();
    alertNote.count.mockResolvedValue(1);

    await service.resolve('facility-1', 'alert-1', 'user-1');

    expect(resolveAlert).toHaveBeenCalledWith({
      facilityId: 'facility-1',
      alertId: 'alert-1',
      actorUserId: 'user-1',
    });
  });

  it('메모 개수는 해당 알림으로만 센다', async () => {
    const { service, alertNote } = setup();
    alertNote.count.mockResolvedValue(2);

    await service.resolve('facility-1', 'alert-42', 'user-1');

    expect(alertNote.count).toHaveBeenCalledWith({ where: { alertId: 'alert-42' } });
  });
});
