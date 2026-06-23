import {
  AlertDecision as PrismaAlertDecision,
  AlertEventType as PrismaAlertEventType,
  AlertSuppressedReason as PrismaAlertSuppressedReason,
  DeliveryAttemptStatus as PrismaDeliveryAttemptStatus,
  DeliveryChannel,
  DeliveryFailureClass as PrismaDeliveryFailureClass,
  Prisma,
  type AlertEvent,
  type DeliveryAttempt,
} from '@prisma/client';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  AlertEventTypes,
  type AlertEventRequestDto,
  type AlertPolicyDecision,
  type AlertSuppressedReason,
} from '../dto/alert-events.dto.js';
import type { DeliveryResult } from '../ports/channel.port.js';

const DEFAULT_RETRY_AFTER_MS = 60_000;
const DEFAULT_OPERATOR_ACTION =
  'Inspect Kakao channel configuration/token state and retry manually after correction.';

export type ExistingAlertEventAggregate = {
  readonly event: AlertEvent;
  readonly deliveryAttempt?: DeliveryAttempt;
};

export type AlertEventAggregate = ExistingAlertEventAggregate & {
  readonly duplicate: boolean;
};

export type CreateAlertEventInput = {
  readonly event: AlertEventRequestDto;
  readonly decision: AlertPolicyDecision;
  readonly fallProbability?: number;
  readonly operatingThreshold?: number;
};

export type IngestOutboxInput = CreateAlertEventInput & {
  readonly recipientUserIds: readonly string[];
};

export type IngestOutboxAggregate = {
  readonly event: AlertEvent;
  readonly deliveryAttempts: readonly DeliveryAttempt[];
  readonly duplicate: boolean;
};

