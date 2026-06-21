import { Injectable, NotFoundException } from '@nestjs/common';
import { AlertStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { FacilityScopedNotFoundException } from '../common/domain-errors.js';

export interface AlertQuery {
  residentId?: string;
  status?: AlertStatus;
  /** Forward cursor: returns alerts with alertSeq > afterSeq. */
  afterSeq?: bigint;
  /** Backward cursor: returns alerts with alertSeq < beforeSeq (AC7 history scroll). */
  beforeSeq?: bigint;
  limit?: number;
}

@Injectable()
export class AlertsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(facilityId: string, query: AlertQuery = {}) {
    const { residentId, status, afterSeq, beforeSeq, limit = 50 } = query;
    const take = Math.min(limit, 200);
    const alertSeqFilter: { gt?: bigint; lt?: bigint } = {};
    if (afterSeq !== undefined) alertSeqFilter.gt = afterSeq;
    if (beforeSeq !== undefined) alertSeqFilter.lt = beforeSeq;
    return this.prisma.withFacilityContext(
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
          include: { resident: { select: { name: true, room: true } } },
        }),
    );
  }

  async getOne(facilityId: string, id: string) {
    const alert = await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) =>
        tx.alert.findUnique({
          where: { id },
          include: { resident: { select: { name: true, room: true } } },
        }),
    );
    if (!alert) throw new FacilityScopedNotFoundException('alert');
    return alert;
  }

  async ack(facilityId: string, id: string) {
    const existing = await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) => tx.alert.findUnique({ where: { id } }),
    );
    if (!existing) throw new NotFoundException('Alert not found');
    return this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) =>
        tx.alert.update({
          where: { id },
          data: { status: AlertStatus.ACKED },
          include: { resident: { select: { name: true, room: true } } },
        }),
    );
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
          include: { resident: { select: { name: true, room: true } } },
        }),
    );
  }
}
