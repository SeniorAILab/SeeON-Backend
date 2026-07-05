import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { AlertStatus } from '@prisma/client';
import { AlertEventTypes } from './dto/alert-events.dto';

import type { PrismaService } from '../prisma/prisma.service';
import {
  AlertWriterService,
  type AlertEvent,
  type AlertUpdateEvent,
} from './alert-writer.service';
import { FacilityScopedNotFoundException } from '../common/domain-errors';

function setup() {
  const tx = {
    alert: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          alertSeq: 1n,
          id: 'a1',
          status: 'NEW',
          space: { name: 'Room 101' },
          ...data,
        }),
      ),
    },
  };
  const prisma = {
    withFacilityContext: jest.fn(
      (_facilityId: string, cb: (t: typeof tx) => unknown) => cb(tx),
    ),
  } as unknown as PrismaService;
  return { service: new AlertWriterService(prisma), tx };
}

function input(probability: number) {
  return {
    facilityId: 'facility-1',
    cameraId: 'c1',
    spaceId: 'space-1',
    type: AlertEventTypes.fall,
    probability,
    snapshotKey: null,
    detectedAt: new Date(),
    idempotencyKey: `k-${probability}`,
  };
}

describe('AlertWriterService', () => {
  it('persists, returns the mapped event, and notifies alert subscribers', async () => {
    const { service } = setup();
    const received: AlertEvent[] = [];
    service.subscribe('facility-1', (e) => received.push(e));

    const event = await service.writeAlert(input(0.9));
    expect(event.created).toBe(true);
    expect(event.id).toBe('a1');
    expect(event.spaceId).toBe('space-1');
    expect(event.room).toBe('Room 101');
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('a1');
  });
  it('logs a room-centric write without leaking resident-keyed data', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const { service } = setup();

    const event = await service.writeAlert(input(0.9));

    expect(event.room).toBe('Room 101');
    expect(logSpy).toHaveBeenCalledWith({
      event: 'alert.room_written',
      facilityId: 'facility-1',
      spaceId: 'space-1',
      cameraId: 'c1',
      alertId: 'a1',
      alertSeq: '1',
    });
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('Resident');
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('Room 101');
  });

  it('rejects roomless writes before touching the database', async () => {
    const { service, tx } = setup();

    await expect(
      service.writeAlert({ ...input(0.9), spaceId: null } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.writeAlert({ ...input(0.9), spaceId: '  ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.alert.create).not.toHaveBeenCalled();
  });

  it('persists ML type and probability as-is', async () => {
    const { service, tx } = setup();

    await service.writeAlert({ ...input(0.1), type: AlertEventTypes.fall });

    expect(tx.alert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: AlertEventTypes.fall,
          probability: 0.1,
        }),
      }),
    );
  });

  it('stops delivering after unsubscribe', async () => {
    const { service } = setup();
    const received: AlertEvent[] = [];
    const off = service.subscribe('facility-1', (e) => received.push(e));
    off();
    await service.writeAlert(input(0.9));
    expect(received).toHaveLength(0);
  });

  it('only notifies subscribers of the same facility', async () => {
    const { service } = setup();
    const other: AlertEvent[] = [];
    service.subscribe('facility-2', (e) => other.push(e));
    await service.writeAlert(input(0.9));
    expect(other).toHaveLength(0);
  });
});

function lifecycleRow(
  status: AlertStatus,
  overrides: Record<string, unknown> = {},
) {
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
    status,
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

function lifecycleSetup(initialStatus: AlertStatus) {
  let row = lifecycleRow(initialStatus);
  const tx = {
    alert: {
      findUnique: jest.fn(() => Promise.resolve({ ...row })),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        row = { ...row, ...data };
        return Promise.resolve({ ...row });
      }),
    },
  };
  const prisma = {
    withFacilityContext: jest.fn(
      (_facilityId: string, cb: (t: typeof tx) => unknown) => cb(tx),
    ),
  } as unknown as PrismaService;
  return { service: new AlertWriterService(prisma), tx, getRow: () => row };
}

const lifecycleInput = {
  facilityId: 'facility-1',
  alertId: 'a1',
  actorUserId: 'user-1',
};

