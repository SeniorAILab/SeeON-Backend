import { AlertEventTypes } from '../dto/alert-events.dto.js';
import { AlertPolicyService } from './alert-policy.service.js';

const fallIngress = {
  type: AlertEventTypes.fall,
  source_id: 'cam-1',
  external_event_id: 'e-1',
  detected_at: '2026-06-16T00:00:00.000Z',
} as const;

describe('AlertPolicyService', () => {
  it('dispatches fall and bed-exit events unconditionally', () => {
    const service = new AlertPolicyService();

    expect(service.evaluateIngress('facility-a', fallIngress)).toEqual({
      kind: 'dispatch',
    });
    expect(
      service.evaluateIngress('facility-a', {
        ...fallIngress,
        type: AlertEventTypes.bedExit,
        external_event_id: 'e-2',
      }),
    ).toEqual({ kind: 'dispatch' });
  });

  it('dispatches a rapid same-camera burst of distinct events', () => {
    const service = new AlertPolicyService();

    const burst = Array.from({ length: 12 }, (_, index) =>
      service.evaluateIngress('facility-a', {
        ...fallIngress,
        external_event_id: `burst-${index}`,
      }),
    );

    expect(burst).toEqual(
      Array.from({ length: 12 }, () => ({ kind: 'dispatch' })),
    );
  });

  it('does not suppress below-threshold predictions', () => {
    const service = new AlertPolicyService();

    expect(
      service.evaluatePrediction('facility-a', {
        source_id: 'cam-1',
        external_event_id: 'prediction-1',
        detected_at: '2026-06-16T00:00:00.000Z',
        prediction: {
          is_fall: true,
          fall_probability: 0.1,
          operating_threshold: 0.9,
        },
      }),
    ).toEqual({ kind: 'dispatch' });
  });
});
