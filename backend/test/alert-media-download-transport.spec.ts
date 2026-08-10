import { request as httpRequest, Server } from 'node:http';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import type { Prisma } from '@prisma/client';
import request from 'supertest';
import { MediaDownloadAuditService } from '../src/media/media-download-audit.service';
import {
  type AlertMediaFixture,
  createAlertMediaFixture,
  mediaBytes,
  mediaFixtureIds,
  mediaSha256,
} from './helpers/alert-media-fixture';

const DOWNLOAD_PATH = `/api/v1/alerts/${encodeURIComponent(mediaFixtureIds.alertA)}/media/download`;
const LARGE_CLIP_BYTES = Buffer.alloc(8 * 1024 * 1024, 0x61);
type DownloadAudit = Prisma.MediaDownloadAuditGetPayload<{
  include: { outboxJob: true };
}>;

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

  it('keeps a completed audit when the real response emits finish then close', async () => {
    const signals = observeNextResponse(server);
    const settlement = observeNextSettlement();
    try {
      await request(server)
        .get(DOWNLOAD_PATH)
        .set('cookie', fixture.adminCookie)
        .set('x-request-id', 'transport-finish-close')
        .expect(200);

      await Promise.all([signals.finish, signals.closed, settlement.observed]);

      expect(await expectAudit('transport-finish-close')).toMatchObject({
        state: 'COMPLETED',
        bytesActual: BigInt(mediaBytes.length),
        abortedAt: null,
        abortReason: null,
        outboxJob: { state: 'COMPLETED' },
      });
    } finally {
      settlement.restore();
    }
  });

  it('keeps a disconnected response aborted after later pipeline settlement', async () => {
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
    const settlement = observeNextSettlement();
    try {
      const receivedBytes = await downloadAndDisconnect(server);
      await Promise.all([signals.closed, settlement.observed]);

      expect(signals.didFinish()).toBe(false);
      const audit = await expectAudit('transport-disconnect');
      expect(audit).toMatchObject({
        state: 'ABORTED',
        completedAt: null,
        abortReason: 'RESPONSE_CLOSED',
        outboxJob: { state: 'COMPLETED' },
      });
      expect(audit.abortedAt).toBeInstanceOf(Date);
      expect(audit.bytesActual).toBeGreaterThan(0n);
      expect(audit.bytesActual).toBeGreaterThanOrEqual(BigInt(receivedBytes));
      await expect(
        fixture.direct.mediaDownloadAudit.count({
          where: { requestId: 'transport-disconnect' },
        }),
      ).resolves.toBe(1);
    } finally {
      settlement.restore();
      await fixture.direct.mediaClip.update({
        where: { id: mediaFixtureIds.clipA },
        data: { byteSize: BigInt(mediaBytes.length) },
      });
      await fs.writeFile(clipPath, mediaBytes);
    }
  });

  function observeNextSettlement(): {
    readonly observed: Promise<void>;
    restore(): void;
  } {
    const audits = fixture.app.get(MediaDownloadAuditService);
    const original = audits.observeSettlement.bind(audits);
    const observed = deferred();
    const observer = jest
      .spyOn(audits, 'observeSettlement')
      .mockImplementation(async (settlement) => {
        await original(settlement);
        observed.resolve();
      });
    return {
      observed: observed.promise,
      restore: () => observer.mockRestore(),
    };
  }

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

  async function expectAudit(requestId: string): Promise<DownloadAudit> {
    return fixture.direct.mediaDownloadAudit.findFirstOrThrow({
      where: { requestId },
      include: { outboxJob: true },
    });
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
