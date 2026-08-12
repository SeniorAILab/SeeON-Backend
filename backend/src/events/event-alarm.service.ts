import { Injectable } from '@nestjs/common';
import { AlertWriterService } from '../alerts/alert-writer.service.js';
import { AlertEventTypes } from '../alerts/dto/alert-events.dto.js';
import { CamerasService } from '../cameras/cameras.service.js';
import type {
  RecordEventInput,
  RecordedEventResult,
} from './event-recorder.service.js';
import { EventRecorderService } from './event-recorder.service.js';
import { SYSTEM_TEST_MODE } from './system-test.constants.js';

export type RecordEventWithAlarmResult = RecordedEventResult;

@Injectable()
export class EventAlarmService {
  constructor(
    private readonly recorder: EventRecorderService,
    private readonly cameras: CamerasService,
    private readonly writer: AlertWriterService,
  ) {}

  async record(input: RecordEventInput): Promise<RecordEventWithAlarmResult> {
    const result = await this.recorder.record(input);

    if (
      result.event.validationRunId !== null &&
      result.event.type !== SYSTEM_TEST_MODE
    ) {
      return result;
    }

    if (result.event.type === AlertEventTypes.detectionLost) {
      await this.cameras.recordOffline(
        result.event.facilityId,
        result.event.cameraId as string,
      );
      return result;
    }

    await this.writer.writeAlert({
      facilityId: result.event.facilityId,
      cameraId: result.event.cameraId,
      spaceId: result.event.spaceId,
      type: result.event.type,
      probability:
        result.event.type === SYSTEM_TEST_MODE
          ? null
          : (result.event.confidence ?? 0),
      snapshotKey: result.event.snapshotKey,
      detectedAt: result.event.detectedAt,
      idempotencyKey: result.event.dedupKey,
      originEventId: result.event.id,
      ...(result.event.type === SYSTEM_TEST_MODE
        ? { testMode: SYSTEM_TEST_MODE }
        : {}),
    });

    return result;
  }
}
