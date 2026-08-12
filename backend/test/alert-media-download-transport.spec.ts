import { request as httpRequest, Server } from 'node:http';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import request from 'supertest';
import {
  type AlertMediaFixture,
  createAlertMediaFixture,
  mediaBytes,
  mediaFixtureIds,
  mediaSha256,
} from './helpers/alert-media-fixture';

const DOWNLOAD_PATH = `/api/v1/alerts/${encodeURIComponent(mediaFixtureIds.alertA)}/media/download`;
const LARGE_CLIP_BYTES = Buffer.alloc(8 * 1024 * 1024, 0x61);

describe('alert media download response settlement (e2e)', () => {
  let fixture: AlertMediaFixture;
  let server: Server;

  beforeAll(async () => {
    fixture = await createAlertMediaFixture();
    await fixture.app.listen(0, '127.0.0.1');
    server = requireHttpServer(fixture.app.getHttpAdapter().getHttpServer());
  });

  afterAll(async () => {
    await deleteDownloadRows();
    await fixture.close();
  });

  beforeEach(async () => {
    await deleteDownloadRows();
  });

  it('keeps GET byte transport read-only when the response finishes and closes', async () => {
    const signals = observeNextResponse(server);
    await request(server)
      .get(DOWNLOAD_PATH)
      .set('cookie', fixture.adminCookie)
      .set('x-request-id', 'transport-finish-close')
      .expect(200);

    await Promise.all([signals.finish, signals.closed]);
    await expectDownloadCount(0);
  });

  it('keeps a disconnected GET byte transport read-only', async () => {
    const clipPath = path.join(
      fixture.rootDir,
      mediaFixtureIds.facilityA,
      mediaFixtureIds.clipA,
      `${mediaSha256}.mp4`,
    );
    await fs.writeFile(clipPath, LARGE_CLIP_BYTES);
    await fixture.direct.mediaClip.update({
      where: { id: mediaFixtureIds.clipA },
      data: { byteSize: BigInt(LARGE_CLIP_BYTES.length) },
    });

    const signals = observeNextResponse(server);
    try {
      await downloadAndDisconnect(server);
      await signals.closed;

      expect(signals.didFinish()).toBe(false);
      await expectDownloadCount(0);
    } finally {
      await fixture.direct.mediaClip.update({
        where: { id: mediaFixtureIds.clipA },
        data: { byteSize: BigInt(mediaBytes.length) },
      });
      await fs.writeFile(clipPath, mediaBytes);
    }
  });

  function observeNextResponse(server: Server): {
    readonly finish: Promise<void>;
    readonly closed: Promise<void>;
    didFinish(): boolean;
  } {
    const finished = deferred();
    const closed = deferred();
    let didFinish = false;
    server.once('request', (_request, response) => {
      response.once('finish', () => {
        didFinish = true;
        finished.resolve();
      });
      response.once('close', closed.resolve);
    });
    return {
      finish: finished.promise,
      closed: closed.promise,
      didFinish: () => didFinish,
    };
  }

  function downloadAndDisconnect(server: Server): Promise<number> {
    const address = listeningAddress(server);
    return new Promise((resolve, reject) => {
      let disconnected = false;
      const client = httpRequest({
        hostname: address.address,
        port: address.port,
        path: DOWNLOAD_PATH,
        headers: {
          cookie: fixture.adminCookie,
          'x-request-id': 'transport-disconnect',
        },
      });
      client.once('response', (response) => {
        response.once('data', (chunk: Buffer) => {
          disconnected = true;
          response.destroy();
          resolve(chunk.length);
        });
      });
      client.once('error', (error) => {
        if (!disconnected) reject(error);
      });
      client.end();
    });
  }

  async function expectDownloadCount(expected: number): Promise<void> {
    await expect(
      fixture.direct.mediaDownloadAudit.count({
        where: { facilityId: mediaFixtureIds.facilityA },
      }),
    ).resolves.toBe(expected);
  }

  async function deleteDownloadRows(): Promise<void> {
    const facilityIds = [mediaFixtureIds.facilityA, mediaFixtureIds.facilityB];
    await fixture.direct.mediaDownloadOutboxJob.deleteMany({
      where: { facilityId: { in: facilityIds } },
    });
    await fixture.direct.mediaDownloadAudit.deleteMany({
      where: { facilityId: { in: facilityIds } },
    });
  }
});

function listeningAddress(server: Server): AddressInfo {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the Nest test server to listen on TCP');
  }
  return address;
}

function requireHttpServer(value: unknown): Server {
  if (!isHttpServer(value)) {
    throw new Error('Expected the Nest test app to expose an HTTP server');
  }
  return value;
}

function isHttpServer(value: unknown): value is Server {
  return value instanceof Server;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error('Expected a synchronous promise resolver');
  }
  const resolve = resolvePromise;
  return { promise, resolve: () => resolve() };
}
