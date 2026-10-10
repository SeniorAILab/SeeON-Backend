import { SystemMediaDownloadRuntime } from './system-media-download-runtime.adapter.js';

describe('SystemMediaDownloadRuntime', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('reads the clock on each call and returns distinct Date objects', () => {
    const runtime = new SystemMediaDownloadRuntime();
    jest.setSystemTime(new Date('2026-07-06T00:00:00.000Z'));
    const first = runtime.now();
    const sameInstant = runtime.now();
    expect(sameInstant).not.toBe(first);
    expect(sameInstant.getTime()).toBe(first.getTime());
    jest.advanceTimersByTime(20);
    expect(runtime.now().getTime()).toBe(first.getTime() + 20);
  });

  it('returns the unreferenced interval and cancels that exact handle', () => {
    const runtime = new SystemMediaDownloadRuntime();
    const callback = jest.fn(() => Promise.resolve());
    const clear = jest.spyOn(global, 'clearInterval');
    const interval = runtime.every(125, callback);
    expect(interval.hasRef()).toBe(false);
    jest.advanceTimersByTime(124);
    expect(callback).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(125);
    expect(callback).toHaveBeenCalledTimes(2);
    runtime.cancel(interval);
    expect(clear).toHaveBeenCalledWith(interval);
    jest.advanceTimersByTime(250);
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
