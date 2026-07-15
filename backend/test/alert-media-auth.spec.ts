import request from 'supertest';
import type { Response } from 'supertest';
import { AlertMediaService } from '../src/media/alert-media.service';
import {
  type AlertMediaFixture,
  createAlertMediaFixture,
  mediaBytes,
  mediaFixtureIds,
} from './helpers/alert-media-fixture';

const metadataPath = (alertId: string): string =>
  `/api/v1/alerts/${encodeURIComponent(alertId)}/media`;
const accessPath = (alertId: string): string =>
  `/api/v1/alerts/${encodeURIComponent(alertId)}/media/access`;
const contentPath = (alertId: string): string =>
  `/api/v1/alerts/${encodeURIComponent(alertId)}/media/content`;

describe('alert media authorization and metadata (e2e)', () => {
  let fixture: AlertMediaFixture;

  beforeAll(async () => {
    fixture = await createAlertMediaFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it('returns typed READY metadata keyed only by alert id', async () => {
    const response = await request(fixture.app.getHttpServer())
      .get(metadataPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.adminCookie)
      .expect(200);

    expect(response.body).toEqual({
      status: 'READY',
      alertId: mediaFixtureIds.alertA,
      clip: {
        contentType: 'video/mp4',
        detectedAt: '2026-07-15T23:59:55.000Z',
        clipStartAt: '2026-07-15T23:59:50.000Z',
        clipEndAt: '2026-07-16T00:00:10.000Z',
        durationSeconds: 20,
      },
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(mediaFixtureIds.clipA);
    expect(serialized).not.toContain('storageKey');
    expect(serialized).not.toContain('externalClipId');
    expect(serialized).not.toContain('edge_url');
    expect(response.headers['cache-control']).toBe(
      'private, no-store, no-transform',
    );
  });

  it('returns typed PENDING metadata before a clip binding exists', async () => {
    await request(fixture.app.getHttpServer())
      .get(metadataPath(mediaFixtureIds.pendingAlertA))
      .set('cookie', fixture.adminCookie)
      .expect(200)
      .expect({
        status: 'PENDING',
        alertId: mediaFixtureIds.pendingAlertA,
        retryAfterSeconds: null,
      });
  });

  it('records only an allowed explicit interaction action', async () => {
    const interactionId = 'interaction-t15-play-started';
    const accessResponse = await request(fixture.app.getHttpServer())
      .post(accessPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.adminCookie)
      .send({ action: 'PLAY_STARTED', interactionId })
      .expect(201)
      .expect({ accepted: true });
    expect(accessResponse.headers['cache-control']).toBe(
      'private, no-store, no-transform',
    );

    const stored = await fixture.direct.mediaAccessLog.findFirstOrThrow({
      where: { actorUserId: mediaFixtureIds.adminA, interactionId },
      select: { action: true, outcome: true, alertId: true, clipId: true },
    });
    expect(stored).toEqual({
      action: 'PLAY_STARTED',
      outcome: 'ALLOWED',
      alertId: mediaFixtureIds.alertA,
      clipId: mediaFixtureIds.clipA,
    });

    await request(fixture.app.getHttpServer())
      .post(accessPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.adminCookie)
      .send({ action: 'SEEKED', interactionId: 'interaction-t15-invalid' })
      .expect(400);
  });

  it('atomically expires due READY media on request while preserving bytes and a future clip', async () => {
    await fixture.direct.mediaRetentionHold.create({
      data: {
        facilityId: mediaFixtureIds.facilityA,
        clipId: mediaFixtureIds.dueClipA,
        kind: 'LEGAL',
        reason: 'request-path expiry must preserve held bytes',
      },
    });

    const [first, second] = await Promise.all([
      request(fixture.app.getHttpServer())
        .get(metadataPath(mediaFixtureIds.dueAlertA))
        .set('cookie', fixture.adminCookie)
        .expect(200),
      request(fixture.app.getHttpServer())
        .get(metadataPath(mediaFixtureIds.dueAlertA))
        .set('cookie', fixture.adminCookie)
        .expect(200),
    ]);
    expect(first.body).toMatchObject({
      status: 'EXPIRED',
      alertId: mediaFixtureIds.dueAlertA,
    });
    expect(second.body).toMatchObject({
      status: 'EXPIRED',
      alertId: mediaFixtureIds.dueAlertA,
    });

    const expired = await fixture.direct.mediaClip.findUniqueOrThrow({
      where: { id: mediaFixtureIds.dueClipA },
      select: {
        status: true,
        reason: true,
        stateVersion: true,
        expiredAt: true,
        storageState: true,
        storageKey: true,
      },
    });
    expect(expired).toMatchObject({
      status: 'EXPIRED',
      reason: 'RETENTION_EXPIRED',
      stateVersion: 2,
      storageState: 'READY',
    });
    expect(expired.expiredAt).toBeInstanceOf(Date);
    expect(expired.storageKey).not.toBeNull();

    await request(fixture.app.getHttpServer())
      .get(contentPath(mediaFixtureIds.dueAlertA))
      .set('cookie', fixture.adminCookie)
      .expect(404)
      .expect((response) => expectNoMediaHeaders(response));

    const futureMetadata = await request(fixture.app.getHttpServer())
      .get(metadataPath(mediaFixtureIds.futureAlertA))
      .set('cookie', fixture.adminCookie)
      .expect(200);
    expect(futureMetadata.body).toMatchObject({ status: 'READY' });
    await request(fixture.app.getHttpServer())
      .get(contentPath(mediaFixtureIds.futureAlertA))
      .set('cookie', fixture.adminCookie)
      .expect(200);
    const future = await fixture.direct.mediaClip.findUniqueOrThrow({
      where: { id: mediaFixtureIds.futureClipA },
      select: { status: true, stateVersion: true },
    });
    expect(future).toEqual({ status: 'READY', stateVersion: 1 });
  });

  it('returns a private generic 500 when the content route fails unexpectedly', async () => {
    const sensitiveDetail = 'unexpected-media-storage-secret';
    const media = fixture.app.get(AlertMediaService);
    jest
      .spyOn(media, 'openContent')
      .mockRejectedValueOnce(new Error(sensitiveDetail));

    const response = await request(fixture.app.getHttpServer())
      .get(contentPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.adminCookie)
      .expect(500);

    expect(response.headers['cache-control']).toBe(
      'private, no-store, no-transform',
    );
    expect(response.body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
    });
    expect(JSON.stringify(response.body)).not.toContain(sensitiveDetail);
    expectNoMediaHeaders(response);
  });

  it.each([
    ['anonymous', undefined, 401],
    ['staff', 'staff', 403],
    ['revoked', 'revoked', 401],
  ])(
    'denies %s without emitting media headers',
    async (_name, identity, status) => {
      const call = request(fixture.app.getHttpServer()).get(
        contentPath(mediaFixtureIds.alertA),
      );
      if (identity === 'staff') call.set('cookie', fixture.staffCookie);
      if (identity === 'revoked') call.set('cookie', fixture.revokedCookie);
      await call
        .expect(status)
        .expect((response) => expectNoMediaHeaders(response));
    },
  );

  it('returns a non-enumerating 404 for a cross-facility alert', async () => {
    await request(fixture.app.getHttpServer())
      .get(contentPath(mediaFixtureIds.alertB))
      .set('cookie', fixture.adminCookie)
      .expect(404)
      .expect((response) => {
        expect(response.body).toEqual({
          error: 'NOT_FOUND',
          resource: 'media',
        });
        expectNoMediaHeaders(response);
      });
  });

  it('pins a super-admin selected facility into an HttpOnly scope cookie for native video', async () => {
    const metadata = await request(fixture.app.getHttpServer())
      .get(metadataPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.superAdminCookie)
      .set('x-facility-id', mediaFixtureIds.facilityA)
      .expect(200);
    const scopeCookie = readCookie(metadata, 'app_media_facility');
    expect(scopeCookie).toContain('HttpOnly');
    expect(scopeCookie).toContain('SameSite=Strict');

    const content = await request(fixture.app.getHttpServer())
      .get(contentPath(mediaFixtureIds.alertA))
      .set('Cookie', [fixture.superAdminCookie, scopeCookie.split(';')[0]])
      .set('range', 'bytes=0-1')
      .expect(206);
    expect(Buffer.from(content.body)).toEqual(mediaBytes.subarray(0, 2));
  });

  it('does not accept a stale selected-facility cookie for another alert', async () => {
    const metadata = await request(fixture.app.getHttpServer())
      .get(metadataPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.superAdminCookie)
      .set('x-facility-id', mediaFixtureIds.facilityA)
      .expect(200);
    const scopeCookie = readCookie(metadata, 'app_media_facility');

    await request(fixture.app.getHttpServer())
      .get(contentPath(mediaFixtureIds.alertB))
      .set('Cookie', [fixture.superAdminCookie, scopeCookie.split(';')[0]])
      .expect(404)
      .expect((response) => expectNoMediaHeaders(response));
  });
});

function readCookie(response: Response, name: string): string {
  const header: unknown = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : [header];
  const cookie = values
    .filter((value): value is string => typeof value === 'string')
    .find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Missing ${name} cookie`);
  return cookie;
}

function expectNoMediaHeaders(response: Response): void {
  expect(response.headers.etag).toBeUndefined();
  expect(response.headers['content-range']).toBeUndefined();
  expect(response.headers['accept-ranges']).toBeUndefined();
  expect(response.headers['content-disposition']).toBeUndefined();
  expect(response.headers['content-type']).not.toBe('video/mp4');
}
