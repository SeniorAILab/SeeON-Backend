import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  AbortDownloadAudit,
  CompleteDownloadAudit,
  DownloadAuditLease,
  ExpiredDownloadAudit,
  RecoverDownloadAudit,
  RenewDownloadAudit,
  StartDownloadAudit,
} from './media-download-audit.types.js';

@Injectable()
export class MediaDownloadAuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  async startDownload(input: StartDownloadAudit): Promise<DownloadAuditLease> {
    await this.prisma.withFacilityContext(input.facilityId, async (tx) => {
      await tx.mediaDownloadAudit.create({
        data: {
          id: input.id,
          facilityId: input.facilityId,
          clipId: input.clipId,
          alertId: input.alertId,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          requestId: input.requestId,
          httpStatus: input.httpStatus,
          rangeStart:
            input.rangeStart === null ? null : BigInt(input.rangeStart),
          rangeEnd: input.rangeEnd === null ? null : BigInt(input.rangeEnd),
          bytesPlanned: BigInt(input.bytesPlanned),
          processId: input.processId,
          leaseVersion: 1,
          streamLeaseExpiresAt: input.streamLeaseExpiresAt,
          startedAt: input.now,
          outboxJob: {
            create: {
              leaseVersion: 1,
              nextAttemptAt: input.streamLeaseExpiresAt,
            },
          },
        },
      });
    });
    return {
      id: input.id,
      facilityId: input.facilityId,
      processId: input.processId,
      leaseVersion: 1,
    };
  }

  async renewDownload(input: RenewDownloadAudit): Promise<number | null> {
    return this.prisma.withFacilityContext(input.facilityId, async (tx) => {
      const audit = await tx.mediaDownloadAudit.updateMany({
        where: startedLeaseWhere(input),
        data: {
          leaseVersion: { increment: 1 },
          streamLeaseExpiresAt: input.streamLeaseExpiresAt,
        },
      });
      if (audit.count === 0) return null;
      await completePendingOutbox(tx, input, {
        leaseVersion: { increment: 1 },
        nextAttemptAt: input.streamLeaseExpiresAt,
      });
      return input.leaseVersion + 1;
    });
  }

  completeDownload(input: CompleteDownloadAudit): Promise<boolean> {
    return this.finishDownload({ kind: 'completed', ...input });
  }

  abortDownload(input: AbortDownloadAudit): Promise<boolean> {
    return this.finishDownload({ kind: 'aborted', ...input });
  }

  async findExpired(
    facilityId: string,
    now: Date,
  ): Promise<readonly ExpiredDownloadAudit[]> {
    return this.prisma.withFacilityContext(facilityId, async (tx) => {
      const jobs = await tx.mediaDownloadOutboxJob.findMany({
        where: {
          facilityId,
          state: 'PENDING',
          nextAttemptAt: { lte: now },
          audit: {
            state: 'STARTED',
            streamLeaseExpiresAt: { lte: now },
            process: { leaseExpiresAt: { lte: now } },
          },
        },
        select: {
          auditId: true,
          leaseVersion: true,
          audit: { select: { processId: true, leaseVersion: true } },
        },
      });
      return jobs.flatMap((job) =>
        job.leaseVersion === job.audit.leaseVersion
          ? [
              {
                id: job.auditId,
                facilityId,
                processId: job.audit.processId,
                leaseVersion: job.leaseVersion,
              },
            ]
          : [],
      );
    });
  }

  async recoverExpired(input: RecoverDownloadAudit): Promise<boolean> {
    return this.prisma.withFacilityContext(input.facilityId, async (tx) => {
      const audit = await tx.mediaDownloadAudit.updateMany({
        where: {
          ...startedLeaseWhere(input),
          streamLeaseExpiresAt: { lte: input.now },
          process: { leaseExpiresAt: { lte: input.now } },
        },
        data: {
          state: 'ABORTED',
          leaseVersion: { increment: 1 },
          abortedAt: input.now,
          abortReason: 'PROCESS_LEASE_EXPIRED',
        },
      });
      if (audit.count === 0) return false;
      await completePendingOutbox(tx, input, {
        state: 'COMPLETED',
        leaseVersion: { increment: 1 },
        attemptCount: { increment: 1 },
        lockedByProcessId: input.recoveryProcessId,
        lockedAt: input.now,
        recoveryStartedAt: input.now,
        recoveredAt: input.now,
        completedAt: input.now,
        lastError: null,
      });
      return true;
    });
  }

  private async finishDownload(
    input:
      | ({ readonly kind: 'completed' } & CompleteDownloadAudit)
      | ({ readonly kind: 'aborted' } & AbortDownloadAudit),
  ): Promise<boolean> {
    return this.prisma.withFacilityContext(input.facilityId, async (tx) => {
      const audit = await tx.mediaDownloadAudit.updateMany({
        where: startedLeaseWhere(input),
        data:
          input.kind === 'completed'
            ? {
                state: 'COMPLETED',
                leaseVersion: { increment: 1 },
                bytesActual: BigInt(input.bytesActual),
                completedAt: input.now,
              }
            : {
                state: 'ABORTED',
                leaseVersion: { increment: 1 },
                bytesActual: BigInt(input.bytesActual),
                abortedAt: input.now,
                abortReason: input.reason,
              },
      });
      if (audit.count === 0) return false;
      await completePendingOutbox(tx, input, {
        state: 'COMPLETED',
        leaseVersion: { increment: 1 },
        completedAt: input.now,
      });
      return true;
    });
  }
}

export class MediaDownloadAuditConsistencyError extends Error {
  readonly name = 'MediaDownloadAuditConsistencyError';

  constructor() {
    super('download audit and recovery job lease versions diverged');
  }
}

function startedLeaseWhere(input: DownloadAuditLease) {
  return {
    id: input.id,
    facilityId: input.facilityId,
    processId: input.processId,
    state: 'STARTED' as const,
    leaseVersion: input.leaseVersion,
  };
}

async function completePendingOutbox(
  tx: Prisma.TransactionClient,
  input: DownloadAuditLease,
  data: Prisma.MediaDownloadOutboxJobUncheckedUpdateManyInput,
): Promise<void> {
  const outbox = await tx.mediaDownloadOutboxJob.updateMany({
    where: {
      auditId: input.id,
      facilityId: input.facilityId,
      state: 'PENDING',
      leaseVersion: input.leaseVersion,
    },
    data,
  });
  if (outbox.count !== 1) throw new MediaDownloadAuditConsistencyError();
}
