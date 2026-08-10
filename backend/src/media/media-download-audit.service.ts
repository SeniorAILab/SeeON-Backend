import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MediaDownloadAuditRepository } from './media-download-audit.repository.js';
import type { StartDownloadAudit } from './media-download-audit.types.js';
import { MediaDownloadProcessRepository } from './media-download-process.repository.js';
import {
  type MediaDownloadInterval,
  MediaDownloadRuntime,
} from './media-download-runtime.js';
import { MediaDownloadTransfer } from './media-download-transfer.js';

const PROCESS_LEASE_MS = 180_000;
const MAINTENANCE_INTERVAL_MS = 30_000;

@Injectable()
export class MediaDownloadAuditService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MediaDownloadAuditService.name);
  private readonly processId = randomUUID();
  private maintenanceInterval: MediaDownloadInterval | null = null;
  private maintenance: Promise<void> | null = null;

  constructor(
    private readonly audits: MediaDownloadAuditRepository,
    private readonly processes: MediaDownloadProcessRepository,
    private readonly runtime: MediaDownloadRuntime,
  ) {}

  async onModuleInit(): Promise<void> {
    const now = this.runtime.now();
    await this.processes.startProcess({
      processId: this.processId,
      now,
      leaseExpiresAt: new Date(now.getTime() + PROCESS_LEASE_MS),
    });
    this.maintenanceInterval = this.runtime.every(MAINTENANCE_INTERVAL_MS, () =>
      this.startMaintenance(),
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.maintenanceInterval !== null) {
      this.runtime.cancel(this.maintenanceInterval);
    }
    if (this.maintenance !== null) await this.maintenance;
    await this.processes.stopProcess(this.processId, this.runtime.now());
  }

  async beginDownload(
    input: Omit<
      StartDownloadAudit,
      'id' | 'processId' | 'now' | 'streamLeaseExpiresAt'
    >,
  ): Promise<MediaDownloadTransfer> {
    const now = this.runtime.now();
    const lease = await this.audits.startDownload({
      ...input,
      id: randomUUID(),
      processId: this.processId,
      now,
      streamLeaseExpiresAt: new Date(now.getTime() + 120_000),
    });
    return new MediaDownloadTransfer(
      lease,
      this.audits,
      this.runtime,
      (error) => this.reportBackgroundFailure(error),
    );
  }

  async runMaintenance(): Promise<void> {
    const now = this.runtime.now();
    await this.processes.renewProcess({
      processId: this.processId,
      now,
      leaseExpiresAt: new Date(now.getTime() + PROCESS_LEASE_MS),
    });
    for (const facilityId of await this.processes.listFacilityIds()) {
      for (const candidate of await this.audits.findExpired(facilityId, now)) {
        await this.audits.recoverExpired({
          ...candidate,
          recoveryProcessId: this.processId,
          now,
        });
      }
    }
  }

  async observeSettlement(settlement: Promise<boolean>): Promise<void> {
    try {
      await settlement;
    } catch (error) {
      this.reportBackgroundFailure(error);
    }
  }

  getProcessId(): string {
    return this.processId;
  }

  private startMaintenance(): Promise<void> {
    if (this.maintenance !== null) return this.maintenance;
    const maintenance = this.runMaintenance()
      .catch((error: unknown) => this.reportBackgroundFailure(error))
      .finally(() => {
        if (this.maintenance === maintenance) this.maintenance = null;
      });
    this.maintenance = maintenance;
    return maintenance;
  }

  private reportBackgroundFailure(error: unknown): void {
    this.logger.error({
      event: 'media_download_audit.background_failure',
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}
