import { EnrollmentRateLimiterService } from './enrollment-rate-limiter.service.js';

describe('EnrollmentRateLimiterService', () => {
  function fixture() {
    let now = 0;
    const limiter = new EnrollmentRateLimiterService({
      now: () => new Date(now),
    });
    return {
      limiter,
      setTime: (value: number) => {
        now = value;
      },
    };
  }

  it('allows five attempts per source across independent facilities', () => {
    const { limiter } = fixture();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.consume('source-a', `facility-${attempt}`)).toBe(true);
    }
    expect(limiter.consume('source-a', 'facility-next')).toBe(false);
    expect(limiter.consume('source-b', 'facility-next')).toBe(true);
  });

  it('allows twenty attempts per facility across independent sources', () => {
    const { limiter } = fixture();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(limiter.consume(`source-${attempt}`, 'facility-a')).toBe(true);
    }
    expect(limiter.consume('source-next', 'facility-a')).toBe(false);
    expect(limiter.consume('source-next', 'facility-b')).toBe(true);
  });

  it('resets the source window exactly at sixty seconds', () => {
    const { limiter, setTime } = fixture();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.consume('source-a', 'facility-a')).toBe(true);
    }
    setTime(59_999);
    expect(limiter.consume('source-a', 'facility-a')).toBe(false);
    setTime(60_000);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.consume('source-a', 'facility-a')).toBe(true);
    }
    expect(limiter.consume('source-a', 'facility-a')).toBe(false);
  });

  it('resets the facility window exactly at one hour', () => {
    const { limiter, setTime } = fixture();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(limiter.consume(`source-${attempt}`, 'facility-a')).toBe(true);
    }
    setTime(3_599_999);
    expect(limiter.consume('boundary-source', 'facility-a')).toBe(false);
    setTime(3_600_000);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(limiter.consume(`reset-source-${attempt}`, 'facility-a')).toBe(
        true,
      );
    }
    expect(limiter.consume('overflow-source', 'facility-a')).toBe(false);
  });

  it('consumes the facility budget even when the source already denies', () => {
    const { limiter } = fixture();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(limiter.consume('source-a', 'facility-a')).toBe(attempt < 5);
    }
    expect(limiter.consume('fresh-source', 'facility-a')).toBe(false);
  });

  it('consumes the source budget even when the facility already denies', () => {
    const { limiter } = fixture();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(limiter.consume(`source-${attempt}`, 'facility-a')).toBe(true);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.consume('blocked-source', 'facility-a')).toBe(false);
    }
    expect(limiter.consume('blocked-source', 'fresh-facility')).toBe(false);
  });
});
