import { Injectable } from '@nestjs/common';

export const EDGE_CLOCK = Symbol('EDGE_CLOCK');

export interface EdgeClock {
  now(): Date;
}

@Injectable()
export class SystemEdgeClock implements EdgeClock {
  now(): Date {
    return new Date();
  }
}
