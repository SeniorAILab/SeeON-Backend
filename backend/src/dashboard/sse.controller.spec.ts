import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AlertWriterService } from '../alerts/alert-writer.service';
import { AlertsService } from '../alerts/alerts.service';
import { AuthService } from '../auth/auth.service';
import { configureVersionedTestApp } from '../../test/helpers/versioned-app';
import {
  DashboardStreamController,
  formatAlertEvent,
  formatAlertUpdateEvent,
  SSE_REAUTH_INTERVAL_MS,
} from './sse.controller';

describe('formatAlertEvent', () => {
  it('serializes exactly the pinned alert payload fields', () => {
    const frame = formatAlertEvent(alertEvent(42n, 'alert-1'));
    const payload = JSON.parse(frame.split('data: ')[1]) as Record<
      string,
      unknown
    >;

    expect(frame).toContain('id: 42\n');
    expect(frame).toContain('event: alert\n');
    expect(Object.keys(payload).sort()).toEqual(
      [
        'alertSeq',
        'backendEventId',
        'cameraId',
        'detectedAt',
        'facilityId',
        'id',
        'probability',
        'spaceId',
        'status',
        'type',
      ].sort(),
    );
    expect(payload).toMatchObject({
      id: 'alert-1',
      backendEventId: 'event-alert-1',
      alertSeq: '42',
      facilityId: 'facility-1',
      spaceId: 'sp_201',
      cameraId: 'cam_sp_201',
      type: 'bed-exit',
      status: 'NEW',
      probability: 0.91,
    });
  });
});

describe('formatAlertUpdateEvent', () => {
  it('serializes exactly the pinned alert-updated payload fields and NO id line', () => {
    const frame = formatAlertUpdateEvent({
      alertSeq: 42n,
      id: 'alert-1',
      facilityId: 'facility-1',
      spaceId: 'space-1',
      status: 'RESOLVED',
      ackedById: null,
      ackedAt: null,
      resolvedById: 'user-1',
      resolvedAt: new Date('2026-06-22T00:05:00Z'),
    });
    const payload = JSON.parse(frame.split('data: ')[1]) as Record<
      string,
      unknown
    >;

    expect(frame).toContain('event: alert-updated\n');
    expect(frame).not.toMatch(/^id:/m);
    expect(Object.keys(payload).sort()).toEqual(
      [
        'alertSeq',
        'id',
        'resolvedAt',
        'resolvedById',
        'spaceId',
        'status',
      ].sort(),
    );
    expect(payload).toMatchObject({
      id: 'alert-1',
      alertSeq: '42',
      spaceId: 'space-1',
      status: 'RESOLVED',
      resolvedById: 'user-1',
    });
  });
});

describe('DashboardStreamController', () => {
  it('emits only replayed/live alert and alert-updated frames on the dashboard stream', async () => {
    const chunks: string[] = [];
    const unsubAlert = jest.fn();
    const unsubUpdates = jest.fn();
    let liveAlert: ((event: unknown) => void) | undefined;
    let liveUpdate: ((event: unknown) => void) | undefined;
    let closeHandler: (() => void) | undefined;

    const replayedAlert = alertEvent(2n, 'alert-replay');
    const liveAlertEvent = alertEvent(3n, 'alert-live');
    const liveUpdateEvent = alertUpdateEvent();
    const controller = new DashboardStreamController(
      {
        subscribe: jest.fn(
          (_facilityId: string, callback: (event: unknown) => void) => {
            liveAlert = callback;
            return unsubAlert;
          },
        ),
        subscribeUpdates: jest.fn(
          (_facilityId: string, callback: (event: unknown) => void) => {
            liveUpdate = callback;
            return unsubUpdates;
          },
        ),
      } as unknown as AlertWriterService,
      {
        replay: jest.fn().mockResolvedValue([replayedAlert]),
      } as unknown as AlertsService,
      {
        isSessionVersionCurrent: jest.fn().mockResolvedValue(true),
      } as unknown as AuthService,
      60_000,
    );

    await controller.sse(
      {
        headers: { 'last-event-id': '1' },
        user: { id: 'user-1', facilityId: 'facility-1', sessionVersion: 7 },
        socket: { on: jest.fn() },
        on: jest.fn((_event: string, callback: () => void) => {
          closeHandler = callback;
        }),
      } as unknown as Parameters<typeof controller.sse>[0],
      {
        flushHeaders: jest.fn(),
        write: jest.fn((chunk: string) => {
          chunks.push(chunk);
          return true;
        }),
        flush: jest.fn(),
        end: jest.fn(),
      } as unknown as Parameters<typeof controller.sse>[1],
    );

    liveAlert?.(liveAlertEvent);
    liveUpdate?.(liveUpdateEvent);
    closeHandler?.();

    expect(chunks).toContain(': connected\n\n');
    expect(chunks).toContain(formatAlertEvent(replayedAlert));
    expect(chunks).toContain(formatAlertEvent(liveAlertEvent));
    expect(chunks).toContain(formatAlertUpdateEvent(liveUpdateEvent));
    expect(
      chunks.filter((chunk) => chunk.includes('event: alert\n')),
    ).toHaveLength(2);
    expect(
      chunks.filter((chunk) => chunk.includes('event: alert-updated\n')),
    ).toHaveLength(1);
    expect(chunks.join('')).toContain('id: 2\nevent: alert\n');
    expect(chunks.join('')).toContain('id: 3\nevent: alert\n');
    expect(chunks.join('')).not.toContain('event: status\n');
    expect(chunks.join('')).not.toContain('event: status-snapshot\n');
    expect(unsubAlert).toHaveBeenCalledTimes(1);
    expect(unsubUpdates).toHaveBeenCalledTimes(1);
  });

  it('does not register the removed bare GET /api/v1/sse route', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DashboardStreamController],
      providers: [
        { provide: AlertWriterService, useValue: {} },
        { provide: AlertsService, useValue: {} },
        { provide: AuthService, useValue: {} },
        { provide: SSE_REAUTH_INTERVAL_MS, useValue: 60_000 },
      ],
    }).compile();
    const app: INestApplication = moduleRef.createNestApplication();
    configureVersionedTestApp(app);
    await app.init();

    await request(app.getHttpServer() as Parameters<typeof request>[0])
      .get('/api/v1/sse')
      .expect(404);

    await app.close();
  });
});

function alertEvent(alertSeq: bigint, id: string) {
  return {
    alertSeq,
    id,
    originEventId: `event-${id}`,
    facilityId: 'facility-1',
    cameraId: 'cam_sp_201',
    spaceId: 'sp_201',
    room: '201호',
    space: { name: '201호' },
    type: 'bed-exit',
    probability: 0.91,
    snapshotKey: null,
    detectedAt: new Date(`2026-06-22T00:00:0${alertSeq}.000Z`),
    status: 'NEW',
  };
}

function alertUpdateEvent() {
  return {
    alertSeq: 3n,
    id: 'alert-live',
    facilityId: 'facility-1',
    spaceId: 'sp_201',
    status: 'RESOLVED',
    ackedById: null,
    ackedAt: null,
    resolvedById: 'user-1',
    resolvedAt: new Date('2026-06-22T00:05:00Z'),
  };
}
