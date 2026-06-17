import { Inject, Injectable } from '@nestjs/common';
import {
  DeliveryAttemptStatus,
  type DeliveryAttempt,
  type KakaoIdentity,
  type User,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';

import { decryptToken } from '../../auth/token-crypto.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  AlertEventTypes,
  type AlertEventIngressDto,
  type AlertEventResponseDto,
  type DeliveryStatusDto,
  type PredictionAlertInputDto,
  type PredictionWindowAlertInputDto,
} from '../dto/alert-events.dto.js';
import {
  ALERT_CHANNEL_PORT,
  type ChannelPort,
  type DeliveryResult,
} from '../ports/channel.port.js';
import {
  ALERT_PREDICTION_PORT,
  type PredictionPort,
} from '../ports/prediction.port.js';
import type { ExistingAlertEventAggregate } from '../repositories/alert-events.repository.js';
import { AlertEventsRepository } from '../repositories/alert-events.repository.js';
import { AlertPolicyService } from './alert-policy.service.js';

const DEFAULT_DELIVERY_TIMEOUT_MS = 5_000;

export type EnsureOutboxForIngestInput = {
  readonly orgId: string;
  readonly sourceId: string;
  readonly externalEventId: string;
  readonly type: AlertEventIngressDto['type'];
  readonly detectedAt: Date;
  readonly confidence?: number;
};

