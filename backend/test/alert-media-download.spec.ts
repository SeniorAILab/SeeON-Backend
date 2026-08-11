import request from 'supertest';
import type { Response } from 'supertest';
import { MediaDownloadAuditService } from '../src/media/media-download-audit.service';
import {
  MediaDownloadAuditConsistencyError,
  MediaDownloadAuditRepository,
} from '../src/media/media-download-audit.repository';
import { MediaDownloadProcessRepository } from '../src/media/media-download-process.repository';
import {
  type MediaDownloadInterval,
  MediaDownloadRuntime,
} from '../src/media/media-download-runtime';
import {
  type AlertMediaFixture,
  createAlertMediaFixture,
  mediaBytes,
  mediaEtag,
  mediaFixtureIds,
} from './helpers/alert-media-fixture';

const downloadPath = (alertId: string): string =>
  `/api/v1/alerts/${encodeURIComponent(alertId)}/media/download`;
const contentPath = (alertId: string): string =>
  `/api/v1/alerts/${encodeURIComponent(alertId)}/media/content`;

describe('audited alert media downloads (e2e)', () => {
  let fixture: AlertMediaFixture;

  beforeAll(async () => {
    fixture = await createAlertMediaFixture();
  });

  afterAll(async () => {
    await deleteDownloadRows();
    await fixture.close();
  });

  beforeEach(async () => {
    await deleteDownloadRows();
  });

  it('downloads full bytes as an attachment and completes one audit', async () => {
    const response = await request(fixture.app.getHttpServer())
      .get(downloadPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.adminCookie)
      .set('x-request-id', 'download-correlation')
      .expect(200);

    expect(responseBytes(response)).toEqual(mediaBytes);
    expect(response.headers).toMatchObject({
      'content-type': 'video/mp4',
      'content-disposition': 'attachment; filename="incident-clip.mp4"',
      'cache-control': 'private, no-store, no-transform',
      'accept-ranges': 'bytes',
      etag: mediaEtag,
    });
    const audits = [await waitForTerminalAudit()];
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      alertId: mediaFixtureIds.alertA,
      clipId: mediaFixtureIds.clipA,
      actorUserId: mediaFixtureIds.adminA,
      state: 'COMPLETED',
      requestId: 'download-correlation',
      httpStatus: 200,
      rangeStart: null,
      rangeEnd: null,
      bytesPlanned: BigInt(mediaBytes.length),
      bytesActual: BigInt(mediaBytes.length),
      outboxJob: { state: 'COMPLETED' },
    });
    expect(audits[0]?.completedAt).toBeInstanceOf(Date);
    expect(audits[0]?.abortedAt).toBeNull();
  });

  it('persists STARTED plus its pending recovery job atomically', async () => {
    const audits = fixture.app.get(MediaDownloadAuditService);
    const transfer = await audits.beginDownload({
      facilityId: mediaFixtureIds.facilityA,
      clipId: mediaFixtureIds.clipA,
      alertId: mediaFixtureIds.alertA,
      actorUserId: mediaFixtureIds.adminA,
      actorRole: 'ADMIN',
      requestId: 'direct-persistence-check',
      httpStatus: 200,
      rangeStart: null,
      rangeEnd: null,
      bytesPlanned: mediaBytes.length,
    });

    await transfer.complete(mediaBytes.length);
    await expectDownloadCount(1);
  });

  it('downloads a range with a distinct operation for repeated correlation ids', async () => {
    for (const range of ['bytes=2-5', 'bytes=6-9']) {
      await request(fixture.app.getHttpServer())
        .get(downloadPath(mediaFixtureIds.alertA))
        .set('cookie', fixture.adminCookie)
        .set('x-request-id', 'same-client-id')
        .set('range', range)
        .expect(206);
    }

    await waitForTerminalCount(2);

    const audits = await fixture.direct.mediaDownloadAudit.findMany({
      where: { facilityId: mediaFixtureIds.facilityA },
      orderBy: { rangeStart: 'asc' },
    });
    expect(audits).toHaveLength(2);
    expect(new Set(audits.map((audit) => audit.id)).size).toBe(2);
    expect(audits.map((audit) => audit.requestId)).toEqual([
      'same-client-id',
      'same-client-id',
    ]);
    expect(
      audits.map((audit) => [
        audit.httpStatus,
        audit.rangeStart,
        audit.rangeEnd,
      ]),
    ).toEqual([
      [206, 2n, 5n],
      [206, 6n, 9n],
    ]);
  });

  it.each([
    ['HEAD', 'head', undefined, 200],
    ['not modified', 'get', { 'if-none-match': mediaEtag }, 304],
    ['invalid range', 'get', { range: 'bytes=999-' }, 416],
  ])('does not audit %s', async (_name, method, headers, status) => {
    let call = request(fixture.app.getHttpServer())
      [method as 'get' | 'head'](downloadPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.adminCookie);
    if (headers !== undefined) call = call.set(headers);
    const response = await call.expect(status);

    expect(response.headers['cache-control']).toBe(
      'private, no-store, no-transform',
    );
    await expectDownloadCount(0);
  });

  it.each([
    ['anonymous', undefined, mediaFixtureIds.alertA, 401],
    ['staff', 'staff', mediaFixtureIds.alertA, 403],
    ['cross facility', 'admin', mediaFixtureIds.alertB, 404],
    ['pending', 'admin', mediaFixtureIds.pendingAlertA, 409],
    ['expired', 'admin', mediaFixtureIds.dueAlertA, 404],
  ])(
    'denies or rejects %s without an audit',
    async (_name, identity, alertId, status) => {
      const call = request(fixture.app.getHttpServer()).get(
        downloadPath(alertId),
      );
      if (identity === 'staff') call.set('cookie', fixture.staffCookie);
      if (identity === 'admin') call.set('cookie', fixture.adminCookie);
      await call
        .expect(status)
        .expect((response) => expectNoMediaHeaders(response));
      await expectDownloadCount(0);
    },
  );

  it('requires a super-admin to select a facility before downloading', async () => {
    await request(fixture.app.getHttpServer())
      .get(downloadPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.superAdminCookie)
      .expect(403)
      .expect((response) => expectNoMediaHeaders(response));
    await expectDownloadCount(0);
  });

  it.each(['UNAVAILABLE', 'DELETED'] as const)(
    'does not audit a %s clip',
    async (status) => {
      await fixture.direct.mediaClip.update({
        where: { id: mediaFixtureIds.futureClipA },
        data:
          status === 'UNAVAILABLE'
            ? { status, reason: 'CAPTURE_FAILED' }
            : {
                status,
                reason: 'ADMIN_DELETED',
                deletedAt: new Date(),
                storageState: 'DELETED',
              },
      });

      await request(fixture.app.getHttpServer())
        .get(downloadPath(mediaFixtureIds.futureAlertA))
        .set('cookie', fixture.adminCookie)
        .expect(404)
        .expect((response) => expectNoMediaHeaders(response));
      await expectDownloadCount(0);

      await fixture.direct.mediaClip.update({
        where: { id: mediaFixtureIds.futureClipA },
        data: {
          status: 'READY',
          reason: null,
          deletedAt: null,
          storageState: 'READY',
        },
      });
    },
  );

  it('rejects a traversal storage key before creating an audit', async () => {
    const clip = await fixture.direct.mediaClip.findUniqueOrThrow({
      where: { id: mediaFixtureIds.clipA },
      select: { storageKey: true },
    });
    await fixture.direct.mediaClip.update({
      where: { id: mediaFixtureIds.clipA },
      data: { storageKey: '../outside.mp4' },
    });

    await request(fixture.app.getHttpServer())
      .get(downloadPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.adminCookie)
      .expect(404)
      .expect((response) => expectNoMediaHeaders(response));
    await expectDownloadCount(0);

    await fixture.direct.mediaClip.update({
      where: { id: mediaFixtureIds.clipA },
      data: { storageKey: clip.storageKey },
    });
  });

  it('leaves existing playback inline and outside the download audit lifecycle', async () => {
    const response = await request(fixture.app.getHttpServer())
      .get(contentPath(mediaFixtureIds.alertA))
      .set('cookie', fixture.adminCookie)
      .expect(200);

    expect(response.headers['content-disposition']).toBe('inline');
    expect(responseBytes(response)).toEqual(mediaBytes);
    await expectDownloadCount(0);
  });

  it('renews process and stream leases throughout a four-minute transfer', async () => {
    const clock = new FakeMediaDownloadRuntime(
      new Date('2026-08-10T00:00:00.000Z'),
    );
    const service = createAuditService(clock);
    await service.onModuleInit();
    const transfer = await beginTestTransfer(service, 'slow-stream');

    for (let elapsed = 0; elapsed < 240_000; elapsed += 30_000) {
      await clock.advance(30_000);
    }

    const audit = await fixture.direct.mediaDownloadAudit.findFirstOrThrow({
      where: { requestId: 'slow-stream' },
    });
    expect(audit).toMatchObject({ state: 'STARTED', leaseVersion: 9 });
    expect(audit.streamLeaseExpiresAt.getTime()).toBe(
      clock.now().getTime() + 120_000,
    );
    await transfer.complete(mediaBytes.length);
    await service.onModuleDestroy();
  });

  it('lets a stream renewal win against a stale sweeper lease version', async () => {
    const clock = new FakeMediaDownloadRuntime(
      new Date('2026-08-10T01:00:00.000Z'),
    );
    const audits = fixture.app.get(MediaDownloadAuditRepository);
    const processes = fixture.app.get(MediaDownloadProcessRepository);
    const service = createAuditService(clock);
    await service.onModuleInit();
    const transfer = await beginTestTransfer(service, 'renewal-race');
    const stale = await fixture.direct.mediaDownloadAudit.findFirstOrThrow({
      where: { requestId: 'renewal-race' },
    });

    await clock.advance(30_000);
    await processes.stopProcess(service.getProcessId(), clock.now());
    const recovered = await audits.recoverExpired({
      id: stale.id,
      facilityId: stale.facilityId,
      processId: stale.processId,
      leaseVersion: stale.leaseVersion,
      recoveryProcessId: service.getProcessId(),
      now: new Date(clock.now().getTime() + 300_000),
    });

    expect(recovered).toBe(false);
    await transfer.abort(0, 'TEST_CLEANUP');
    await service.onModuleDestroy();
  });

  it('recovers a killed process only after both leases expire', async () => {
    const startedAt = new Date('2026-08-10T02:00:00.000Z');
    const crashedClock = new FakeMediaDownloadRuntime(startedAt);
    const crashed = createAuditService(crashedClock);
    await crashed.onModuleInit();
    await beginTestTransfer(crashed, 'process-kill');
    crashedClock.cancelAll();
    const recoveryClock = new FakeMediaDownloadRuntime(
      new Date(startedAt.getTime() + 179_000),
    );
    const recovery = createAuditService(recoveryClock);
    await recovery.onModuleInit();

    await recovery.runMaintenance();
    await expectAuditState('process-kill', 'STARTED');
    await recoveryClock.advance(2_000);
    await recovery.runMaintenance();

    const recovered = await fixture.direct.mediaDownloadAudit.findFirstOrThrow({
      where: { requestId: 'process-kill' },
      include: { outboxJob: true },
    });
    expect(recovered).toMatchObject({
      state: 'ABORTED',
      abortReason: 'PROCESS_LEASE_EXPIRED',
      outboxJob: { state: 'COMPLETED', attemptCount: 1 },
    });
    await recovery.onModuleDestroy();
  });

  it('rolls back terminal state when outbox completion fails', async () => {
    const audits = fixture.app.get(MediaDownloadAuditService);
    const transfer = await beginTestTransfer(audits, 'terminal-rollback');
    const started = await fixture.direct.mediaDownloadAudit.findFirstOrThrow({
      where: { requestId: 'terminal-rollback' },
    });
    await fixture.direct.mediaDownloadOutboxJob.update({
      where: { auditId: started.id },
      data: { leaseVersion: 2 },
    });

    await expect(transfer.complete(mediaBytes.length)).rejects.toBeInstanceOf(
      MediaDownloadAuditConsistencyError,
    );
    const unchanged = await fixture.direct.mediaDownloadAudit.findUniqueOrThrow(
      {
        where: { id: started.id },
        include: { outboxJob: true },
      },
    );
    expect(unchanged).toMatchObject({
      state: 'STARTED',
      outboxJob: { state: 'PENDING' },
    });
  });

  it('settles concurrent finish and close signals exactly once', async () => {
    const transfer = await beginTestTransfer(
      fixture.app.get(MediaDownloadAuditService),
      'finish-close-race',
    );

    const [completed, aborted] = await Promise.all([
      transfer.complete(mediaBytes.length),
      transfer.abort(0, 'RESPONSE_CLOSED'),
    ]);

    expect(completed).toBe(true);
    expect(aborted).toBe(true);
    const audit = await fixture.direct.mediaDownloadAudit.findFirstOrThrow({
      where: { requestId: 'finish-close-race' },
    });
    expect(audit).toMatchObject({
      state: 'COMPLETED',
      bytesActual: BigInt(mediaBytes.length),
      abortedAt: null,
    });
  });

  async function expectDownloadCount(expected: number): Promise<void> {
    await expect(
      fixture.direct.mediaDownloadAudit.count({
        where: { facilityId: mediaFixtureIds.facilityA },
      }),
    ).resolves.toBe(expected);
  }

  async function expectAuditState(
    requestId: string,
    state: 'STARTED' | 'COMPLETED' | 'ABORTED',
  ): Promise<void> {
    await expect(
      fixture.direct.mediaDownloadAudit.findFirstOrThrow({
        where: { requestId },
        select: { state: true },
      }),
    ).resolves.toEqual({ state });
  }

  function beginTestTransfer(
    service: MediaDownloadAuditService,
    requestId: string,
  ) {
    return service.beginDownload({
      facilityId: mediaFixtureIds.facilityA,
      clipId: mediaFixtureIds.clipA,
      alertId: mediaFixtureIds.alertA,
      actorUserId: mediaFixtureIds.adminA,
      actorRole: 'ADMIN',
      requestId,
      httpStatus: 200,
      rangeStart: null,
      rangeEnd: null,
      bytesPlanned: mediaBytes.length,
    });
  }

  function createAuditService(clock: MediaDownloadRuntime) {
    return new MediaDownloadAuditService(
      fixture.app.get(MediaDownloadAuditRepository),
      fixture.app.get(MediaDownloadProcessRepository),
      clock,
    );
  }

  async function waitForTerminalAudit() {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const audit = await fixture.direct.mediaDownloadAudit.findFirst({
        where: { facilityId: mediaFixtureIds.facilityA },
        include: { outboxJob: true },
      });
      if (audit?.state === 'COMPLETED') return audit;
      if (Date.now() >= deadline) {
        throw new Error('Download audit did not complete');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function waitForTerminalCount(expected: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const terminal = await fixture.direct.mediaDownloadAudit.count({
        where: {
          facilityId: mediaFixtureIds.facilityA,
          state: { in: ['COMPLETED', 'ABORTED'] },
        },
      });
      if (terminal === expected) return;
      if (Date.now() >= deadline) {
        throw new Error('Download audits did not settle');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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

class FakeMediaDownloadRuntime extends MediaDownloadRuntime {
  private current: Date;
  private readonly callbacks = new Map<
    MediaDownloadInterval,
    () => Promise<void> | void
  >();

  constructor(now: Date) {
    super();
    this.current = now;
  }

  now(): Date {
    return new Date(this.current);
  }

  every(
    _milliseconds: number,
    callback: () => Promise<void> | void,
  ): MediaDownloadInterval {
    const interval = setInterval(() => undefined, 2_147_483_647);
    interval.unref();
    this.callbacks.set(interval, callback);
    return interval;
  }

  cancel(interval: MediaDownloadInterval): void {
    clearInterval(interval);
    this.callbacks.delete(interval);
  }

  cancelAll(): void {
    for (const interval of [...this.callbacks.keys()]) {
      this.cancel(interval);
    }
  }

  async advance(milliseconds: number): Promise<void> {
    this.current = new Date(this.current.getTime() + milliseconds);
    for (const callback of [...this.callbacks.values()]) {
      await callback();
    }
  }
}

function responseBytes(response: Response): Buffer {
  if (Buffer.isBuffer(response.body)) return response.body;
  if (typeof response.text === 'string') return Buffer.from(response.text);
  return Buffer.alloc(0);
}

function expectNoMediaHeaders(response: Response): void {
  expect(response.headers.etag).toBeUndefined();
  expect(response.headers['content-range']).toBeUndefined();
  expect(response.headers['accept-ranges']).toBeUndefined();
  expect(response.headers['content-disposition']).toBeUndefined();
  expect(response.headers['content-type']).not.toBe('video/mp4');
}
