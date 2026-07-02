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
  type AlertEventRequestDto,
} from '../dto/alert-events.dto.js';
import {
  ALERT_CHANNEL_PORT,
  type ChannelPort,
  type DeliveryResult,
} from '../ports/channel.port.js';
import { AlertEventsRepository } from '../repositories/alert-events.repository.js';

const DEFAULT_DELIVERY_TIMEOUT_MS = 5_000;

export type EnsureOutboxForIngestInput = {
  readonly facilityId: string;
  readonly sourceId: string;
  readonly externalEventId: string;
  readonly type: AlertEventRequestDto['type'];
  readonly detectedAt: Date;
  readonly confidence?: number;
  readonly residentName?: string;
  readonly residentRoom?: string | null;
};

@Injectable()
export class AlertEventsService {
  constructor(
    private readonly alertEventsRepository: AlertEventsRepository,
    @Inject(ALERT_CHANNEL_PORT)
    private readonly channelPort: ChannelPort,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async ensureOutboxForIngest(
    input: EnsureOutboxForIngestInput,
  ): Promise<void> {
    const event: AlertEventRequestDto = {
      type: input.type,
      source_id: input.sourceId,
      external_event_id: input.externalEventId,
      detected_at: input.detectedAt.toISOString(),
      confidence: input.confidence,
    };
    const recipients =
      input.type === AlertEventTypes.bedExit
        ? []
        : await this.findKakaoRecipients(input.facilityId);
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
          input.residentName,
          input.residentRoom,
        );
      }),
    );
  }

  private async dispatchRecipient(
    event: AlertEventRequestDto,
    eventId: string,
    deliveryAttempt: DeliveryAttempt,
    recipient: KakaoRecipient,
    residentName: string | undefined,
    residentRoom: string | null | undefined,
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
      resident_name: residentName,
      resident_room: residentRoom,
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
    facilityId: string,
  ): Promise<readonly KakaoRecipient[]> {
    const recipients = await this.prisma.db.user.findMany({
      where: {
        facilityId,
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
}

type KakaoRecipient = User & {
  readonly kakaoIdentity: KakaoIdentity & {
    readonly accessTokenCipher: string;
  };
};

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
