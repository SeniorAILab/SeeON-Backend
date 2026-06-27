import { EventAlarmService } from './event-alarm.service.js';
import type { EventRecorderService, RecordedEventResult } from './event-recorder.service.js';
import type { AlertPolicyService } from '../alerts/services/alert-policy.service.js';
import type { AlertWriterService } from '../alerts/alert-writer.service.js';

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

function setup(overrides: { decision?: { kind: 'dispatch' } | { kind: 'suppress'; suppressed_reason: 'cooldown' } } = {}) {
  const recorder = {
    record: jest.fn().mockResolvedValue({ event, duplicate: false } satisfies RecordedEventResult),
  } as unknown as jest.Mocked<EventRecorderService>;
  const policy = {
    evaluateIngress: jest.fn().mockReturnValue(overrides.decision ?? { kind: 'dispatch' }),
  } as unknown as jest.Mocked<AlertPolicyService>;
  const writer = {
    writeAlert: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<AlertWriterService>;
  return { service: new EventAlarmService(recorder, policy, writer), recorder, policy, writer };
}

describe('EventAlarmService', () => {
  it('leaves SUPPRESS as Event-only and does not emit through AlertWriter', async () => {
    const { service, writer } = setup({ decision: { kind: 'suppress', suppressed_reason: 'cooldown' } });
    await service.record({ cameraId: event.cameraId, type: event.type, detectedAt: event.detectedAt, confidence: event.confidence });
    expect(writer.writeAlert).not.toHaveBeenCalled();
  });

  it('dispatches valid events to AlertWriter with originEventId and shared dedup key', async () => {
    const { service, policy, writer } = setup();
    await service.record({ cameraId: event.cameraId, type: event.type, detectedAt: event.detectedAt, confidence: event.confidence });
    expect(policy.evaluateIngress).toHaveBeenCalledWith(event.facilityId, expect.objectContaining({ source_id: event.cameraId }));
    expect(writer.writeAlert).toHaveBeenCalledWith(expect.objectContaining({
      facilityId: event.facilityId,
      cameraId: event.cameraId,
      idempotencyKey: event.dedupKey,
      originEventId: event.id,
    }));
  });
});
