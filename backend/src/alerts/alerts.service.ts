import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AlertStatusDto } from './dto/alert-status.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FacilityScopedNotFoundException } from '../common/domain-errors.js';
import { AlertWriterService } from './alert-writer.service.js';
import { alertInclude, presentAlert } from './alerts.presenter.js';

export interface AlertQuery {
  residentId?: string;
  status?: AlertStatusDto;
  /** Forward cursor: returns alerts with alertSeq > afterSeq. */
  afterSeq?: bigint;
  /** Backward cursor: returns alerts with alertSeq < beforeSeq (AC7 history scroll). */
  beforeSeq?: bigint;
  limit?: number;
}

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: AlertWriterService,
  ) {}

  async list(facilityId: string, query: AlertQuery = {}) {
    const { residentId, status, afterSeq, beforeSeq, limit = 50 } = query;
    const take = Math.min(limit, 200);
    const alertSeqFilter: { gt?: bigint; lt?: bigint } = {};
    if (afterSeq !== undefined) alertSeqFilter.gt = afterSeq;
    if (beforeSeq !== undefined) alertSeqFilter.lt = beforeSeq;
    const alerts = await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) =>
        tx.alert.findMany({
          where: {
            residentId: residentId ?? undefined,
            status: status ?? undefined,
            alertSeq:
              Object.keys(alertSeqFilter).length > 0
                ? alertSeqFilter
                : undefined,
          },
          orderBy: { alertSeq: 'desc' },
          take,
          include: alertInclude,
        }),
    );
    return alerts.map(presentAlert);
  }

  async getOne(facilityId: string, id: string) {
    const alert = await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) =>
        tx.alert.findUnique({
          where: { id },
          include: alertInclude,
        }),
    );
    if (!alert) throw new FacilityScopedNotFoundException('alert');
    return presentAlert(alert);
  }

  /**
   * Acknowledge an alert (NEW → ACKED). Transition + audit stamp + SSE emit are
   * owned by AlertWriterService so all Alert mutations share one serialized queue.
   */
  ack(facilityId: string, id: string, actorUserId: string) {
    return this.writer.ackAlert({ facilityId, alertId: id, actorUserId });
  }

  /**
   * Resolve an alert (NEW/ACKED → RESOLVED). Delegated to the writer for
   * serialized transition + audit stamp + post-commit SSE emit.
   */
  resolve(facilityId: string, id: string, actorUserId: string) {
    return this.writer.resolveAlert({ facilityId, alertId: id, actorUserId });
  }

  async setSnapshotKey(facilityId: string, id: string, snapshotKey: string) {
    const existing = await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) => tx.alert.findUnique({ where: { id } }),
    );
    if (!existing) throw new FacilityScopedNotFoundException('alert');
    return this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) =>
        tx.alert.update({ where: { id }, data: { snapshotKey } }),
    );
  }

  async replay(facilityId: string, afterSeq: bigint) {
    return this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) =>
        tx.alert.findMany({
          where: { alertSeq: { gt: afterSeq } },
          orderBy: { alertSeq: 'asc' },
          include: alertInclude,
        }),
    );
  }
}
