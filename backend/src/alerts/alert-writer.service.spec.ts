import { ResidentState } from '@prisma/client';
import { AlertEventTypes } from './dto/alert-events.dto';

import { PrismaService } from '../prisma/prisma.service';
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
          ...data,
        }),
      ),
    },
    residentStatus: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    withOrgContext: jest.fn((_orgId: string, cb: (t: typeof tx) => unknown) =>
      cb(tx),
    ),
  } as unknown as PrismaService;
  return { service: new AlertWriterService(prisma), tx };
}

function input(probability: number) {
  return {
    orgId: 'org-1',
    residentId: 'r1',
    cameraId: 'c1',
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
    service.subscribe('org-1', (e) => received.push(e));

    const event = await service.writeAlert(input(0.9));
    expect(event.id).toBe('a1');
    expect(event.residentId).toBe('r1');
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('a1');
  });

  it.each([
    [0.9, ResidentState.FALL],
    [0.6, ResidentState.WARNING],
    [0.1, ResidentState.NORMAL],
  ])('maps probability %s to resident state %s', async (p, state) => {
    const { service } = setup();
    const statuses: StatusEvent[] = [];
    service.subscribeStatus('org-1', (e) => statuses.push(e));
    await service.writeAlert(input(p));
    expect(statuses[0].state).toBe(state);
  });

  it('maps bed-exit alerts to WARNING regardless of probability', async () => {
    const { service } = setup();
    const statuses: StatusEvent[] = [];
    service.subscribeStatus('org-1', (e) => statuses.push(e));

    await service.writeAlert({
      ...input(0.1),
      type: AlertEventTypes.bedExit,
    });

    expect(statuses[0].state).toBe(ResidentState.WARNING);
  });

  it('keeps high-probability fall alerts mapped to FALL', async () => {
    const { service } = setup();
    const statuses: StatusEvent[] = [];
    service.subscribeStatus('org-1', (e) => statuses.push(e));

    await service.writeAlert(input(0.9));

    expect(statuses[0].state).toBe(ResidentState.FALL);
  });

  it('stops delivering after unsubscribe', async () => {
    const { service } = setup();
    const received: AlertEvent[] = [];
    const off = service.subscribe('org-1', (e) => received.push(e));
    off();
    await service.writeAlert(input(0.9));
    expect(received).toHaveLength(0);
  });

  it('only notifies subscribers of the same org', async () => {
    const { service } = setup();
    const other: AlertEvent[] = [];
    service.subscribe('org-2', (e) => other.push(e));
    await service.writeAlert(input(0.9));
    expect(other).toHaveLength(0);
  });
});
