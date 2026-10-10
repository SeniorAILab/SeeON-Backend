import type { MediaDownloadAuditRepository } from '../repositories/media-download-audit.repository.js';
import type {
  DownloadAuditLease,
  RenewDownloadAudit,
  CompleteDownloadAudit,
  AbortDownloadAudit,
} from '../media-download-audit.types.js';
import type { MediaDownloadInterval } from '../ports/media-download-runtime.port.js';
import { MediaDownloadTransferService } from './media-download-transfer.service.js';

const LEASE: DownloadAuditLease = {
  id: 'download-1',
  facilityId: 'facility-1',
  processId: 'process-1',
  leaseVersion: 1,
};
const NOW = new Date('2026-07-06T00:00:00.000Z');

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Uninitialized resolve');
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error('Uninitialized reject');
  };
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup() {
  const repository = {
    renewDownload: jest
      .fn<Promise<number | null>, [RenewDownloadAudit]>()
      .mockResolvedValue(2),
    completeDownload: jest
      .fn<Promise<boolean>, [CompleteDownloadAudit]>()
      .mockResolvedValue(true),
    abortDownload: jest
      .fn<Promise<boolean>, [AbortDownloadAudit]>()
      .mockResolvedValue(true),
  };
  const runtime = {
    now: jest.fn(() => NOW),
    every: jest.fn(
      (milliseconds: number, callback: () => Promise<void> | void) =>
        setInterval(() => {
          void callback();
        }, milliseconds),
    ),
    cancel: jest.fn((interval: MediaDownloadInterval) =>
      clearInterval(interval),
    ),
  };
  const backgroundError = jest.fn<void, [unknown]>();
  // The transfer only calls these three delegate methods; no Prisma instance exists.
  const transfer = new MediaDownloadTransferService(
    LEASE,
    repository as unknown as MediaDownloadAuditRepository,
    runtime,
    backgroundError,
  );
  function tick() {
    const call = runtime.every.mock.calls.at(0);
    if (call === undefined) throw new Error('Renewal was not scheduled');
    return call[1]();
  }
  return { transfer, repository, runtime, backgroundError, tick };
}

