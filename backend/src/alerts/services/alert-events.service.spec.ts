import {
  AlertDecision,
  AlertEventType,
  DeliveryAttemptStatus,
  DeliveryChannel,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { encryptToken } from '../../auth/token-crypto.js';
import { PrismaService } from '../../prisma/prisma.service.js';

import {
  AlertEventTypes,
  type PredictionAlertInputDto,
} from '../dto/alert-events.dto.js';
import type { ChannelPort } from '../ports/channel.port.js';
import type { PredictionPort } from '../ports/prediction.port.js';
import { AlertEventsRepository } from '../repositories/alert-events.repository.js';
import {
  AlertPolicyClock,
  AlertPolicyService,
} from './alert-policy.service.js';
import { AlertEventsService } from './alert-events.service.js';

class FixedAlertPolicyClock extends AlertPolicyClock {
  nowMs(): number {
    return Date.parse('2026-06-13T00:00:00.000Z');
  }
}

type AlertEventsRepositoryMock = {
  readonly findExistingByExternalKey: jest.MockedFunction<
    AlertEventsRepository['findExistingByExternalKey']
  >;
  readonly createEventWithInitialDelivery: jest.MockedFunction<
    AlertEventsRepository['createEventWithInitialDelivery']
  >;
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
  it('returns existing delivery state for duplicate external events before mutating policy or sending', async () => {
    const repository = repositoryDouble();
    repository.findExistingByExternalKey.mockResolvedValue({
      event: eventRecord(),
      deliveryAttempt: deliveryRecord({ status: DeliveryAttemptStatus.SENT }),
    });
    const channel = channelDouble();
    const service = createService(repository, channel, predictionDouble());

    const response = await service.ingest(validIngress());

    expect(response).toEqual({
      event_id: 'alert-event-1',
      duplicate: true,
      delivery_attempt_id: 'delivery-attempt-1',
      delivery_status: 'sent',
    });
    expect(repository.createEventWithInitialDelivery).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('persists event and delivery before sending through ChannelPort', async () => {
    const repository = repositoryDouble();
    repository.findExistingByExternalKey.mockResolvedValue(null);
    repository.createEventWithInitialDelivery.mockResolvedValue({
      event: eventRecord(),
      deliveryAttempt: deliveryRecord({
        status: DeliveryAttemptStatus.PENDING,
      }),
      duplicate: false,
    });
    repository.recordDeliveryResult.mockResolvedValue(
      deliveryRecord({ status: DeliveryAttemptStatus.SENT }),
    );
    const channel = channelDouble();
    channel.send.mockResolvedValue({ kind: 'sent' });
    const service = createService(repository, channel, predictionDouble());

    const response = await service.ingest(validIngress());

    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: 'alert-event-1',
        delivery_attempt_id: 'delivery-attempt-1',
        external_event_id: 'edge-event-1',
      }),
    );
    expect(repository.recordDeliveryResult).toHaveBeenCalledWith(
      'delivery-attempt-1',
      { kind: 'sent' },
    );
    expect(response.delivery_status).toBe('sent');
  });

  it('consumes the /predict contract and suppresses below-threshold predictions', async () => {
    const repository = repositoryDouble();
    repository.findExistingByExternalKey.mockResolvedValue(null);
    repository.createEventWithInitialDelivery.mockResolvedValue({
      event: eventRecord(),
      duplicate: false,
    });
    const channel = channelDouble();
    const service = createService(repository, channel, predictionDouble());

    const predictionInput: PredictionAlertInputDto = {
      source_id: 'backend-orchestrated-camera-1',
      external_event_id: 'predict-window-1',
      detected_at: '2026-06-13T10:00:00.000Z',
      prediction: {
        fall_probability: 0.42,
        operating_threshold: 0.8,
        is_fall: false,
      },
    };

    await service.ingestPrediction(predictionInput);

    const [createInput] =
      repository.createEventWithInitialDelivery.mock.calls[0] ?? [];
    if (createInput === undefined) {
      throw new Error('Expected createEventWithInitialDelivery to be called');
    }
    expect(createInput.event.type).toBe(AlertEventTypes.fall);
    expect(createInput.event.confidence).toBe(0.42);
    expect(createInput.fallProbability).toBe(0.42);
    expect(createInput.operatingThreshold).toBe(0.8);
    expect(createInput.decision).toEqual({
      kind: 'suppress',
      suppressed_reason: 'below_threshold',
    });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('calls ML serving through PredictionPort before applying backend alert policy', async () => {
    const repository = repositoryDouble();
    repository.findExistingByExternalKey.mockResolvedValue(null);
    repository.createEventWithInitialDelivery.mockResolvedValue({
      event: eventRecord(),
      duplicate: false,
    });
    const prediction = predictionDouble();
    prediction.predict.mockResolvedValue({
      fall_probability: 0.91,
      operating_threshold: 0.8,
      is_fall: true,
    });
    const service = createService(repository, channelDouble(), prediction);
    const request = { window: [[0, 0, 0.9]] };

    await service.predictAndIngest({
      source_id: 'backend-orchestrated-camera-1',
      external_event_id: 'predict-window-2',
      detected_at: '2026-06-13T10:00:00.000Z',
      request,
    });

    expect(prediction.predict).toHaveBeenCalledWith(request);
    const [createInput] =
      repository.createEventWithInitialDelivery.mock.calls[0] ?? [];
    if (createInput === undefined) {
      throw new Error('Expected createEventWithInitialDelivery to be called');
    }
    expect(createInput.event.confidence).toBe(0.91);
    expect(createInput.fallProbability).toBe(0.91);
    expect(createInput.operatingThreshold).toBe(0.8);
    expect(createInput.decision).toEqual({ kind: 'dispatch' });
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
  const policy = new AlertPolicyService(config, new FixedAlertPolicyClock());
  return new AlertEventsService(
    policy,
    repository as unknown as AlertEventsRepository,
    channel,
    prediction,
    prisma,
    config,
  );
}

function validIngress() {
  return {
    type: AlertEventTypes.fall,
    source_id: 'edge-camera-1',
    external_event_id: 'edge-event-1',
    detected_at: '2026-06-13T10:00:00.000Z',
    confidence: 0.87,
  };
}

function repositoryDouble(): AlertEventsRepositoryMock {
  return {
    findExistingByExternalKey: jest.fn(),
    createEventWithInitialDelivery: jest.fn(),
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
