import { NotFoundException } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import type { EventAlarmService } from './event-alarm.service.js';
import type { EventRecorderService } from './event-recorder.service.js';
import type { CamerasService } from '../cameras/cameras.service.js';

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

    await expect(controller.heartbeat({ camera_id: 'camera-1' })).resolves.toEqual({ ok: true });

    expect(cameras.resolveForEventIngest).toHaveBeenCalledWith('camera-1');
    expect(cameras.recordHeartbeat).toHaveBeenCalledWith('facility-1', 'camera-1');
  });

  it('propagates unknown camera rejection without recording a heartbeat', async () => {
    const eventAlarm = {} as EventAlarmService;
    const recorder = {} as EventRecorderService;
    const cameras = {
      resolveForEventIngest: jest.fn().mockRejectedValue(new NotFoundException('unknown_camera')),
      recordHeartbeat: jest.fn(),
    } as unknown as jest.Mocked<CamerasService>;
    const controller = new EventsController(eventAlarm, recorder, cameras);

    await expect(controller.heartbeat({ camera_id: 'missing-camera' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(cameras.recordHeartbeat).not.toHaveBeenCalled();
  });
});
