import type { ConfigService } from '@nestjs/config';

import { AlertEventTypes } from '../dto/alert-events.dto.js';
import {
  AlertPolicyClock,
  AlertPolicyService,
} from './alert-policy.service.js';

class FakeClock extends AlertPolicyClock {
  constructor(private value = 0) {
    super();
  }
  set(ms: number): void {
    this.value = ms;
  }
  nowMs(): number {
    return this.value;
  }
}

function config(values: Record<string, string | number>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const fallIngress = {
  type: AlertEventTypes.fall,
  source_id: 'cam-1',
  external_event_id: 'e-1',
  detected_at: '2026-06-16T00:00:00.000Z',
} as const;

describe('AlertPolicyService', () => {
  it('dispatches the first event under the hourly cap', () => {
    const service = new AlertPolicyService(config({}), new FakeClock(0));
    expect(service.evaluateIngress(fallIngress)).toEqual({ kind: 'dispatch' });
  });

  it('suppresses a repeat within the cooldown window', () => {
    const clock = new FakeClock(0);
    const service = new AlertPolicyService(
      config({ ALERT_COOLDOWN_SEC: 60 }),
      clock,
    );
    expect(service.evaluateIngress(fallIngress).kind).toBe('dispatch');
    clock.set(30_000);
    expect(service.evaluateIngress(fallIngress)).toEqual({
      kind: 'suppress',
      suppressed_reason: 'cooldown',
    });
  });

  it('suppresses once the rolling hourly cap is reached', () => {
    const clock = new FakeClock(0);
    const service = new AlertPolicyService(
      config({ ALERT_HOURLY_CAP: 1, ALERT_COOLDOWN_SEC: 0 }),
      clock,
    );
    expect(service.evaluateIngress(fallIngress).kind).toBe('dispatch');
    clock.set(1_000);
    expect(service.evaluateIngress(fallIngress)).toEqual({
      kind: 'suppress',
      suppressed_reason: 'hourly_cap',
    });
  });
});
