export const EDGE_CLOCK = Symbol('EDGE_CLOCK');

export interface EdgeClock {
  now(): Date;
}
