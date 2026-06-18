import {
  AlertDecision,
  AlertEventType,
  DeliveryAttemptStatus,
  DeliveryChannel,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { encryptToken } from '../../auth/token-crypto.js';
import { PrismaService } from '../../prisma/prisma.service.js';

import { AlertEventTypes } from '../dto/alert-events.dto.js';
import type { ChannelPort } from '../ports/channel.port.js';
import type { PredictionPort } from '../ports/prediction.port.js';
import { AlertEventsRepository } from '../repositories/alert-events.repository.js';
import { AlertEventsService } from './alert-events.service.js';

type AlertEventsRepositoryMock = {
  readonly recordDeliveryResult: jest.MockedFunction<
    AlertEventsRepository['recordDeliveryResult']
  >;
  readonly ensureIngestOutbox: jest.MockedFunction<
    AlertEventsRepository['ensureIngestOutbox']
  >;
};

type ChannelPortMock = {
  readonly send: jest.MockedFunction<ChannelPort['send']>;
};

type PredictionPortMock = {
  readonly predict: jest.MockedFunction<PredictionPort['predict']>;
};

describe('AlertEventsService', () => {
  it('retains the ALERT_PREDICTION_PORT seam for future backend-owned prediction policy wiring', () => {
    const prediction = predictionDouble();
    const service = createService(
      repositoryDouble(),
      channelDouble(),
      prediction,
    );

    expect(service.predictionSeam()).toBe(prediction);
  });

  it('ensures ingest outbox once and fans out independently per recipient', async () => {
    process.env.KAKAO_TOKEN_ENC_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const repository = repositoryDouble();
    repository.ensureIngestOutbox.mockResolvedValue({
      event: eventRecord(),
      duplicate: false,
      deliveryAttempts: [
        deliveryRecord({
          id: 'delivery-attempt-1',
          recipientUserId: 'user-1',
          status: DeliveryAttemptStatus.PENDING,
        }),
        deliveryRecord({
          id: 'delivery-attempt-2',
          recipientUserId: 'user-2',
          status: DeliveryAttemptStatus.PENDING,
        }),
      ],
    });
    repository.recordDeliveryResult.mockResolvedValue(
      deliveryRecord({ status: DeliveryAttemptStatus.SENT }),
    );
    const channel = channelDouble();
    channel.send
      .mockResolvedValueOnce({ kind: 'sent' })
      .mockRejectedValueOnce(new Error('network'));
    const prisma = prismaDouble([
      recipientRecord('user-1', encryptToken('token-1')),
      recipientRecord('user-2', encryptToken('token-2')),
    ]);
    const service = createService(
      repository,
      channel,
      predictionDouble(),
      prisma,
    );

    await service.ensureOutboxForIngest({
      orgId: 'org-1',
      sourceId: 'cam-1',
      externalEventId: 'idem-1',
      type: AlertEventTypes.fall,
      detectedAt: new Date('2026-06-13T10:00:00.000Z'),
      confidence: 0.9,
    });

    expect(repository.ensureIngestOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserIds: ['user-1', 'user-2'],
      }),
    );
    expect(channel.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        delivery_attempt_id: 'delivery-attempt-1',
        recipient_access_token: 'token-1',
      }),
    );
    expect(channel.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        delivery_attempt_id: 'delivery-attempt-2',
        recipient_access_token: 'token-2',
      }),
    );
    expect(repository.recordDeliveryResult).toHaveBeenCalledWith(
      'delivery-attempt-1',
      { kind: 'sent' },
    );
    expect(repository.recordDeliveryResult).toHaveBeenCalledWith(
      'delivery-attempt-2',
      expect.objectContaining({
        kind: 'failed',
        failure_class: 'transient',
        reason: 'network',
      }),
    );
  });

  it('records bed-exit ingest events without delivery attempts or Kakao sends', async () => {
    const repository = repositoryDouble();
    repository.ensureIngestOutbox.mockResolvedValue({
      event: {
        ...eventRecord(),
        type: AlertEventType.BED_EXIT,
      },
      duplicate: false,
      deliveryAttempts: [],
    });
    const channel = channelDouble();
    const prisma = prismaDouble([
      recipientRecord('user-1', encryptToken('token-1')),
    ]);
    const service = createService(
      repository,
      channel,
      predictionDouble(),
      prisma,
    );

    await service.ensureOutboxForIngest({
      orgId: 'org-1',
      sourceId: 'cam-1',
      externalEventId: 'idem-bed-exit-1',
      type: AlertEventTypes.bedExit,
      detectedAt: new Date('2026-06-13T10:00:00.000Z'),
      confidence: 0.1,
    });

    expect(repository.ensureIngestOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: AlertEventTypes.bedExit,
          confidence: 0.1,
        }),
        recipientUserIds: [],
      }),
    );
    expect(channel.send).not.toHaveBeenCalled();
    expect(repository.recordDeliveryResult).not.toHaveBeenCalled();
  });

  it('skips already-SENT attempts on duplicate repair (no double Kakao send)', async () => {
    process.env.KAKAO_TOKEN_ENC_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const repository = repositoryDouble();
    repository.ensureIngestOutbox.mockResolvedValue({
      event: eventRecord(),
      duplicate: true,
      deliveryAttempts: [
        deliveryRecord({
          id: 'delivery-attempt-sent',
          recipientUserId: 'user-1',
          status: DeliveryAttemptStatus.SENT,
        }),
        deliveryRecord({
          id: 'delivery-attempt-pending',
          recipientUserId: 'user-2',
          status: DeliveryAttemptStatus.PENDING,
        }),
      ],
    });
    repository.recordDeliveryResult.mockResolvedValue(
      deliveryRecord({ status: DeliveryAttemptStatus.SENT }),
    );
    const channel = channelDouble();
    channel.send.mockResolvedValue({ kind: 'sent' });
    const prisma = prismaDouble([
      recipientRecord('user-1', encryptToken('token-1')),
      recipientRecord('user-2', encryptToken('token-2')),
    ]);
    const service = createService(
      repository,
      channel,
      predictionDouble(),
      prisma,
    );

    await service.ensureOutboxForIngest({
      orgId: 'org-1',
      sourceId: 'cam-1',
      externalEventId: 'idem-1',
      type: AlertEventTypes.fall,
      detectedAt: new Date('2026-06-13T10:00:00.000Z'),
      confidence: 0.9,
    });

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_attempt_id: 'delivery-attempt-pending',
        recipient_access_token: 'token-2',
      }),
    );
    expect(repository.recordDeliveryResult).not.toHaveBeenCalledWith(
      'delivery-attempt-sent',
      expect.anything(),
    );
  });

  it('records expired recipient tokens as terminal without sending', async () => {
    const repository = repositoryDouble();
    repository.ensureIngestOutbox.mockResolvedValue({
      event: eventRecord(),
      duplicate: false,
      deliveryAttempts: [
        deliveryRecord({
          id: 'delivery-attempt-1',
          recipientUserId: 'user-1',
          status: DeliveryAttemptStatus.PENDING,
        }),
      ],
    });
    repository.recordDeliveryResult.mockResolvedValue(
      deliveryRecord({ status: DeliveryAttemptStatus.TERMINAL_FAILED }),
    );
    const channel = channelDouble();
    const prisma = prismaDouble([
      recipientRecord('user-1', 'cipher', new Date('2026-06-12T00:00:00.000Z')),
    ]);
    const service = createService(
      repository,
      channel,
      predictionDouble(),
      prisma,
    );

    await service.ensureOutboxForIngest({
      orgId: 'org-1',
      sourceId: 'cam-1',
      externalEventId: 'idem-1',
      type: AlertEventTypes.fall,
      detectedAt: new Date('2026-06-13T10:00:00.000Z'),
      confidence: 0.9,
    });

    expect(channel.send).not.toHaveBeenCalled();
    expect(repository.recordDeliveryResult).toHaveBeenCalledWith(
      'delivery-attempt-1',
      expect.objectContaining({
        kind: 'failed',
        failure_class: 'terminal_operator_action',
        reason: 'kakao_access_token_expired',
      }),
    );
  });
});