@Injectable()
export class AlertEventsService {
  constructor(
    private readonly alertPolicyService: AlertPolicyService,
    private readonly alertEventsRepository: AlertEventsRepository,
    @Inject(ALERT_CHANNEL_PORT)
    private readonly channelPort: ChannelPort,
    @Inject(ALERT_PREDICTION_PORT)
    private readonly predictionPort: PredictionPort,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async ingest(event: AlertEventIngressDto): Promise<AlertEventResponseDto> {
    const duplicate = await this.findDuplicate(event);
    if (duplicate !== null) {
      return toDuplicateResponse(duplicate);
    }

    const policyDecision = this.alertPolicyService.evaluateIngress(event);
    return this.createAndDispatch({ event, policyDecision });
  }

  async predictAndIngest(
    input: PredictionWindowAlertInputDto,
  ): Promise<AlertEventResponseDto> {
    const prediction = await this.predictionPort.predict(input.request);
    return this.ingestPrediction({
      source_id: input.source_id,
      external_event_id: input.external_event_id,
      detected_at: input.detected_at,
      prediction,
    });
  }

  async ingestPrediction(
    input: PredictionAlertInputDto,
  ): Promise<AlertEventResponseDto> {
    const event = {
      type: AlertEventTypes.fall,
      source_id: input.source_id,
      external_event_id: input.external_event_id,
      detected_at: input.detected_at,
      confidence: input.prediction.fall_probability,
    };
    const duplicate = await this.findDuplicate(event);
    if (duplicate !== null) {
      return toDuplicateResponse(duplicate);
    }

    const policyDecision = this.alertPolicyService.evaluatePrediction(input);
    return this.createAndDispatch({
      event,
      fallProbability: input.prediction.fall_probability,
      operatingThreshold: input.prediction.operating_threshold,
      policyDecision,
    });
  }

  async ensureOutboxForIngest(
    input: EnsureOutboxForIngestInput,
  ): Promise<void> {
    const event: AlertEventIngressDto = {
      type: input.type,
      source_id: input.sourceId,
      external_event_id: input.externalEventId,
      detected_at: input.detectedAt.toISOString(),
      confidence: input.confidence,
    };
    const recipients = await this.findKakaoRecipients(input.orgId);
    const aggregate = await this.alertEventsRepository.ensureIngestOutbox({
      event,
      decision: { kind: 'dispatch' },
      recipientUserIds: recipients.map((recipient) => recipient.id),
    });

    const recipientsById = new Map(
      recipients.map((recipient) => [recipient.id, recipient]),
    );

    await Promise.all(
      aggregate.deliveryAttempts.map(async (deliveryAttempt) => {
        const recipient =
          deliveryAttempt.recipientUserId === null
            ? undefined
            : recipientsById.get(deliveryAttempt.recipientUserId);
        if (recipient === undefined) {
          return;
        }
        // Duplicate-repair safety: only dispatch attempts still PENDING. Existing
        // SENT/RETRY_SCHEDULED/TERMINAL_FAILED attempts must not be re-sent (the
        // recipient unique key prevents duplicate rows, not duplicate Kakao sends).
        if (deliveryAttempt.status !== DeliveryAttemptStatus.PENDING) {
          return;
        }
        await this.dispatchRecipient(
          event,
          aggregate.event.id,
          deliveryAttempt,
          recipient,
        );
      }),
    );
  }

  private async createAndDispatch(input: {
    readonly event: AlertEventIngressDto;
    readonly policyDecision: ReturnType<AlertPolicyService['evaluateIngress']>;
    readonly fallProbability?: number;
    readonly operatingThreshold?: number;
  }): Promise<AlertEventResponseDto> {
    const aggregate =
      await this.alertEventsRepository.createEventWithInitialDelivery({
        event: input.event,
        decision: input.policyDecision,
        fallProbability: input.fallProbability,
        operatingThreshold: input.operatingThreshold,
      });

    const baseResponse = {
      event_id: aggregate.event.id,
      duplicate: aggregate.duplicate,
    };

    if (aggregate.deliveryAttempt === undefined) {
      return baseResponse;
    }

    if (aggregate.duplicate) {
      return {
        ...baseResponse,
        delivery_attempt_id: aggregate.deliveryAttempt.id,
        delivery_status: toDeliveryStatusDto(aggregate.deliveryAttempt.status),
      };
    }

    const result = await this.channelPort.send({
      ...input.event,
      event_id: aggregate.event.id,
      delivery_attempt_id: aggregate.deliveryAttempt.id,
      created_at: aggregate.deliveryAttempt.createdAt,
    });
    const updatedDelivery =
      await this.alertEventsRepository.recordDeliveryResult(
        aggregate.deliveryAttempt.id,
        result,
      );

    return {
      ...baseResponse,
      delivery_attempt_id: updatedDelivery.id,
      delivery_status: toDeliveryStatusDto(updatedDelivery.status),
    };
  }

  private async dispatchRecipient(
    event: AlertEventIngressDto,
    eventId: string,
    deliveryAttempt: DeliveryAttempt,
    recipient: KakaoRecipient,
  ): Promise<void> {
    const expired =
      recipient.kakaoIdentity.tokenExpiresAt !== null &&
      recipient.kakaoIdentity.tokenExpiresAt.getTime() <= Date.now();
    if (expired) {
      await this.alertEventsRepository.recordDeliveryResult(
        deliveryAttempt.id,
        {
          kind: 'failed',
          failure_class: 'terminal_operator_action',
          reason: 'kakao_access_token_expired',
          operator_action:
            'Refresh Kakao OAuth access for the recipient before retrying delivery.',
        },
      );
      return;
    }

    let recipientAccessToken: string;
    try {
      recipientAccessToken = decryptToken(
        recipient.kakaoIdentity.accessTokenCipher,
      );
    } catch (error) {
      await this.alertEventsRepository.recordDeliveryResult(
        deliveryAttempt.id,
        {
          kind: 'failed',
          failure_class: 'terminal_operator_action',
          reason:
            error instanceof Error
              ? error.message
              : 'kakao_token_decrypt_failed',
          operator_action:
            'Refresh Kakao OAuth access for the recipient before retrying delivery.',
        },
      );
      return;
    }

    const result = await this.sendWithTimeout({
      ...event,
      event_id: eventId,
      delivery_attempt_id: deliveryAttempt.id,
      created_at: deliveryAttempt.createdAt,
      recipient_access_token: recipientAccessToken,
    });
    await this.alertEventsRepository.recordDeliveryResult(
      deliveryAttempt.id,
      result,
    );
  }

  private async sendWithTimeout(
    message: Parameters<ChannelPort['send']>[0],
  ): Promise<DeliveryResult> {
    const timeoutMs = readPositiveIntegerEnv(
      this.configService.get<string>('ALERT_DELIVERY_TIMEOUT_MS'),
      DEFAULT_DELIVERY_TIMEOUT_MS,
    );
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.channelPort.send(message).catch((error: unknown) => ({
          kind: 'failed' as const,
          failure_class: 'transient' as const,
          reason:
            error instanceof Error ? error.message : 'channel_send_rejected',
          retry_after_ms: 60_000,
        })),
        new Promise<DeliveryResult>((resolve) => {
          timeout = setTimeout(
            () =>
              resolve({
                kind: 'failed',
                failure_class: 'transient',
                reason: 'alert_delivery_timeout',
                retry_after_ms: 60_000,
              }),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private async findKakaoRecipients(
    orgId: string,
  ): Promise<readonly KakaoRecipient[]> {
    const recipients = await this.prisma.db.user.findMany({
      where: {
        orgId,
        kakaoIdentity: {
          accessTokenCipher: { not: null },
        },
      },
      include: { kakaoIdentity: true },
      orderBy: { id: 'asc' },
    });

    return recipients.filter(
      (recipient): recipient is KakaoRecipient =>
        recipient.kakaoIdentity !== null &&
        recipient.kakaoIdentity.accessTokenCipher !== null,
    );
  }

  private async findDuplicate(
    event: AlertEventIngressDto,
  ): Promise<ExistingAlertEventAggregate | null> {
    return this.alertEventsRepository.findExistingByExternalKey(
      event.source_id,
      event.external_event_id,
    );
  }
}

type KakaoRecipient = User & {
  readonly kakaoIdentity: KakaoIdentity & {
    readonly accessTokenCipher: string;
  };
};

function toDuplicateResponse(
  aggregate: ExistingAlertEventAggregate,
): AlertEventResponseDto {
  if (aggregate.deliveryAttempt === undefined) {
    return {
      event_id: aggregate.event.id,
      duplicate: true,
    };
  }

  return {
    event_id: aggregate.event.id,
    duplicate: true,
    delivery_attempt_id: aggregate.deliveryAttempt.id,
    delivery_status: toDeliveryStatusDto(aggregate.deliveryAttempt.status),
  };
}

function toDeliveryStatusDto(status: DeliveryAttemptStatus): DeliveryStatusDto {
  if (status === DeliveryAttemptStatus.SENT) {
    return 'sent';
  }
  if (status === DeliveryAttemptStatus.RETRY_SCHEDULED) {
    return 'retry_scheduled';
  }
  if (status === DeliveryAttemptStatus.TERMINAL_FAILED) {
    return 'terminal_failed';
  }
  return 'pending';
}

function readPositiveIntegerEnv(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
