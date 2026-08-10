import request from 'supertest';
import {
  EDGE_LEGACY_TOKEN,
  type EdgeLegacyFixture,
} from './edge-legacy-fixture.js';

export function mapLegacyCamera(fixture: EdgeLegacyFixture, spaceId: string) {
  return request(fixture.app.getHttpServer())
    .put('/api/v1/edge/cameras')
    .set('x-edge-relay-token', EDGE_LEGACY_TOKEN)
    .set('x-facility-id', fixture.second.facilityId)
    .send({
      edge_camera_ref: 'legacy-camera-b',
      label: 'Legacy Camera B',
      spaceId,
    });
}

export function postLegacyEvent(
  fixture: EdgeLegacyFixture,
  input: {
    readonly cameraId: string;
    readonly edgeEventId: string;
    readonly ignoredFacilityId?: string;
  },
) {
  const requestBuilder = request(fixture.app.getHttpServer())
    .post('/api/v1/events')
    .set('Authorization', `Bearer ${EDGE_LEGACY_TOKEN}`)
    .send({
      camera_id: input.cameraId,
      edge_event_id: input.edgeEventId,
      type: 'fall',
      detected_at: '2026-08-10T00:00:00.000Z',
      confidence: 0.91,
    });
  return input.ignoredFacilityId === undefined
    ? requestBuilder
    : requestBuilder.set('x-facility-id', input.ignoredFacilityId);
}

export function reportLegacyUnavailable(
  fixture: EdgeLegacyFixture,
  clipId: string,
  eventRef: string,
) {
  return request(fixture.app.getHttpServer())
    .put(`/api/v1/events/clips/${clipId}/state`)
    .set('Authorization', `Bearer ${EDGE_LEGACY_TOKEN}`)
    .send({
      camera_id: fixture.first.cameraId,
      event_refs: [eventRef],
      state_version: 1,
      reason: 'CAPTURE_FAILED',
    });
}
