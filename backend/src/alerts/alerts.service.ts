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

  async ack(facilityId: string, id: string) {
    const existing = await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) => tx.alert.findUnique({ where: { id } }),
    );
    if (!existing) throw new NotFoundException('Alert not found');
    const alert = await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) =>
        tx.alert.update({
          where: { id },
          data: { status: AlertStatus.ACKED },
          include: alertInclude,
        }),
    );
    return presentAlert(alert);
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

const alertInclude = {
  resident: { select: { name: true } },
  space: { select: { name: true } },
} satisfies Prisma.AlertInclude;

type AlertWithContext = Prisma.AlertGetPayload<{
  include: typeof alertInclude;
}>;

function presentAlert(alert: AlertWithContext) {
  return {
    alertSeq: alert.alertSeq.toString(),
    id: alert.id,
    facilityId: alert.facilityId,
    residentId: alert.residentId,
    cameraId: alert.cameraId,
    spaceId: alert.spaceId,
    room: alert.space.name,
    type: alert.type,
    probability: alert.probability,
    snapshotKey: alert.snapshotKey,
    detectedAt: alert.detectedAt,
    status: alert.status,
    resident: alert.resident,
    space: alert.space,
    createdAt: alert.createdAt,
  };
}
