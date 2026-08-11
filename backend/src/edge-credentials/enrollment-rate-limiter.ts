import { Inject, Injectable } from '@nestjs/common';
import { EDGE_CLOCK, type EdgeClock } from './edge-clock.js';

type Counter = { count: number; startedAt: number };

@Injectable()
export class EnrollmentRateLimiter {
  private readonly sources = new Map<string, Counter>();
  private readonly facilities = new Map<string, Counter>();

  constructor(@Inject(EDGE_CLOCK) private readonly clock: EdgeClock) {}

  consume(sourceIp: string, facilityCode: string): boolean {
    const now = this.clock.now().getTime();
    const sourceAllowed = consume(this.sources, sourceIp, now, 60_000, 5);
    const facilityAllowed = consume(
      this.facilities,
      facilityCode,
      now,
      3_600_000,
      20,
    );
    return sourceAllowed && facilityAllowed;
  }
}

function consume(
  counters: Map<string, Counter>,
  key: string,
  now: number,
  duration: number,
  limit: number,
): boolean {
  const counter = counters.get(key);
  if (counter === undefined || now - counter.startedAt >= duration) {
    counters.set(key, { count: 1, startedAt: now });
    return true;
  }
  counter.count += 1;
  return counter.count <= limit;
}