describe('MediaDownloadTransferService lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('allocates a fresh 30-second interval per instance and renews with a 120-second expiry', async () => {
    const first = setup();
    const second = setup();
    expect(first.runtime.every).toHaveBeenCalledWith(
      30_000,
      expect.any(Function),
    );
    expect(first.runtime.every.mock.results.at(0)?.value).not.toBe(
      second.runtime.every.mock.results.at(0)?.value,
    );
    expect(first.runtime.now).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(29_999);
    expect(first.repository.renewDownload).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(first.repository.renewDownload).toHaveBeenCalledWith({
      ...LEASE,
      now: NOW,
      streamLeaseExpiresAt: new Date(NOW.getTime() + 120_000),
    });
    expect(second.repository.renewDownload).toHaveBeenCalledTimes(1);
    await first.transfer.complete(4);
    await second.transfer.abort(2, 'disconnect');
  });

  it('keeps renewal single-flight and uses its updated lease version on the next renewal', async () => {
    const f = setup();
    const pending = deferred<number | null>();
    f.repository.renewDownload.mockReturnValueOnce(pending.promise);
    const firstTick = f.tick();
    const secondTick = f.tick();
    expect(f.repository.renewDownload).toHaveBeenCalledTimes(1);
    expect(f.runtime.now).toHaveBeenCalledTimes(1);
    pending.resolve(7);
    await Promise.all([firstTick, secondTick]);
    await f.tick();
    expect(f.repository.renewDownload).toHaveBeenNthCalledWith(2, {
      ...LEASE,
      leaseVersion: 7,
      now: NOW,
      streamLeaseExpiresAt: new Date(NOW.getTime() + 120_000),
    });
    await f.transfer.complete(4);
  });

  it('keeps the current lease version when renewal returns null', async () => {
    const f = setup();
    f.repository.renewDownload
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(null);
    await f.tick();
    await f.tick();
    await f.transfer.complete(13);
    expect(f.repository.completeDownload).toHaveBeenCalledWith({
      ...LEASE,
      leaseVersion: 8,
      now: NOW,
      bytesActual: 13,
    });
  });

  it.each(['complete', 'abort'])(
    'cancels synchronously, awaits renewal and lets first %s settlement win',
    async (kind) => {
      const f = setup();
      const renewal = deferred<number | null>();
      f.repository.renewDownload.mockReturnValue(renewal.promise);
      const tick = f.tick();
      const settlement =
        kind === 'complete'
          ? f.transfer.complete(17)
          : f.transfer.abort(9, 'client gone');
      expect(f.runtime.cancel).toHaveBeenCalledTimes(1);
      expect(f.runtime.cancel.mock.calls.at(0)?.at(0)).toBe(
        f.runtime.every.mock.results.at(0)?.value,
      );
      expect(f.repository.completeDownload).not.toHaveBeenCalled();
      expect(f.repository.abortDownload).not.toHaveBeenCalled();
      expect(f.transfer.complete(999)).toBe(settlement);
      expect(f.transfer.abort(999, 'later')).toBe(settlement);
      await f.tick();
      expect(f.repository.renewDownload).toHaveBeenCalledTimes(1);
      expect(f.runtime.now).toHaveBeenCalledTimes(1);
      const settledAt = new Date(NOW.getTime() + 3_000);
      f.runtime.now.mockReturnValue(settledAt);
      renewal.resolve(6);
      await tick;
      await expect(settlement).resolves.toBe(true);
      if (kind === 'complete') {
        expect(f.repository.completeDownload).toHaveBeenCalledWith({
          ...LEASE,
          leaseVersion: 6,
          now: settledAt,
          bytesActual: 17,
        });
        expect(f.repository.abortDownload).not.toHaveBeenCalled();
      } else {
        expect(f.repository.abortDownload).toHaveBeenCalledWith({
          ...LEASE,
          leaseVersion: 6,
          now: settledAt,
          bytesActual: 9,
          reason: 'client gone',
        });
        expect(f.repository.completeDownload).not.toHaveBeenCalled();
      }
      expect(f.runtime.now).toHaveBeenCalledTimes(2);
      expect(f.transfer.complete(1000)).toBe(settlement);
      expect(f.runtime.cancel).toHaveBeenCalledTimes(1);
    },
  );

  it('reports original background renewal errors and permits renewal after rejection cleanup', async () => {
    const f = setup();
    const failure = new Error('renewal failed');
    f.repository.renewDownload
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(4);
    await f.tick();
    expect(f.backgroundError).toHaveBeenCalledWith(failure);
    await f.tick();
    expect(f.repository.renewDownload).toHaveBeenCalledTimes(2);
    await f.transfer.complete(3);
    expect(f.repository.completeDownload).toHaveBeenCalledWith({
      ...LEASE,
      leaseVersion: 4,
      now: NOW,
      bytesActual: 3,
    });
  });

  it('retains renewal rejection while settling without executing a final database transition', async () => {
    const f = setup();
    const renewal = deferred<number | null>();
    f.repository.renewDownload.mockReturnValue(renewal.promise);
    const tick = f.tick();
    const settlement = f.transfer.abort(2, 'disconnect');
    const failure = new Error('renew while settling failed');
    const rejected = expect(settlement).rejects.toBe(failure);
    renewal.reject(failure);
    await tick;
    await rejected;
    expect(f.backgroundError).toHaveBeenCalledWith(failure);
    expect(f.transfer.complete(9)).toBe(settlement);
    await expect(f.transfer.complete(9)).rejects.toBe(failure);
    expect(f.repository.completeDownload).not.toHaveBeenCalled();
    expect(f.repository.abortDownload).not.toHaveBeenCalled();
    expect(f.runtime.now).toHaveBeenCalledTimes(1);
    expect(f.runtime.cancel).toHaveBeenCalledTimes(1);
  });

  it.each(['complete', 'abort'])(
    'retains original %s rejection and identical settlement promise on retries',
    async (kind) => {
      const f = setup();
      const failure = new Error('settlement failed');
      f.repository.completeDownload.mockRejectedValue(failure);
      f.repository.abortDownload.mockRejectedValue(failure);
      const settlement =
        kind === 'complete'
          ? f.transfer.complete(31)
          : f.transfer.abort(7, 'reset');
      await expect(settlement).rejects.toBe(failure);
      expect(f.transfer.abort(0, 'retry')).toBe(settlement);
      expect(f.transfer.complete(0)).toBe(settlement);
      expect(f.runtime.cancel).toHaveBeenCalledTimes(1);
      expect(f.runtime.now).toHaveBeenCalledTimes(1);
      expect(f.repository.completeDownload).toHaveBeenCalledTimes(
        kind === 'complete' ? 1 : 0,
      );
      expect(f.repository.abortDownload).toHaveBeenCalledTimes(
        kind === 'abort' ? 1 : 0,
      );
    },
  );
});
