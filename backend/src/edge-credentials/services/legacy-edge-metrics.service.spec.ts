import { LegacyEdgeMetricsService } from './legacy-edge-metrics.service.js';

describe('LegacyEdgeMetricsService', () => {
  it('increments routes independently and leaves unrelated routes untouched', () => {
    const metrics = new LegacyEdgeMetricsService();

    metrics.increment('edge.cameras');
    metrics.increment('events.create');
    metrics.increment('edge.cameras');

    expect(metrics.count('edge.cameras')).toBe(2);
    expect(metrics.count('events.create')).toBe(1);
    expect(metrics.count('events.heartbeat')).toBe(0);
  });

  it('keeps exact untrimmed and case-sensitive route keys', () => {
    const metrics = new LegacyEdgeMetricsService();

    metrics.increment('events.create');
    metrics.increment(' events.create ');
    metrics.increment(' events.create ');
    metrics.increment('EVENTS.CREATE');
    metrics.increment('');
    metrics.increment(' ');
    metrics.increment(' ');

    expect(metrics.count('events.create')).toBe(1);
    expect(metrics.count(' events.create ')).toBe(2);
    expect(metrics.count('EVENTS.CREATE')).toBe(1);
    expect(metrics.count('')).toBe(1);
    expect(metrics.count(' ')).toBe(2);
  });

  it('isolates counters between constructed instances', () => {
    const first = new LegacyEdgeMetricsService();
    const second = new LegacyEdgeMetricsService();

    first.increment('events.snapshot');
    first.increment('events.snapshot');
    second.increment('events.snapshot');
    second.increment('events.clips');

    expect(first.count('events.snapshot')).toBe(2);
    expect(second.count('events.snapshot')).toBe(1);
    expect(first.count('events.clips')).toBe(0);
    expect(second.count('events.clips')).toBe(1);
  });
});
