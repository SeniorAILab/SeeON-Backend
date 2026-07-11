import { AlertEventTypes } from '../src/alerts/dto/alert-events.dto';

describe('AlertEventType host contract', () => {
  it('keeps the accepted remote event types explicit', () => {
    expect(Object.values(AlertEventTypes)).toEqual([
      'detection-lost',
      'bed-exit',
      'fall',
    ]);
  });
});
