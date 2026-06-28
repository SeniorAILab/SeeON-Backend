import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AlertWriterService } from '../alerts/alert-writer.service';
import { AlertsService } from '../alerts/alerts.service';
import { SessionService } from '../auth/session.service';
import { StatusService } from '../status/status.service';
import { configureVersionedTestApp } from '../../test/helpers/versioned-app';
import {
  DashboardStreamController,
  formatAlertEvent,
  formatAlertUpdateEvent,
  SSE_REAUTH_INTERVAL_MS,
} from './sse.controller';

describe('formatAlertEvent', () => {
  it('serializes alertSeq as string with spaceId and room context', () => {
    const frame = formatAlertEvent({
      alertSeq: 42n,
      id: 'alert-1',
      facilityId: 'facility-1',
      residentId: 'resident-1',
      cameraId: 'camera-1',
      spaceId: 'space-1',
      room: 'Room 101',
      space: { name: 'Room 101' },
      type: 'fall',
      probability: 0.91,
      snapshotKey: null,
      detectedAt: new Date('2026-06-22T00:00:00Z'),
      status: 'NEW',
      resident: { name: '홍길동' },
    });

    const payload = JSON.parse(frame.split('data: ')[1]) as {
      alertSeq: string;
      spaceId: string;
      room: string;
      space: { name: string };
    };
    expect(payload.alertSeq).toBe('42');
    expect(payload.spaceId).toBe('space-1');
    expect(payload.room).toBe('Room 101');
    expect(payload.space).toEqual({ name: 'Room 101' });
  });
});

describe('DashboardStreamController', () => {
  it('emits replayed alert, status snapshot, live alert, and live status frames on the dashboard stream', async () => {
    const chunks: string[] = [];
    const unsubAlert = jest.fn();
    const unsubStatus = jest.fn();
    let liveAlert: ((event: unknown) => void) | undefined;
    let liveStatus: ((event: unknown) => void) | undefined;
    let closeHandler: (() => void) | undefined;

    const replayedAlert = alertEvent(2n, 'alert-replay');
    const liveAlertEvent = alertEvent(3n, 'alert-live');
    const liveStatusEvent = statusEvent(4n);
    const controller = new DashboardStreamController(
      {
        subscribe: jest.fn(
          (_facilityId: string, callback: (event: unknown) => void) => {
            liveAlert = callback;
            return unsubAlert;
          },
        ),
        subscribeStatus: jest.fn(
          (_facilityId: string, callback: (event: unknown) => void) => {
            liveStatus = callback;
            return unsubStatus;
          },
        ),
        subscribeUpdates: jest.fn(
          (_facilityId: string, _callback: (event: unknown) => void) => {
            return jest.fn();
          },
        ),
      } as unknown as AlertWriterService,
      {
        replay: jest.fn().mockResolvedValue([replayedAlert]),
      } as unknown as AlertsService,
      {
        listByFacility: jest
          .fn()
          .mockResolvedValue([{ residentId: 'res-1', state: 'NORMAL' }]),
      } as unknown as StatusService,
      {
        checkActive: jest.fn().mockResolvedValue(true),
      } as unknown as SessionService,
      60_000,
    );

    await controller.sse(
      {
        headers: { 'last-event-id': '1' },
        user: { facilityId: 'facility-1', sessionVersion: 7 },
        sessionId: 'session-1',
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
    liveStatus?.(liveStatusEvent);
    closeHandler?.();

    expect(chunks).toContain(': connected\n\n');
    expect(chunks).toContain(formatAlertEvent(replayedAlert));
    expect(chunks).toContain(formatAlertEvent(liveAlertEvent));
    expect(chunks).toContain(
      'event: status-snapshot\ndata: [{"residentId":"res-1","state":"NORMAL"}]\n\n',
    );
    expect(chunks).toContain(
      'id: 4\nevent: status\ndata: {"alertSeq":"4","facilityId":"facility-1","residentId":"res-1","state":"WARNING","cameraOnline":true,"lastSeenAt":"2026-06-22T00:00:04.000Z"}\n\n',
    );
    expect(unsubAlert).toHaveBeenCalledTimes(1);
    expect(unsubStatus).toHaveBeenCalledTimes(1);
  });

  it('does not register the removed bare GET /api/v1/sse route', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DashboardStreamController],
      providers: [
        { provide: AlertWriterService, useValue: {} },
        { provide: AlertsService, useValue: {} },
        { provide: StatusService, useValue: {} },
        { provide: SessionService, useValue: {} },
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
    facilityId: 'facility-1',
    residentId: null,
    cameraId: 'cam_sp_201',
    spaceId: 'sp_201',
    room: '201호',
    space: { name: '201호' },
    type: 'bed-exit',
    probability: 0.91,
    snapshotKey: null,
    detectedAt: new Date(`2026-06-22T00:00:0${alertSeq}.000Z`),
    status: 'NEW',
    resident: null,
  };
}

function statusEvent(alertSeq: bigint) {
  return {
    alertSeq,
    facilityId: 'facility-1',
    residentId: 'res-1',
    state: 'WARNING',
    cameraOnline: true,
    lastSeenAt: new Date('2026-06-22T00:00:04.000Z'),
  };
}
describe('formatAlertUpdateEvent', () => {
  it('emits a named alert-updated frame with lifecycle fields and NO id: line', () => {
    const frame = formatAlertUpdateEvent({
      alertSeq: 42n,
      id: 'alert-1',
      facilityId: 'facility-1',
      status: 'ACKED',
      ackedById: 'user-1',
      ackedAt: new Date('2026-06-22T00:05:00Z'),
      resolvedById: null,
      resolvedAt: null,
    });

    expect(frame).toContain('event: alert-updated\n');
    // Replay-cursor safety: lifecycle updates are live-only, never carry an SSE id.
    expect(frame).not.toMatch(/^id:/m);

    const payload = JSON.parse(frame.split('data: ')[1]) as {
      alertSeq: string;
      id: string;
      status: string;
      ackedById: string | null;
    };
    expect(payload.alertSeq).toBe('42');
    expect(payload.id).toBe('alert-1');
    expect(payload.status).toBe('ACKED');
    expect(payload.ackedById).toBe('user-1');
  });
});
