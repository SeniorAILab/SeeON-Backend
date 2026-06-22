import { BadRequestException } from '@nestjs/common';
import { ResidentState } from '@prisma/client';
import { AlertEventTypes } from './dto/alert-events.dto';

import type { PrismaService } from '../prisma/prisma.service';
import {
  AlertWriterService,
  type AlertEvent,
  type StatusEvent,
} from './alert-writer.service';

function setup() {
  const tx = {
    alert: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          alertSeq: 1n,
          id: 'a1',
          status: 'NEW',
          resident: null,
          space: { name: 'Room 101' },
          ...data,
        }),
      ),
    },
    residentStatus: { upsert: jest.fn().mockResolvedValue({}) },
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
    residentId: 'r1',
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
    expect(event.id).toBe('a1');
    expect(event.residentId).toBe('r1');
    expect(event.spaceId).toBe('space-1');
    expect(event.room).toBe('Room 101');
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('a1');
  });
  it('persists empty-room alerts without creating ResidentStatus or status events', async () => {
    const { service, tx } = setup();
    const statuses: StatusEvent[] = [];
    service.subscribeStatus('facility-1', (e) => statuses.push(e));

    const event = await service.writeAlert({ ...input(0.9), residentId: null });

    expect(event.residentId).toBeNull();
    expect(event.room).toBe('Room 101');
    expect(tx.residentStatus.upsert).not.toHaveBeenCalled();
    expect(statuses).toHaveLength(0);
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

  it.each([
    [0.9, ResidentState.FALL],
    [0.6, ResidentState.WARNING],
    [0.1, ResidentState.NORMAL],
  ])('maps probability %s to resident state %s', async (p, state) => {
    const { service } = setup();
    const statuses: StatusEvent[] = [];
    service.subscribeStatus('facility-1', (e) => statuses.push(e));
    await service.writeAlert(input(p));
    expect(statuses[0].state).toBe(state);
  });

  it('maps bed-exit alerts to WARNING regardless of probability', async () => {
    const { service } = setup();
    const statuses: StatusEvent[] = [];
    service.subscribeStatus('facility-1', (e) => statuses.push(e));

    await service.writeAlert({
      ...input(0.1),
      type: AlertEventTypes.bedExit,
    });

    expect(statuses[0].state).toBe(ResidentState.WARNING);
  });

  it('keeps high-probability fall alerts mapped to FALL', async () => {
    const { service } = setup();
    const statuses: StatusEvent[] = [];
    service.subscribeStatus('facility-1', (e) => statuses.push(e));

    await service.writeAlert(input(0.9));

    expect(statuses[0].state).toBe(ResidentState.FALL);
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