describe('AlertWriterService lifecycle (ack/resolve)', () => {
  it('acks NEW → ACKED, stamps the actor, and emits an update', async () => {
    const { service, tx } = lifecycleSetup(AlertStatus.NEW);
    const updates: AlertUpdateEvent[] = [];
    service.subscribeUpdates('facility-1', (e) => updates.push(e));

    const result = await service.ackAlert(lifecycleInput);

    const [[updateArg]] = tx.alert.update.mock.calls as [
      [{ data: Record<string, unknown> }],
    ];
    expect(updateArg.data.status).toBe(AlertStatus.ACKED);
    expect(updateArg.data.ackedById).toBe('user-1');
    expect(updateArg.data.ackedAt).toBeInstanceOf(Date);
    expect(result.status).toBe(AlertStatus.ACKED);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: 'a1', status: AlertStatus.ACKED });
  });

  it('resolves ACKED → RESOLVED, stamps the actor, and emits an update', async () => {
    const { service, tx } = lifecycleSetup(AlertStatus.ACKED);
    const updates: AlertUpdateEvent[] = [];
    service.subscribeUpdates('facility-1', (e) => updates.push(e));

    const result = await service.resolveAlert({
      ...lifecycleInput,
      actorUserId: 'user-2',
    });

    const [[updateArg]] = tx.alert.update.mock.calls as [
      [{ data: Record<string, unknown> }],
    ];
    expect(updateArg.data.status).toBe(AlertStatus.RESOLVED);
    expect(updateArg.data.resolvedById).toBe('user-2');
    expect(result.status).toBe(AlertStatus.RESOLVED);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: AlertStatus.RESOLVED,
      spaceId: 'space-1',
    });
  });

  it('re-ack of an ACKED alert is an idempotent no-op (no update, no emit, no restamp)', async () => {
    const { service, tx } = lifecycleSetup(AlertStatus.ACKED);
    const updates: AlertUpdateEvent[] = [];
    service.subscribeUpdates('facility-1', (e) => updates.push(e));

    await service.ackAlert(lifecycleInput);

    expect(tx.alert.update).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('re-resolve of a RESOLVED alert is an idempotent no-op', async () => {
    const { service, tx } = lifecycleSetup(AlertStatus.RESOLVED);
    const updates: AlertUpdateEvent[] = [];
    service.subscribeUpdates('facility-1', (e) => updates.push(e));

    await service.resolveAlert(lifecycleInput);

    expect(tx.alert.update).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('resolves NEW → RESOLVED, stamps the actor, and emits an update', async () => {
    const { service, tx } = lifecycleSetup(AlertStatus.NEW);
    const updates: AlertUpdateEvent[] = [];
    service.subscribeUpdates('facility-1', (e) => updates.push(e));

    const result = await service.resolveAlert(lifecycleInput);

    expect(tx.alert.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AlertStatus.RESOLVED,
          resolvedById: 'user-1',
          resolvedAt: expect.any(Date),
        }),
      }),
    );
    expect(result.status).toBe(AlertStatus.RESOLVED);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: 'a1',
      status: AlertStatus.RESOLVED,
      spaceId: 'space-1',
    });
  });

  it('rejects RESOLVED → ACKED with a Conflict', async () => {
    const { service, tx } = lifecycleSetup(AlertStatus.RESOLVED);
    await expect(service.ackAlert(lifecycleInput)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.alert.update).not.toHaveBeenCalled();
  });

  it('throws FacilityScopedNotFoundException for a missing alert', async () => {
    const { service, tx } = lifecycleSetup(AlertStatus.NEW);
    tx.alert.findUnique.mockResolvedValueOnce(null as never);
    await expect(service.ackAlert(lifecycleInput)).rejects.toBeInstanceOf(
      FacilityScopedNotFoundException,
    );
  });

  it('only notifies update subscribers of the same facility', async () => {
    const { service } = lifecycleSetup(AlertStatus.NEW);
    const other: AlertUpdateEvent[] = [];
    service.subscribeUpdates('facility-2', (e) => other.push(e));
    await service.ackAlert(lifecycleInput);
    expect(other).toHaveLength(0);
  });
});
