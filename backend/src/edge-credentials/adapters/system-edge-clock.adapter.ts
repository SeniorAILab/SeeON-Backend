import { Injectable } from '@nestjs/common';
import type { EdgeClock } from '../edge-clock.js';

@Injectable()
export class SystemEdgeClock implements EdgeClock {
  now(): Date {
    return new Date();
  }
}
