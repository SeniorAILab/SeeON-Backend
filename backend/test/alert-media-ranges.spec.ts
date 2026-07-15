import request from 'supertest';
import type { Response } from 'supertest';
import {
  type AlertMediaFixture,
  createAlertMediaFixture,
  mediaBytes,
  mediaEtag,
  mediaFixtureIds,
  mediaReadyAt,
} from './helpers/alert-media-fixture';

const contentPath = (alertId: string): string =>
  `/api/v1/alerts/${encodeURIComponent(alertId)}/media/content`;
const HUGE_RANGE_VALUE = '9'.repeat(200);

describe('alert media byte serving (e2e)', () => {
  let fixture: AlertMediaFixture;

  beforeAll(async () => {
    fixture = await createAlertMediaFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it('serves exact immutable bytes and mirrors headers on HEAD', async () => {
    const getResponse = await request(fixture.app.getHttpServer())
      .get(contentPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.adminCookie)
      .expect(200);
    const headResponse = await request(fixture.app.getHttpServer())
      .head(contentPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.adminCookie)
      .expect(200);

    expect(responseBytes(getResponse)).toEqual(mediaBytes);
    expect(responseBytes(headResponse)).toHaveLength(0);
    expectMediaHeaders(getResponse, mediaBytes.length);
    expectMediaHeaders(headResponse, mediaBytes.length);
    expect(headResponse.headers).toMatchObject(getResponse.headers);
  });

  it.each([
    ['bounded', 'bytes=2-5', 2, 5],
    ['open', 'bytes=5-', 5, mediaBytes.length - 1],
    ['suffix', 'bytes=-4', mediaBytes.length - 4, mediaBytes.length - 1],
  ])(
    'serves the %s single range with exact bytes',
    async (_name, range, start, end) => {
      const response = await request(fixture.app.getHttpServer())
        .get(contentPath(mediaFixtureIds.alertA))
        .set('cookie', fixture.adminCookie)
        .set('range', range)
        .expect(206);

      expect(responseBytes(response)).toEqual(
        mediaBytes.subarray(start, end + 1),
      );
      expectMediaHeaders(response, end - start + 1);
      expect(response.headers['content-range']).toBe(
        `bytes ${start}-${end}/${mediaBytes.length}`,
      );
    },
  );

  it.each([
    ['huge end', `bytes=0-${HUGE_RANGE_VALUE}`],
    ['huge suffix', `bytes=-${HUGE_RANGE_VALUE}`],
  ])('clamps a %s to the known resource size', async (_name, range) => {
    const response = await request(fixture.app.getHttpServer())
      .get(contentPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.adminCookie)
      .set('range', range)
      .expect(206);

    expect(responseBytes(response)).toEqual(mediaBytes);
    expectMediaHeaders(response, mediaBytes.length);
    expect(response.headers['content-range']).toBe(
      `bytes 0-${mediaBytes.length - 1}/${mediaBytes.length}`,
    );
  });

  it.each([
    'items=0-1',
    'bytes=',
    'bytes=abc',
    'bytes=0-1,3-4',
    'bytes=999-',
    `bytes=${HUGE_RANGE_VALUE}-`,
    'bytes=-0',
    'bytes=5-3',
  ])(
    'rejects malformed, multiple, or unsatisfiable range %s',
    async (range) => {
      const response = await request(fixture.app.getHttpServer())
        .get(contentPath(mediaFixtureIds.alertA))
        .set('cookie', fixture.adminCookie)
        .set('range', range)
        .expect(416);

      expect(responseBytes(response)).toHaveLength(0);
      expect(response.headers['content-range']).toBe(
        `bytes */${mediaBytes.length}`,
      );
      expect(response.headers['content-length']).toBe('0');
      expect(response.headers['cache-control']).toBe(
        'private, no-store, no-transform',
      );
    },
  );

  it.each([
    ['malformed', 'items=0-1', '"sha256-mismatch"'],
    ['multiple', 'bytes=0-1,3-4', `W/${mediaEtag}`],
  ])(
    'rejects strict %s Range syntax before applying If-Range fallback',
    async (_name, range, ifRange) => {
      const response = await request(fixture.app.getHttpServer())
        .get(contentPath(mediaFixtureIds.alertA))
        .set('cookie', fixture.adminCookie)
        .set('range', range)
        .set('if-range', ifRange)
        .expect(416);

      expect(responseBytes(response)).toHaveLength(0);
      expect(response.headers['content-range']).toBe(
        `bytes */${mediaBytes.length}`,
      );
      expect(response.headers['content-length']).toBe('0');
      expect(response.headers['cache-control']).toBe(
        'private, no-store, no-transform',
      );
    },
  );

  it.each([
    ['exact strong ETag', mediaEtag, 206],
    ['qualifying date', mediaReadyAt.toUTCString(), 206],
    ['mismatched ETag', '"sha256-mismatch"', 200],
    ['weak ETag', `W/${mediaEtag}`, 200],
    ['stale date', new Date(mediaReadyAt.getTime() - 1_000).toUTCString(), 200],
    ['ISO-8601 non-HTTP-date', '2027-01-01T00:00:00.000Z', 200],
    ['obsolete RFC 850 date', 'Thursday, 16-Jul-26 00:00:11 GMT', 200],
    ['obsolete asctime date', 'Thu Jul 16 00:00:11 2026', 200],
    ['invalid date', 'not-a-date', 200],
  ])('applies If-Range semantics for %s', async (_name, ifRange, status) => {
    const response = await request(fixture.app.getHttpServer())
      .get(contentPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.adminCookie)
      .set('range', 'bytes=0-3')
      .set('if-range', ifRange)
      .expect(status);

    const expected = status === 206 ? mediaBytes.subarray(0, 4) : mediaBytes;
    expect(responseBytes(response)).toEqual(expected);
  });

  it('authorizes every seek instead of reusing an earlier grant', async () => {
    await request(fixture.app.getHttpServer())
      .get(contentPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.adminCookie)
      .set('range', 'bytes=0-1')
      .expect(206);

    await request(fixture.app.getHttpServer())
      .get(contentPath(mediaFixtureIds.alertB))
      .set('cookie', fixture.adminCookie)
      .set('range', 'bytes=2-3')
      .expect(404)
      .expect((response) => expectNoMediaHeaders(response));
  });
});

function responseBytes(response: Response): Buffer {
  if (Buffer.isBuffer(response.body)) return response.body;
  if (typeof response.text === 'string') return Buffer.from(response.text);
  return Buffer.alloc(0);
}

function expectMediaHeaders(response: Response, contentLength: number): void {
  expect(response.headers).toMatchObject({
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store, no-transform',
    etag: mediaEtag,
    'last-modified': mediaReadyAt.toUTCString(),
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
    'content-length': String(contentLength),
  });
}

function expectNoMediaHeaders(response: Response): void {
  expect(response.headers.etag).toBeUndefined();
  expect(response.headers['content-range']).toBeUndefined();
  expect(response.headers['accept-ranges']).toBeUndefined();
  expect(response.headers['content-disposition']).toBeUndefined();
  expect(response.headers['content-type']).not.toBe('video/mp4');
}
