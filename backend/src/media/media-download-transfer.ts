import type { MediaDownloadAuditRepository } from './media-download-audit.repository.js';
import type { DownloadAuditLease } from './media-download-audit.types.js';
import type { MediaDownloadRuntime } from './media-download-runtime.js';
import { type MediaDownloadInterval } from './media-download-runtime.js';

const STREAM_LEASE_MS = 120_000;
const RENEWAL_INTERVAL_MS = 30_000;

export class MediaDownloadTransfer {
  private lease: DownloadAuditLease;
  private readonly interval: MediaDownloadInterval;
  private renewal: Promise<void> | null = null;
  private settlement: Promise<boolean> | null = null;
  private settling = false;

  constructor(
    lease: DownloadAuditLease,
    private readonly repository: MediaDownloadAuditRepository,
    private readonly runtime: MediaDownloadRuntime,
    onBackgroundError: (error: unknown) => void,
  ) {
    this.lease = lease;
    this.interval = runtime.every(RENEWAL_INTERVAL_MS, () => {
      return this.renew().catch(onBackgroundError);
    });
  }

  complete(bytesActual: number): Promise<boolean> {
    return this.settle('completed', bytesActual, '');
  }

  abort(bytesActual: number, reason: string): Promise<boolean> {
    return this.settle('aborted', bytesActual, reason);
  }

  private renew(): Promise<void> {
    if (this.settling) return Promise.resolve();
    if (this.renewal !== null) return this.renewal;
    const now = this.runtime.now();
    const renewal = this.repository
      .renewDownload({
        ...this.lease,
        now,
        streamLeaseExpiresAt: new Date(now.getTime() + STREAM_LEASE_MS),
      })
      .then((leaseVersion) => {
        if (leaseVersion !== null) {
          this.lease = { ...this.lease, leaseVersion };
        }
      })
      .finally(() => {
        if (this.renewal === renewal) this.renewal = null;
      });
    this.renewal = renewal;
    return renewal;
  }

  private settle(
    kind: 'completed' | 'aborted',
    bytesActual: number,
    reason: string,
  ): Promise<boolean> {
    if (this.settlement !== null) return this.settlement;
    this.settling = true;
    this.runtime.cancel(this.interval);
    this.settlement = (async () => {
      if (this.renewal !== null) await this.renewal;
      const now = this.runtime.now();
      return kind === 'completed'
        ? this.repository.completeDownload({
            ...this.lease,
            now,
            bytesActual,
          })
        : this.repository.abortDownload({
            ...this.lease,
            now,
            bytesActual,
            reason,
          });
    })();
    return this.settlement;
  }
}
