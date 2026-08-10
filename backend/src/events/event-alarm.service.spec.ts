import { EventAlarmService } from './event-alarm.service.js';
import type {
  EventRecorderService,
  RecordedEventResult,
} from './event-recorder.service.js';
import type { AlertWriterService } from '../alerts/alert-writer.service.js';
import type { CamerasService } from '../cameras/cameras.service.js';

const event: RecordedEventResult['event'] = {
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
  configVersion: null,
  modelVersion: null,
  detectorVersion: null,
  operatingThreshold: null,
  snapshotKey: null,
  clockSource: null,
  clipId: null,
  edgeEventId: null,
  validationRunId: null,
};

function setup(recordedEvent = event) {
  const record = jest.fn<
    ReturnType<EventRecorderService['record']>,
    Parameters<EventRecorderService['record']>
  >();
  record.mockResolvedValue({
    event: recordedEvent,
    duplicate: false,
  } satisfies RecordedEventResult);
  const recordOffline = jest.fn<
    ReturnType<CamerasService['recordOffline']>,
    Parameters<CamerasService['recordOffline']>
  >();
  const writeAlert = jest.fn<
    ReturnType<AlertWriterService['writeAlert']>,
    Parameters<AlertWriterService['writeAlert']>
  >();
  const recorder = {
    record,
  } as unknown as jest.Mocked<EventRecorderService>;
  const cameras = {
    recordOffline,
  } as unknown as jest.Mocked<CamerasService>;
  const writer = {
    writeAlert,
  } as unknown as jest.Mocked<AlertWriterService>;
  return {
    service: new EventAlarmService(recorder, cameras, writer),
    recorder,
    cameras,
    writer,
    recordOffline,
    writeAlert,
  };
}

describe('EventAlarmService', () => {
  it('dispatches valid events to AlertWriter with originEventId and shared dedup key', async () => {
    const { service, writeAlert } = setup();

    await service.record({
      cameraId: event.cameraId,
      type: event.type,
      detectedAt: event.detectedAt,
      confidence: event.confidence ?? undefined,
    });

    expect(writeAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        facilityId: event.facilityId,
        cameraId: event.cameraId,
        idempotencyKey: event.dedupKey,
        originEventId: event.id,
        type: event.type,
        probability: event.confidence,
        snapshotKey: event.snapshotKey,
      }),
    );
  });

  it('does not write or emit an alert for a validation-linked event', async () => {
    const validationEvent = {
      ...event,
      validationRunId: '0197f671-3a31-7a6c-a6e4-83ed412de80f',
    };
    const { service, writeAlert } = setup(validationEvent);

    await service.record({
      cameraId: 'camera-1',
      type: 'fall',
      detectedAt: new Date(),
    });

    expect(writeAlert).not.toHaveBeenCalled();
  });
  it('propagates Event.snapshotKey to the derived Alert', async () => {
    const eventWithSnapshot = { ...event, snapshotKey: 'events/event-1.jpg' };
    const { service, writeAlert } = setup(eventWithSnapshot);

    await service.record({
      cameraId: eventWithSnapshot.cameraId,
      type: eventWithSnapshot.type,
      detectedAt: eventWithSnapshot.detectedAt,
      confidence: eventWithSnapshot.confidence ?? undefined,
    });

    expect(writeAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotKey: 'events/event-1.jpg',
      }),
    );
  });

  it('routes detection-lost to camera offline without writing an alert', async () => {
    const detectionLost = { ...event, type: 'detection-lost' };
    const { service, recordOffline, writeAlert } = setup(detectionLost);

    await service.record({
      cameraId: detectionLost.cameraId,
      type: detectionLost.type,
      detectedAt: detectionLost.detectedAt,
      confidence: detectionLost.confidence ?? undefined,
    });

    expect(recordOffline).toHaveBeenCalledWith(
      detectionLost.facilityId,
      detectionLost.cameraId,
    );
    expect(writeAlert).not.toHaveBeenCalled();
  });
});
