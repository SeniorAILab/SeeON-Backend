import { SystemEdgeClock } from './system-edge-clock.adapter.js';

describe('SystemEdgeClock', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reads the current time at each call rather than construction', () => {
    const clock = new SystemEdgeClock();
    const firstCallTime = new Date('2026-01-01T00:01:00.000Z');
    jest.setSystemTime(firstCallTime);

    expect(clock.now()).toEqual(firstCallTime);

    const secondCallTime = new Date('2026-01-01T00:02:00.000Z');
    jest.setSystemTime(secondCallTime);

    expect(clock.now()).toEqual(secondCallTime);
  });

  it('returns distinct Date objects even at the same time', () => {
    const clock = new SystemEdgeClock();

    const first = clock.now();
    const second = clock.now();

    expect(first).toBeInstanceOf(Date);
    expect(second).toBeInstanceOf(Date);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});
