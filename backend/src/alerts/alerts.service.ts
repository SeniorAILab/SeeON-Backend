import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AlertStatusDto } from './dto/alert-status.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FacilityScopedNotFoundException } from '../common/domain-errors.js';
import { AlertWriterService } from './alert-writer.service.js';
import {
  alertDetailInclude,
  alertInclude,
  presentAlert,
  presentAlertDetail,
} from './alerts.presenter.js';

export interface AlertQuery {
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
    const { status, afterSeq, beforeSeq, limit = 50 } = query;
    const take = Math.min(limit, 200);
    const alertSeqFilter: { gt?: bigint; lt?: bigint } = {};
    if (afterSeq !== undefined) alertSeqFilter.gt = afterSeq;
    if (beforeSeq !== undefined) alertSeqFilter.lt = beforeSeq;
    const alerts = await this.prisma.withFacilityContext(
      facilityId,
      (tx: Prisma.TransactionClient) =>
        tx.alert.findMany({
          where: {
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
          include: alertDetailInclude,
        }),
    );
    if (!alert) throw new FacilityScopedNotFoundException('alert');
    return presentAlertDetail(alert);
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
   *
   * 조치 기록(note) 유무와 무관하게 해결 처리한다. 메모는 여전히 남길 수
   * 있는 선택 기능이지만(`addNote`), 해결 완료를 막는 조건은 아니다 —
   * 화면에는 텍스트 입력이 없고, 실제로 현장에 다녀왔다는 사실 자체가
   * writer가 찍는 actorUserId/시각으로 남는다.
   */
  resolve(facilityId: string, id: string, actorUserId: string) {
    return this.writer.resolveAlert({ facilityId, alertId: id, actorUserId });
  }

  async addNote(input: {
    facilityId: string;
    alertId: string;
    note: string;
    actorUserId: string;
    actorRole: 'ADMIN' | 'STAFF';
  }) {
    const trimmedNote = input.note.trim();
    if (!trimmedNote) throw new FacilityScopedNotFoundException('alert');
    return this.prisma.withFacilityContext(
      input.facilityId,
      async (tx: Prisma.TransactionClient) => {
        const alert = await tx.alert.findUnique({
          where: { id: input.alertId },
          select: { id: true, facilityId: true },
        });
        if (!alert) throw new FacilityScopedNotFoundException('alert');
        const created = await tx.alertNote.create({
          data: {
            facilityId: alert.facilityId,
            alertId: alert.id,
            note: trimmedNote,
            createdById: input.actorUserId,
            authorRole: input.actorRole,
          },
          select: {
            id: true,
            note: true,
            createdById: true,
            authorRole: true,
            createdAt: true,
          },
        });
        return {
          id: created.id,
          note: created.note,
          createdBy: created.createdById,
          authorRole: created.authorRole,
          createdAt: created.createdAt,
        };
      },
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
          include: alertInclude,
        }),
    );
  }
}