@Injectable()
export class AlertEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findExistingByExternalKey(
    sourceId: string,
    externalEventId: string,
  ): Promise<ExistingAlertEventAggregate | null> {
    const event = await this.prisma.db.alertEvent.findUnique({
      where: {
        alert_events_source_external_event_id_key: {
          sourceId,
          externalEventId,
        },
      },
      include: {
        deliveryAttempts: {
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });

    if (event === null) {
      return null;
    }

    const { deliveryAttempts, ...alertEvent } = event;
    const [deliveryAttempt] = deliveryAttempts;
    return {
      event: alertEvent,
      deliveryAttempt,
    };
  }

  async createEventWithInitialDelivery(
    input: CreateAlertEventInput,
  ): Promise<AlertEventAggregate> {
    const duplicate = await this.findExistingByExternalKey(
      input.event.source_id,
      input.event.external_event_id,
    );
    if (duplicate !== null) {
      return { ...duplicate, duplicate: true };
    }

    try {
      return await this.prisma.db.$transaction(async (tx) => {
        const event = await tx.alertEvent.create({
          data: alertEventCreateData(input),
        });

        if (input.decision.kind === 'suppress') {
          return { event, duplicate: false };
        }

        const deliveryAttempt = await tx.deliveryAttempt.create({
          data: {
            alertEventId: event.id,
            channel: DeliveryChannel.KAKAO_SEND_TO_ME,
            status: PrismaDeliveryAttemptStatus.PENDING,
          },
        });

        return { event, deliveryAttempt, duplicate: false };
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await this.findExistingByExternalKey(
          input.event.source_id,
          input.event.external_event_id,
        );
        if (existing !== null) {
          return { ...existing, duplicate: true };
        }
      }
      throw error;
    }
  }

  async ensureIngestOutbox(
    input: IngestOutboxInput,
  ): Promise<IngestOutboxAggregate> {
    return this.prisma.db.$transaction(async (tx) => {
      const existing = await tx.alertEvent.findUnique({
        where: {
          alert_events_source_external_event_id_key: {
            sourceId: input.event.source_id,
            externalEventId: input.event.external_event_id,
          },
        },
      });

      const event =
        existing ??
        (await tx.alertEvent.create({
          data: alertEventCreateData(input),
        }));

      if (
        input.decision.kind === 'suppress' ||
        input.recipientUserIds.length === 0
      ) {
        return { event, deliveryAttempts: [], duplicate: existing !== null };
      }

      for (const recipientUserId of input.recipientUserIds) {
        await tx.deliveryAttempt.upsert({
          where: {
            delivery_attempts_alert_event_id_recipient_user_id_key: {
              alertEventId: event.id,
              recipientUserId,
            },
          },
          create: {
            alertEventId: event.id,
            recipientUserId,
            channel: DeliveryChannel.KAKAO_SEND_TO_ME,
            status: PrismaDeliveryAttemptStatus.PENDING,
          },
          update: {},
        });
      }

      const deliveryAttempts = await tx.deliveryAttempt.findMany({
        where: {
          alertEventId: event.id,
          recipientUserId: { in: [...input.recipientUserIds] },
        },
        orderBy: { recipientUserId: 'asc' },
      });

      return {
        event,
        deliveryAttempts,
        duplicate: existing !== null,
      };
    });
  }

  async recordDeliveryResult(
    deliveryAttemptId: string,
    result: DeliveryResult,
    now: Date = new Date(),
  ): Promise<DeliveryAttempt> {
    if (result.kind === 'sent') {
      return this.prisma.db.deliveryAttempt.update({
        where: { id: deliveryAttemptId },
        data: {
          status: PrismaDeliveryAttemptStatus.SENT,
          attemptCount: { increment: 1 },
          providerReference: result.provider_reference,
          sentAt: now,
          failureClass: null,
          terminalReason: null,
          operatorAction: null,
          lastError: null,
          nextAttemptAt: null,
        },
      });
    }

    const retryable = result.failure_class === 'transient';
    return this.prisma.db.deliveryAttempt.update({
      where: { id: deliveryAttemptId },
      data: {
        status: retryable
          ? PrismaDeliveryAttemptStatus.RETRY_SCHEDULED
          : PrismaDeliveryAttemptStatus.TERMINAL_FAILED,
        attemptCount: { increment: 1 },
        failureClass: retryable
          ? PrismaDeliveryFailureClass.TRANSIENT
          : PrismaDeliveryFailureClass.TERMINAL_OPERATOR_ACTION,
        terminalReason: retryable ? null : result.reason,
        operatorAction: retryable
          ? null
          : (result.operator_action ?? DEFAULT_OPERATOR_ACTION),
        lastError: result.reason,
        nextAttemptAt: retryable
          ? new Date(
              now.getTime() + (result.retry_after_ms ?? DEFAULT_RETRY_AFTER_MS),
            )
          : null,
      },
    });
  }
}

function alertEventCreateData(input: CreateAlertEventInput) {
  return {
    sourceId: input.event.source_id,
    externalEventId: input.event.external_event_id,
    type: toPrismaEventType(input.event.type),
    detectedAt: new Date(input.event.detected_at),
    confidence: input.event.confidence,
    fallProbability: input.fallProbability,
    operatingThreshold: input.operatingThreshold,
    decision: toPrismaDecision(input.decision),
    suppressedReason: toPrismaSuppressedReason(input.decision),
  };
}

export function toPrismaEventType(
  type: AlertEventRequestDto['type'],
): PrismaAlertEventType {
  switch (type) {
    case AlertEventTypes.fall:
      return PrismaAlertEventType.FALL;
    case AlertEventTypes.detectionLost:
      return PrismaAlertEventType.DETECTION_LOST;
    case AlertEventTypes.bedExit:
      return PrismaAlertEventType.BED_EXIT;
    default: {
      const exhaustive: never = type;
      throw new Error(`Unsupported alert event type: ${String(exhaustive)}`);
    }
  }
}

function toPrismaDecision(decision: AlertPolicyDecision): PrismaAlertDecision {
  return decision.kind === 'dispatch'
    ? PrismaAlertDecision.DISPATCH
    : PrismaAlertDecision.SUPPRESS;
}

function toPrismaSuppressedReason(
  decision: AlertPolicyDecision,
): PrismaAlertSuppressedReason | undefined {
  if (decision.kind === 'dispatch') {
    return undefined;
  }
  return toPrismaSuppressedReasonValue(decision.suppressed_reason);
}

function toPrismaSuppressedReasonValue(
  reason: AlertSuppressedReason,
): PrismaAlertSuppressedReason {
  if (reason === 'cooldown') {
    return PrismaAlertSuppressedReason.COOLDOWN;
  }
  if (reason === 'hourly_cap') {
    return PrismaAlertSuppressedReason.HOURLY_CAP;
  }
  return PrismaAlertSuppressedReason.BELOW_THRESHOLD;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
