import { Injectable } from '@nestjs/common';
import { AlertWriterService } from '../alerts/alert-writer.service.js';
import { AlertPolicyService } from '../alerts/services/alert-policy.service.js';
import type { AlertEventType } from '../alerts/dto/alert-events.dto.js';
import { CamerasService } from '../cameras/cameras.service.js';
import type { RecordEventInput, RecordedEventResult } from './event-recorder.service.js';
import { EventRecorderService } from './event-recorder.service.js';

export type RecordEventWithAlarmResult = RecordedEventResult;

@Injectable()
export class EventAlarmService {
  constructor(
    private readonly recorder: EventRecorderService,
    private readonly cameras: CamerasService,
    private readonly policy: AlertPolicyService,
    private readonly writer: AlertWriterService,
  ) {}

  async record(input: RecordEventInput): Promise<RecordEventWithAlarmResult> {
    const result = await this.recorder.record(input);
    const camera = await this.cameras.resolveForEventIngest(result.event.cameraId);

    if (camera.ingestMode !== 'EVENT_API') {
      return result;
    }

    const decision = this.policy.evaluateIngress(result.event.facilityId, {
      type: result.event.type as AlertEventType,
      source_id: result.event.cameraId,
      external_event_id: result.event.id,
      detected_at: result.event.detectedAt.toISOString(),
      confidence: result.event.confidence ?? undefined,
    });

    if (decision.kind === 'suppress') {
      return result;
    }

    await this.writer.writeAlert({
      facilityId: result.event.facilityId,
      residentId: null,
      cameraId: result.event.cameraId,
      spaceId: result.event.spaceId,
      type: result.event.type,
      probability: result.event.confidence ?? 0,
      snapshotKey: null,
      detectedAt: result.event.detectedAt,
      idempotencyKey: result.event.dedupKey,
      originEventId: result.event.id,
    });

    return result;
  }
}
