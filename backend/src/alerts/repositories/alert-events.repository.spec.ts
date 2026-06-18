import {
  AlertDecision,
  AlertEventType,
  DeliveryAttemptStatus,
  DeliveryChannel,
  Prisma,
  DeliveryFailureClass,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import { AlertEventTypes } from '../dto/alert-events.dto.js';
import {
  AlertEventsRepository,
  toPrismaEventType,
} from './alert-events.repository.js';

type PrismaMocks = {
  readonly alertEvent: {
    readonly findUnique: jest.Mock;
  };
  readonly deliveryAttempt: {
    readonly update: jest.Mock;
  };
  readonly $transaction: jest.Mock;
};

// PrismaService exposes the guarded client as `db`; the SUT calls prisma.db.*.
// `db` and the top-level aliases share the same jest.fn() instances.
type PrismaDouble = PrismaMocks & { readonly db: PrismaMocks };

type TransactionDouble = {
  readonly alertEvent: {
    readonly create: jest.Mock;
  };
  readonly deliveryAttempt: {
    readonly create: jest.Mock;
  };
};

describe('AlertEventsRepository', () => {
  it('returns duplicate state without creating another delivery attempt', async () => {
    const prisma = prismaDouble();
    const existingEvent = eventRecord();
    const existingDelivery = deliveryRecord({
      status: DeliveryAttemptStatus.SENT,
    });
    prisma.alertEvent.findUnique.mockResolvedValue({
      ...existingEvent,
      deliveryAttempts: [existingDelivery],
    });
    const repository = new AlertEventsRepository(
      prisma as unknown as PrismaService,
    );

    const result = await repository.createEventWithInitialDelivery({
      event: validIngress(),
      decision: { kind: 'dispatch' },
    });

    expect(result).toEqual({
      event: existingEvent,
      deliveryAttempt: existingDelivery,
      duplicate: true,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('recovers duplicate state after a concurrent unique-constraint race', async () => {
    const prisma = prismaDouble();
    const existingEvent = eventRecord();
    const existingDelivery = deliveryRecord({
      status: DeliveryAttemptStatus.PENDING,
    });
    prisma.alertEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...existingEvent,
        deliveryAttempts: [existingDelivery],
      });
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    const repository = new AlertEventsRepository(
      prisma as unknown as PrismaService,
    );

    const result = await repository.createEventWithInitialDelivery({
      event: validIngress(),
      decision: { kind: 'dispatch' },
    });

    expect(result).toEqual({
      event: existingEvent,
      deliveryAttempt: existingDelivery,
      duplicate: true,
    });
    expect(prisma.alertEvent.findUnique).toHaveBeenCalledTimes(2);
  });

  it('creates AlertEvent and first pending DeliveryAttempt in one transaction', async () => {
    const prisma = prismaDouble();
    const tx = transactionDouble();
    tx.alertEvent.create.mockResolvedValue(eventRecord());
    tx.deliveryAttempt.create.mockResolvedValue(
      deliveryRecord({ status: DeliveryAttemptStatus.PENDING }),
    );
    prisma.alertEvent.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(
      (callback: (tx: TransactionDouble) => unknown) => callback(tx),
    );
    const repository = new AlertEventsRepository(
      prisma as unknown as PrismaService,
    );

    await repository.createEventWithInitialDelivery({
      event: validIngress(),
      decision: { kind: 'dispatch' },
    });

    expect(tx.alertEvent.create).toHaveBeenCalledWith({
      data: {
        sourceId: 'edge-camera-1',
        externalEventId: 'edge-event-1',
        type: AlertEventType.FALL,
        detectedAt: new Date('2026-06-13T10:00:00.000Z'),
        confidence: 0.87,
        fallProbability: undefined,
        operatingThreshold: undefined,
        decision: AlertDecision.DISPATCH,
        suppressedReason: undefined,
      },
    });
    expect(tx.deliveryAttempt.create).toHaveBeenCalledWith({
      data: {
        alertEventId: 'alert-event-1',
        channel: DeliveryChannel.KAKAO_SEND_TO_ME,
        status: DeliveryAttemptStatus.PENDING,
      },
    });
  });

  it('maps all supported ingress event types to Prisma enum values', () => {
    expect(toPrismaEventType(AlertEventTypes.bedExit)).toBe(
      AlertEventType.BED_EXIT,
    );
    expect(toPrismaEventType(AlertEventTypes.fall)).toBe(AlertEventType.FALL);
    expect(toPrismaEventType(AlertEventTypes.detectionLost)).toBe(
      AlertEventType.DETECTION_LOST,
    );
    expect(() =>
      toPrismaEventType('foo' as Parameters<typeof toPrismaEventType>[0]),
    ).toThrow('Unsupported alert event type: foo');
  });

  it('records transient failures as retry scheduled with next attempt time', async () => {
    const prisma = prismaDouble();
    prisma.deliveryAttempt.update.mockResolvedValue(
      deliveryRecord({ status: DeliveryAttemptStatus.RETRY_SCHEDULED }),
    );
    const repository = new AlertEventsRepository(
      prisma as unknown as PrismaService,
    );
    const now = new Date('2026-06-13T10:00:00.000Z');

    await repository.recordDeliveryResult(
      'delivery-attempt-1',
      {
        kind: 'failed',
        failure_class: 'transient',
        reason: 'kakao_http_503',
        retry_after_ms: 30_000,
      },
      now,
    );

    expect(prisma.deliveryAttempt.update).toHaveBeenCalledWith({
      where: { id: 'delivery-attempt-1' },
      data: {
        status: DeliveryAttemptStatus.RETRY_SCHEDULED,
        attemptCount: { increment: 1 },
        failureClass: DeliveryFailureClass.TRANSIENT,
        terminalReason: null,
        operatorAction: null,
        lastError: 'kakao_http_503',
        nextAttemptAt: new Date('2026-06-13T10:00:30.000Z'),
      },
    });
  });

  it('records terminal failures as operator-action states without retry', async () => {
    const prisma = prismaDouble();
    prisma.deliveryAttempt.update.mockResolvedValue(
      deliveryRecord({ status: DeliveryAttemptStatus.TERMINAL_FAILED }),
    );
    const repository = new AlertEventsRepository(
      prisma as unknown as PrismaService,
    );

    await repository.recordDeliveryResult('delivery-attempt-1', {
      kind: 'failed',
      failure_class: 'terminal_operator_action',
      reason: 'Kakao config is missing: KAKAO_TOKEN_PATH',
      operator_action: 'Provide a token file.',
    });

    expect(prisma.deliveryAttempt.update).toHaveBeenCalledWith({
      where: { id: 'delivery-attempt-1' },
      data: {
        status: DeliveryAttemptStatus.TERMINAL_FAILED,
        attemptCount: { increment: 1 },
        failureClass: DeliveryFailureClass.TERMINAL_OPERATOR_ACTION,
        terminalReason: 'Kakao config is missing: KAKAO_TOKEN_PATH',
        operatorAction: 'Provide a token file.',
        lastError: 'Kakao config is missing: KAKAO_TOKEN_PATH',
        nextAttemptAt: null,
      },
    });
  });
});

function prismaDouble(): PrismaDouble {
  const mocks: PrismaMocks = {
    alertEvent: {
      findUnique: jest.fn(),
    },
    deliveryAttempt: {
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  return { ...mocks, db: mocks };
}

function transactionDouble(): TransactionDouble {
  return {
    alertEvent: {
      create: jest.fn(),
    },
    deliveryAttempt: {
      create: jest.fn(),
    },
  };
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

function deliveryRecord(input: { readonly status: DeliveryAttemptStatus }) {
  return {
    id: 'delivery-attempt-1',
    alertEventId: 'alert-event-1',
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