function createService(
  repository: AlertEventsRepositoryMock,
  channel: ChannelPortMock,
  prediction: PredictionPortMock,
  prisma: PrismaService = prismaDouble([]),
): AlertEventsService {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'ALERT_POLICY_ENABLED') {
        return 'false';
      }
      return undefined;
    }),
  } as unknown as ConfigService;
  return new AlertEventsService(
    repository as unknown as AlertEventsRepository,
    channel,
    prediction,
    prisma,
    config,
  );
}

function repositoryDouble(): AlertEventsRepositoryMock {
  return {
    recordDeliveryResult: jest.fn(),
    ensureIngestOutbox: jest.fn(),
  };
}

function channelDouble(): ChannelPortMock {
  return {
    send: jest.fn(),
  };
}

function predictionDouble(): PredictionPortMock {
  return {
    predict: jest.fn(),
  };
}

function eventRecord() {
  return {
    id: 'alert-event-1',
    sourceId: 'edge-camera-1',
    externalEventId: 'edge-event-1',
    type: AlertEventType.FALL,
    detectedAt: new Date('2026-06-13T10:00:00.000Z'),
    confidence: 0.87,
    fallProbability: null,
    operatingThreshold: null,
    decision: AlertDecision.DISPATCH,
    suppressedReason: null,
    createdAt: new Date('2026-06-13T10:00:00.000Z'),
    updatedAt: new Date('2026-06-13T10:00:00.000Z'),
  };
}

function deliveryRecord(input: {
  readonly status: DeliveryAttemptStatus;
  readonly id?: string;
  readonly recipientUserId?: string | null;
}) {
  return {
    id: input.id ?? 'delivery-attempt-1',
    alertEventId: 'alert-event-1',
    recipientUserId: input.recipientUserId ?? null,
    channel: DeliveryChannel.KAKAO_SEND_TO_ME,
    status: input.status,
    attemptCount: 0,
    nextAttemptAt: null,
    providerReference: null,
    failureClass: null,
    terminalReason: null,
    operatorAction: null,
    lastError: null,
    sentAt: null,
    createdAt: new Date('2026-06-13T10:00:00.000Z'),
    updatedAt: new Date('2026-06-13T10:00:00.000Z'),
  };
}

function prismaDouble(recipients: readonly unknown[]): PrismaService {
  return {
    db: {
      user: {
        findMany: jest.fn().mockResolvedValue(recipients),
      },
    },
  } as unknown as PrismaService;
}

function recipientRecord(
  id: string,
  accessTokenCipher: string,
  tokenExpiresAt: Date | null = null,
) {
  return {
    id,
    orgId: 'org-1',
    kakaoIdentity: {
      accessTokenCipher,
      tokenExpiresAt,
    },
  };
}
