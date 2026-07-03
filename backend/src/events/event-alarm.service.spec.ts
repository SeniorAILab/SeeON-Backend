import { EventAlarmService } from './event-alarm.service.js';
import type {
  EventRecorderService,
  RecordedEventResult,
} from './event-recorder.service.js';
import type { AlertWriterService } from '../alerts/alert-writer.service.js';
import type { CamerasService } from '../cameras/cameras.service.js';

const event = {
  id: 'event-1',
  facilityId: 'facility-1',
  cameraId: 'camera-1',
  spaceId: 'space-1',
  type: 'fall',
  confidence: 0.91,
  detectedAt: new Date('2026-06-26T00:00:00.000Z'),
  dedupKey: 'dedup-1',
  createdAt: new Date('2026-06-26T00:00:01.000Z'),
  modifiedAt: new Date('2026-06-26T00:00:01.000Z'),
};

function setup(recordedEvent = event) {
  const recorder = {
    record: jest.fn().mockResolvedValue({
      event: recordedEvent,
      duplicate: false,
    } satisfies RecordedEventResult),
  } as unknown as jest.Mocked<EventRecorderService>;
  const cameras = {
    recordOffline: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<CamerasService>;
  const writer = {
    writeAlert: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<AlertWriterService>;
  return {
    service: new EventAlarmService(recorder, cameras, writer),
    recorder,
    cameras,
    writer,
  };
}

describe('EventAlarmService', () => {
  it('dispatches valid events to AlertWriter with originEventId and shared dedup key', async () => {
    const { service, writer } = setup();

    await service.record({
      cameraId: event.cameraId,
      type: event.type,
      detectedAt: event.detectedAt,
      confidence: event.confidence,
    });

    expect(writer.writeAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        facilityId: event.facilityId,
        cameraId: event.cameraId,
        idempotencyKey: event.dedupKey,
        originEventId: event.id,
        type: event.type,
        probability: event.confidence,
      }),
    );
  });

  it('routes detection-lost to camera offline without writing an alert', async () => {
    const detectionLost = { ...event, type: 'detection-lost' };
    const { service, cameras, writer } = setup(detectionLost);

    await service.record({
      cameraId: detectionLost.cameraId,
      type: detectionLost.type,
      detectedAt: detectionLost.detectedAt,
      confidence: detectionLost.confidence,
    });

    expect(cameras.recordOffline).toHaveBeenCalledWith(
      detectionLost.facilityId,
      detectionLost.cameraId,
    );
    expect(writer.writeAlert).not.toHaveBeenCalled();
  });
});
