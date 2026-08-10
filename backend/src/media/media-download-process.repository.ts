import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ProcessLease } from './media-download-audit.types.js';

@Injectable()
export class MediaDownloadProcessRepository {
  constructor(private readonly prisma: PrismaService) {}

  async startProcess(input: ProcessLease): Promise<void> {
    await this.prisma.db.mediaDownloadProcessHeartbeat.upsert({
      where: { processId: input.processId },
      create: {
        processId: input.processId,
        heartbeatAt: input.now,
        leaseExpiresAt: input.leaseExpiresAt,
      },
      update: {
        heartbeatAt: input.now,
        leaseExpiresAt: input.leaseExpiresAt,
        stoppedAt: null,
      },
    });
  }

  async renewProcess(input: ProcessLease): Promise<boolean> {
    const result =
      await this.prisma.db.mediaDownloadProcessHeartbeat.updateMany({
        where: { processId: input.processId, stoppedAt: null },
        data: {
          heartbeatAt: input.now,
          leaseExpiresAt: input.leaseExpiresAt,
        },
      });
    return result.count === 1;
  }

  async stopProcess(processId: string, now: Date): Promise<void> {
    await this.prisma.db.mediaDownloadProcessHeartbeat.updateMany({
      where: { processId, stoppedAt: null },
      data: { stoppedAt: now, heartbeatAt: now, leaseExpiresAt: now },
    });
  }

  async listFacilityIds(): Promise<readonly string[]> {
    const facilities = await this.prisma.db.facility.findMany({
      select: { id: true },
    });
    return facilities.map((facility) => facility.id);
  }
}
