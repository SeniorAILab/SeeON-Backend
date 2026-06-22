import { formatAlertEvent } from './sse.controller';

describe('formatAlertEvent', () => {
  it('serializes alertSeq as string with spaceId and room context', () => {
    const frame = formatAlertEvent({
      alertSeq: 42n,
      id: 'alert-1',
      facilityId: 'facility-1',
      residentId: 'resident-1',
      cameraId: 'camera-1',
      spaceId: 'space-1',
      room: 'Room 101',
      space: { name: 'Room 101' },
      type: 'fall',
      probability: 0.91,
      snapshotKey: null,
      detectedAt: new Date('2026-06-22T00:00:00Z'),
      status: 'NEW',
      resident: { name: '홍길동', room: 'legacy' },
    });

    const payload = JSON.parse(frame.split('data: ')[1]) as {
      alertSeq: string;
      spaceId: string;
      room: string;
      space: { name: string };
    };
    expect(payload.alertSeq).toBe('42');
    expect(payload.spaceId).toBe('space-1');
    expect(payload.room).toBe('Room 101');
    expect(payload.space).toEqual({ name: 'Room 101' });
  });
});
