import { AlertEventTypes } from '../src/alerts/alert-event.types';

describe('AlertEventType host contract', () => {
  it('keeps the accepted remote event types explicit', () => {
    expect(Object.values(AlertEventTypes)).toEqual([
      'detection-lost',
      'bed-exit',
      'fall',
    ]);
  });
});
