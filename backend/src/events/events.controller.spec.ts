import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import type { EventAlarmService } from './event-alarm.service.js';
import type { EventRecorderService } from './event-recorder.service.js';
import type { CamerasService } from '../cameras/cameras.service.js';

describe('EventsController record', () => {
  it('rejects unsupported event types before recording', async () => {
    const eventAlarm = {
      record: jest.fn(),
    } as unknown as jest.Mocked<EventAlarmService>;
    const recorder = {} as EventRecorderService;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.record({
        camera_id: 'camera-1',
        type: 'foo',
        detected_at: '2026-06-26T01:02:03.456Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(eventAlarm.record).not.toHaveBeenCalled();
  });

  it('canonicalizes valid event types before recording', async () => {
    const eventAlarm = {
      record: jest.fn().mockResolvedValue({
        event: { id: 'event-1' },
        duplicate: false,
      }),
    } as unknown as jest.Mocked<EventAlarmService>;
    const recorder = {} as EventRecorderService;
    const cameras = {} as CamerasService;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.record({
        camera_id: 'camera-1',
        type: ' DETECTION-LOST ',
        detected_at: '2026-06-26T01:02:03.456Z',
      }),
    ).resolves.toEqual({ id: 'event-1', status: 'created' });

    expect(eventAlarm.record).toHaveBeenCalledWith({
      cameraId: 'camera-1',
      type: 'detection-lost',
      detectedAt: new Date('2026-06-26T01:02:03.456Z'),
      confidence: undefined,
    });
  });
});
describe('EventsController heartbeat', () => {
  it('resolves the camera through event ingest and records a heartbeat', async () => {
    const eventAlarm = {} as EventAlarmService;
    const recorder = {} as EventRecorderService;
    const cameras = {
      resolveForEventIngest: jest.fn().mockResolvedValue({
        id: 'camera-1',
        facilityId: 'facility-1',
        spaceId: 'space-1',
      }),
      recordHeartbeat: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<CamerasService>;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.heartbeat({ camera_id: 'camera-1' }),
    ).resolves.toEqual({ ok: true });

    expect(cameras.resolveForEventIngest).toHaveBeenCalledWith('camera-1');
    expect(cameras.recordHeartbeat).toHaveBeenCalledWith(
      'facility-1',
      'camera-1',
    );
  });

  it('propagates unknown camera rejection without recording a heartbeat', async () => {
    const eventAlarm = {} as EventAlarmService;
    const recorder = {} as EventRecorderService;
    const cameras = {
      resolveForEventIngest: jest
        .fn()
        .mockRejectedValue(new NotFoundException('unknown_camera')),
      recordHeartbeat: jest.fn(),
    } as unknown as jest.Mocked<CamerasService>;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(
      controller.heartbeat({ camera_id: 'missing-camera' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(cameras.recordHeartbeat).not.toHaveBeenCalled();
  });
});
