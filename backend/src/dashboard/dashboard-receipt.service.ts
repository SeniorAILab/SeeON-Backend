import { Injectable } from '@nestjs/common';
import { DashboardReceiptKind, Prisma } from '@prisma/client';
import { FacilityScopedNotFoundException } from '../common/domain-errors.js';
import { isUniqueConstraintViolation } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';

interface ReceiptInput {
  facilityId: string;
  dashboardClientId: string;
  backendEventId: string;
  alertId: string;
  alertSeq: string;
  observedAt: string;
  kind: DashboardReceiptKind;
  surface: string;
}

@Injectable()
export class DashboardReceiptService {
  constructor(private readonly prisma: PrismaService) {}

  recordDelivery(
    input: Omit<ReceiptInput, 'kind' | 'surface'>,
  ): Promise<DashboardReceiptResponse> {
    return this.record({
      ...input,
      kind: DashboardReceiptKind.DELIVERY,
      surface: 'normalized-feed',
    });
  }

  recordPresentation(
    input: Omit<ReceiptInput, 'kind'>,
  ): Promise<DashboardReceiptResponse> {
    return this.record({ ...input, kind: DashboardReceiptKind.PRESENTATION });
  }

  private async record(input: ReceiptInput): Promise<DashboardReceiptResponse> {
    const alertSeq = BigInt(input.alertSeq);
    const receiptKey = {
      facilityId: input.facilityId,
      dashboardClientId: input.dashboardClientId,
      kind: input.kind,
      alertId: input.alertId,
      alertSeq,
      surface: input.surface,
    };
    try {
      const outcome = await this.prisma.withFacilityContext(
        input.facilityId,
        async (tx: Prisma.TransactionClient) => {
          const existing = await tx.dashboardReceipt.findFirst({
            where: receiptKey,
          });
          if (existing) return { receipt: existing, duplicate: true };

          const alert = await tx.alert.findFirst({
            where: {
              id: input.alertId,
              facilityId: input.facilityId,
              alertSeq,
              originEventId: input.backendEventId,
            },
            select: { id: true },
          });
          if (!alert) {
            throw new FacilityScopedNotFoundException('dashboard alert event');
          }

          const receipt = await tx.dashboardReceipt.create({
            data: {
              ...receiptKey,
              backendEventId: input.backendEventId,
              observedAt: new Date(input.observedAt),
            },
          });
          return { receipt, duplicate: false };
        },
      );
      return presentReceipt(outcome.receipt, outcome.duplicate);
    } catch (error: unknown) {
      // Race: a concurrent insert landed between the duplicate check and create.
      if (!isUniqueConstraintViolation(error)) throw error;
      const receipt = await this.prisma.withFacilityContext(
        input.facilityId,
        (tx: Prisma.TransactionClient) =>
          tx.dashboardReceipt.findFirst({ where: receiptKey }),
      );
      if (!receipt) throw error;
      return presentReceipt(receipt, true);
    }
  }
}

type ReceiptRecord = {
  id: string;
  kind: DashboardReceiptKind;
  backendEventId: string;
  alertId: string;
  alertSeq: bigint;
  surface: string;
  observedAt: Date;
  createdAt: Date;
};

export interface DashboardReceiptResponse {
  deliveryId?: string;
  presentationId?: string;
  backendEventId: string;
  alertId: string;
  alertSeq: string;
  kind: 'delivery' | 'presentation';
  surface: string;
  observedAt: Date;
  recordedAt: Date;
  duplicate: boolean;
}

function presentReceipt(
  receipt: ReceiptRecord,
  duplicate: boolean,
): DashboardReceiptResponse {
  const presentation = receipt.kind === DashboardReceiptKind.PRESENTATION;
  return {
    ...(presentation
      ? { presentationId: receipt.id }
      : { deliveryId: receipt.id }),
    backendEventId: receipt.backendEventId,
    alertId: receipt.alertId,
    alertSeq: receipt.alertSeq.toString(),
    kind: presentation ? 'presentation' : 'delivery',
    surface: receipt.surface,
    observedAt: receipt.observedAt,
    recordedAt: receipt.createdAt,
    duplicate,
  };
}
