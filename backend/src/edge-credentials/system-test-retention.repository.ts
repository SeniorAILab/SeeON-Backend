import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

export interface SystemTestPurgeResult {
  receiptId: string | null;
  jobId: string;
  facilityId: string;
  purgedEvents: number;
  purgedAlerts: number;
  purgedDashboardReceipts: number;
  purgedAlertNotes: number;
  purgedAt: Date | null;
  replayed: boolean;
}

type SystemTestPurgeRow = {
  receipt_id: string | null;
  job_id: string;
  facility_id: string;
  purged_events: number;
  purged_alerts: number;
  purged_dashboard_receipts: number;
  purged_alert_notes: number;
  purged_at: Date | null;
  replayed: boolean;
};

@Injectable()
export class SystemTestRetentionRepository {
  constructor(private readonly prisma: PrismaService) {}

  purge(facilityId: string, jobId: string): Promise<SystemTestPurgeResult> {
    return this.prisma.withFacilityContext(
      facilityId,
      async (tx: Prisma.TransactionClient) => {
        const rows = await tx.$queryRaw<SystemTestPurgeRow[]>`
          SELECT *
          FROM public.purge_expired_system_tests(${facilityId}, ${jobId}::uuid)
        `;
        const row = rows[0];
        return {
          receiptId: row.receipt_id,
          jobId: row.job_id,
          facilityId: row.facility_id,
          purgedEvents: row.purged_events,
          purgedAlerts: row.purged_alerts,
          purgedDashboardReceipts: row.purged_dashboard_receipts,
          purgedAlertNotes: row.purged_alert_notes,
          purgedAt: row.purged_at,
          replayed: row.replayed,
        };
      },
    );
  }
}
