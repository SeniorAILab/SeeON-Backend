/**
 * AlertEventsService specs — two layers live in this file.
 *
 *  1. Service-level fan-out tests driving a doubled ChannelPort (original
 *     coverage, unchanged below).
 *  2. An isolated ALERT_CHANNEL_PORT integration proof: the genuine
 *     EmailChannelAdapter is resolved through Nest DI using the registration
 *     object AlertsModule itself declares, with the SMTP transport doubled.
 *
 * Import-time safety inventory (read before layer 2 was added; every file in
 * the AlertsModule import closure was inspected):
 *  - `nodemailer` is replaced by `jest.mock` declared ahead of the adapter and
 *    module imports, so `createTransport`/`sendMail` can never open a socket.
 *  - No file in the closure (`alerts/*`, `auth/*`, `common/*`, `prisma/*`)
 *    performs top-level `process.env`, filesystem, network, timer, Prisma
 *    client or transport work; every such call sits inside a function body.
 *    Module scope only holds constants, an AsyncLocalStorage carrier, classes
 *    and decorator metadata.
 *  - `new PrismaClient()` runs only in the `PrismaService` constructor, which
 *    is never reached: `PrismaService` is supplied as a `useValue` double and
 *    AlertsModule is never compiled or bootstrapped here.
 *  - `AuthModule`'s `JwtModule.registerAsync` only builds a dynamic-module
 *    descriptor at import time; its `useFactory` (which demands
 *    SESSION_JWT_SECRET) runs during DI resolution, which never happens here.
 *  - `@prisma/client` was already imported by this spec for enum values; the
 *    import loads generated code and opens no connection.
 *  - The registration proof reads `Reflect.getMetadata`, so it needs no app,
 *    no `init()`/`listen()`, no lifecycle hooks, and no AuthModule /
 *    PrismaModule / ConfigModule provider graph.
 *  - The `Test.createTestingModule` provider set is closed and narrowly owned:
 *    AlertEventsService, the module's own channel registration, and doubles for
 *    AlertEventsRepository, PrismaService and ConfigService.
 *  - Every SMTP/alert key the adapter and service read is removed from
 *    `process.env` for the integration describe and restored afterwards, and
 *    all values come from explicit ConfigService internal config (which takes
 *    precedence over `process.env` in @nestjs/config), so no ambient SMTP
 *    value can reach the adapter. The missing-SMTP_HOST test fails if one did.
 *
 * Not proven here (deliberate limits):
 *  - Real SMTP/TLS behaviour, nodemailer option validation and provider
 *    response codes: the transport is a double, so only the adapter's own
 *    option shape and error classification are observed.
 *  - Full AlertsModule/AppModule provider-graph resolution: owned by
 *    `test/alerts-read-provider-graph.spec.ts`.
 *  - Outbox persistence, unique keys, transactions and RLS: repository and
 *    PrismaService are doubles; DB-backed specs own that contract.
 *  - The `ALERT_DELIVERY_TIMEOUT_MS` expiry race: the doubled transport settles
 *    immediately, so only the non-expiring path is exercised.
 */
import 'reflect-metadata';
import {
  AlertDecision,
  AlertEventType,
  DeliveryAttemptStatus,
  DeliveryChannel,
} from '@prisma/client';
import type { Provider } from '@nestjs/common';
import {
  MODULE_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  readArray,
  readObject,
  readStringField,
  type JsonObject,
} from '../../../test/helpers/json-response.js';

import { AlertEventTypes } from '../alert-event.types.js';
import { ALERT_CHANNEL_PORT, type ChannelPort } from '../ports/channel.port.js';
import { AlertEventsRepository } from '../repositories/alert-events.repository.js';
import { AlertEventsService } from './alert-events.service.js';

// Declared before the adapter/module imports below: the genuine
// EmailChannelAdapter must never reach a real SMTP transport.
const sendMailMock = jest.fn<Promise<unknown>, [unknown]>();
const createTransportMock = jest.fn<
  { readonly sendMail: typeof sendMailMock },
  [unknown]
>(() => ({ sendMail: sendMailMock }));

jest.mock('nodemailer', () => ({
  createTransport: (...args: [unknown]) => createTransportMock(...args),
}));

import { EmailChannelAdapter } from '../adapters/email-channel.adapter.js';
import { AlertsModule } from '../alerts.module.js';

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

/** Single source for the ids/addresses the channel-port proof asserts on. */
const CHANNEL_PROOF = {
  facilityId: 'facility-1',
  sourceId: 'cam-1',
  firstAttemptId: 'delivery-attempt-1',
  secondAttemptId: 'delivery-attempt-2',
  firstRecipientId: 'user-1',
  secondRecipientId: 'user-2',
  firstRecipientEmail: 'admin1@example.test',
  secondRecipientEmail: 'admin2@example.test',
  residentName: '김복순',
  residentRoom: '201호',
  detectedAt: new Date('2026-06-13T10:00:00.000Z'),
  detectedAtKST: '2026-06-13 19:00 KST',
} as const;

/** Explicit SMTP/alert values; nothing is discovered from the environment. */
const SMTP_CONFIG = {
  SMTP_HOST: 'smtp.alerts.test',
  SMTP_PORT: '2525',
  SMTP_SECURE: 'false',
  SMTP_USER: 'alerts@example.test',
  SMTP_PASSWORD: 'unit-test-only-smtp-password',
  SMTP_FROM: 'Eldercare Safety <alerts@example.test>',
  ALERT_DASHBOARD_URL: 'https://dashboard.example.test',
  ALERT_DELIVERY_TIMEOUT_MS: '5000',
} as const;

/** Same run, minus every SMTP_* key, for the misconfiguration path. */
const SMTP_UNSET_CONFIG = {
  ALERT_DASHBOARD_URL: SMTP_CONFIG.ALERT_DASHBOARD_URL,
  ALERT_DELIVERY_TIMEOUT_MS: SMTP_CONFIG.ALERT_DELIVERY_TIMEOUT_MS,
} as const;

/** Every key the adapter and the service read, scrubbed so none can leak in. */
const CHANNEL_ENV_KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_FROM',
  'ALERT_DASHBOARD_URL',
  'ALERT_DELIVERY_TIMEOUT_MS',
] as const;

describe('AlertEventsService', () => {
  it('ensures ingest outbox once and fans out independently per recipient', async () => {
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
      recipientRecord('user-1', 'admin1@example.test'),
      recipientRecord('user-2', 'admin2@example.test'),
    ]);
    const service = createService(repository, channel, prisma);

    await service.ensureOutboxForIngest({
      facilityId: 'facility-1',
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
        recipient_email: 'admin1@example.test',
      }),
    );
    expect(channel.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        delivery_attempt_id: 'delivery-attempt-2',
        recipient_email: 'admin2@example.test',
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

  it('records bed-exit ingest events without delivery attempts or email sends', async () => {
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
      recipientRecord('user-1', 'admin1@example.test'),
    ]);
    const service = createService(repository, channel, prisma);

    await service.ensureOutboxForIngest({
      facilityId: 'facility-1',
      sourceId: 'cam-1',
      externalEventId: 'idem-bed-exit-1',
      type: AlertEventTypes.bedExit,
      detectedAt: new Date('2026-06-13T10:00:00.000Z'),
      confidence: 0.1,
    });

    expect(repository.ensureIngestOutbox).toHaveBeenCalledTimes(1);
    const [ingestInput] = repository.ensureIngestOutbox.mock.calls[0];
    expect(ingestInput.event.type).toBe(AlertEventTypes.bedExit);
    expect(ingestInput.event.confidence).toBe(0.1);
    expect(ingestInput.recipientUserIds).toEqual([]);
    expect(channel.send).not.toHaveBeenCalled();
    expect(repository.recordDeliveryResult).not.toHaveBeenCalled();
  });

  it('skips already-SENT attempts on duplicate repair (no double send)', async () => {
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
      recipientRecord('user-1', 'admin1@example.test'),
      recipientRecord('user-2', 'admin2@example.test'),
    ]);
    const service = createService(repository, channel, prisma);

    await service.ensureOutboxForIngest({
      facilityId: 'facility-1',
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
        recipient_email: 'admin2@example.test',
      }),
    );
    expect(repository.recordDeliveryResult).not.toHaveBeenCalledWith(
      'delivery-attempt-sent',
      expect.anything(),
    );
  });

  it('falls back to the base email when no notificationEmail is set', async () => {
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
      deliveryRecord({ status: DeliveryAttemptStatus.SENT }),
    );
    const channel = channelDouble();
    channel.send.mockResolvedValue({ kind: 'sent' });
    const prisma = prismaDouble([
      {
        id: 'user-1',
        facilityId: 'facility-1',
        notificationEmail: null,
        email: 'base@example.test',
        role: 'ADMIN',
        emailAlertsEnabled: true,
      },
    ]);
    const service = createService(repository, channel, prisma);

    await service.ensureOutboxForIngest({
      facilityId: 'facility-1',
      sourceId: 'cam-1',
      externalEventId: 'idem-1',
      type: AlertEventTypes.fall,
      detectedAt: new Date('2026-06-13T10:00:00.000Z'),
      confidence: 0.9,
    });

    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_email: 'base@example.test' }),
    );
  });

  it('skips RETRY_SCHEDULED and TERMINAL_FAILED attempts on duplicate repair (no double send)', async () => {
    const repository = repositoryDouble();
    repository.ensureIngestOutbox.mockResolvedValue({
      event: eventRecord(),
      duplicate: true,
      deliveryAttempts: [
        deliveryRecord({
          id: 'attempt-retry',
          recipientUserId: 'user-1',
          status: DeliveryAttemptStatus.RETRY_SCHEDULED,
        }),
        deliveryRecord({
          id: 'attempt-terminal',
          recipientUserId: 'user-2',
          status: DeliveryAttemptStatus.TERMINAL_FAILED,
        }),
        deliveryRecord({
          id: 'attempt-pending',
          recipientUserId: 'user-3',
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
      recipientRecord('user-1', 'admin1@example.test'),
      recipientRecord('user-2', 'admin2@example.test'),
      recipientRecord('user-3', 'admin3@example.test'),
    ]);
    const service = createService(repository, channel, prisma);

    await service.ensureOutboxForIngest({
      facilityId: 'facility-1',
      sourceId: 'cam-1',
      externalEventId: 'idem-1',
      type: AlertEventTypes.fall,
      detectedAt: new Date('2026-06-13T10:00:00.000Z'),
      confidence: 0.9,
    });

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_attempt_id: 'attempt-pending',
        recipient_email: 'admin3@example.test',
      }),
    );
  });
});

describe('AlertEventsService → ALERT_CHANNEL_PORT (real adapter)', () => {
  const ambientEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of CHANNEL_ENV_KEYS) {
      ambientEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterAll(() => {
    for (const [key, value] of ambientEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    ambientEnv.clear();
  });

  beforeEach(() => {
    sendMailMock.mockReset();
    createTransportMock.mockClear();
  });

  it('binds ALERT_CHANNEL_PORT to EmailChannelAdapter exactly once in AlertsModule', () => {
    const registrations = alertChannelRegistrations();

    expect(registrations).toHaveLength(1);
    const [registration] = registrations;
    expect(registration['useClass']).toBe(EmailChannelAdapter);
    expect(registration['useValue']).toBeUndefined();
    expect(registration['useFactory']).toBeUndefined();
  });

  it('injects that same ALERT_CHANNEL_PORT token into AlertEventsService', () => {
    const selfDeclaredDeps = readArray(
      Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, AlertEventsService),
      'AlertEventsService self-declared deps',
    );

    const tokens: unknown[] = [];
    for (const dep of selfDeclaredDeps) {
      tokens.push(readObject(dep, 'self-declared dep')['param']);
    }

    expect(tokens).toContain(ALERT_CHANNEL_PORT);
  });

  it('delivers a PENDING attempt through the resolved adapter to the doubled SMTP transport', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'smtp-msg-1' });
    const repository = repositoryDouble();
    repository.ensureIngestOutbox.mockResolvedValue({
      event: eventRecord(),
      duplicate: false,
      deliveryAttempts: [
        deliveryRecord({
          id: CHANNEL_PROOF.firstAttemptId,
          recipientUserId: CHANNEL_PROOF.firstRecipientId,
          status: DeliveryAttemptStatus.PENDING,
        }),
      ],
    });
    repository.recordDeliveryResult.mockResolvedValue(
      deliveryRecord({ status: DeliveryAttemptStatus.SENT }),
    );
    const prisma = prismaDouble([
      recipientRecord(
        CHANNEL_PROOF.firstRecipientId,
        CHANNEL_PROOF.firstRecipientEmail,
      ),
    ]);
    const config = new ConfigService({ ...SMTP_CONFIG });
    const moduleRef = await wiredModule(repository, prisma, config);
    const service = moduleRef.get(AlertEventsService);

    expect(moduleRef.get<ChannelPort>(ALERT_CHANNEL_PORT)).toBeInstanceOf(
      EmailChannelAdapter,
    );

    await service.ensureOutboxForIngest({
      facilityId: CHANNEL_PROOF.facilityId,
      sourceId: CHANNEL_PROOF.sourceId,
      externalEventId: 'idem-channel-port-1',
      type: AlertEventTypes.fall,
      detectedAt: CHANNEL_PROOF.detectedAt,
      confidence: 0.9,
      residentName: CHANNEL_PROOF.residentName,
      residentRoom: CHANNEL_PROOF.residentRoom,
    });

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: SMTP_CONFIG.SMTP_HOST,
        port: 2525,
        secure: false,
        auth: {
          user: SMTP_CONFIG.SMTP_USER,
          pass: SMTP_CONFIG.SMTP_PASSWORD,
        },
      }),
    );
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = sentMail(0);
    expect(readStringField(mail, 'to')).toBe(CHANNEL_PROOF.firstRecipientEmail);
    expect(readStringField(mail, 'from')).toBe(SMTP_CONFIG.SMTP_FROM);
    expect(readStringField(mail, 'subject')).toContain('[안전알림]');
    expect(readStringField(mail, 'subject')).toContain('낙상 감지');
    expect(readStringField(mail, 'subject')).toContain(
      CHANNEL_PROOF.residentName,
    );
    const text = readStringField(mail, 'text');
    expect(text).toContain(`👤 ${CHANNEL_PROOF.residentName}님`);
    expect(text).toContain(CHANNEL_PROOF.residentRoom);
    expect(text).toContain(CHANNEL_PROOF.detectedAtKST);
    expect(text).toContain(
      `👉 대시보드에서 상태 확인: ${SMTP_CONFIG.ALERT_DASHBOARD_URL}`,
    );
    expect(readStringField(mail, 'html')).toContain(
      `href="${SMTP_CONFIG.ALERT_DASHBOARD_URL}"`,
    );
    expect(repository.recordDeliveryResult).toHaveBeenCalledWith(
      CHANNEL_PROOF.firstAttemptId,
      { kind: 'sent', provider_reference: 'smtp-msg-1' },
    );

    await moduleRef.close();
  });

  it('reuses the one resolved adapter transport for every recipient in a fan-out', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'smtp-msg-shared' });
    const repository = repositoryDouble();
    repository.ensureIngestOutbox.mockResolvedValue({
      event: eventRecord(),
      duplicate: false,
      deliveryAttempts: [
        deliveryRecord({
          id: CHANNEL_PROOF.firstAttemptId,
          recipientUserId: CHANNEL_PROOF.firstRecipientId,
          status: DeliveryAttemptStatus.PENDING,
        }),
        deliveryRecord({
          id: CHANNEL_PROOF.secondAttemptId,
          recipientUserId: CHANNEL_PROOF.secondRecipientId,
          status: DeliveryAttemptStatus.PENDING,
        }),
      ],
    });
    repository.recordDeliveryResult.mockResolvedValue(
      deliveryRecord({ status: DeliveryAttemptStatus.SENT }),
    );
    const prisma = prismaDouble([
      recipientRecord(
        CHANNEL_PROOF.firstRecipientId,
        CHANNEL_PROOF.firstRecipientEmail,
      ),
      recipientRecord(
        CHANNEL_PROOF.secondRecipientId,
        CHANNEL_PROOF.secondRecipientEmail,
      ),
    ]);
    const config = new ConfigService({ ...SMTP_CONFIG });
    const moduleRef = await wiredModule(repository, prisma, config);

    await moduleRef.get(AlertEventsService).ensureOutboxForIngest({
      facilityId: CHANNEL_PROOF.facilityId,
      sourceId: CHANNEL_PROOF.sourceId,
      externalEventId: 'idem-channel-port-2',
      type: AlertEventTypes.fall,
      detectedAt: CHANNEL_PROOF.detectedAt,
      confidence: 0.9,
      residentRoom: CHANNEL_PROOF.residentRoom,
    });

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    expect(readStringField(sentMail(0), 'to')).toBe(
      CHANNEL_PROOF.firstRecipientEmail,
    );
    expect(readStringField(sentMail(1), 'to')).toBe(
      CHANNEL_PROOF.secondRecipientEmail,
    );
    expect(repository.recordDeliveryResult).toHaveBeenCalledWith(
      CHANNEL_PROOF.secondAttemptId,
      { kind: 'sent', provider_reference: 'smtp-msg-shared' },
    );

    await moduleRef.close();
  });

  it('keeps the adapter EAUTH terminal classification instead of swallowing or downgrading it', async () => {
    sendMailMock.mockRejectedValue(
      Object.assign(new Error('Invalid login: 535'), {
        code: 'EAUTH',
        responseCode: 535,
      }),
    );
    const repository = repositoryDouble();
    repository.ensureIngestOutbox.mockResolvedValue({
      event: eventRecord(),
      duplicate: false,
      deliveryAttempts: [
        deliveryRecord({
          id: CHANNEL_PROOF.firstAttemptId,
          recipientUserId: CHANNEL_PROOF.firstRecipientId,
          status: DeliveryAttemptStatus.PENDING,
        }),
      ],
    });
    repository.recordDeliveryResult.mockResolvedValue(
      deliveryRecord({ status: DeliveryAttemptStatus.TERMINAL_FAILED }),
    );
    const prisma = prismaDouble([
      recipientRecord(
        CHANNEL_PROOF.firstRecipientId,
        CHANNEL_PROOF.firstRecipientEmail,
      ),
    ]);
    const config = new ConfigService({ ...SMTP_CONFIG });
    const moduleRef = await wiredModule(repository, prisma, config);

    await expect(
      moduleRef.get(AlertEventsService).ensureOutboxForIngest({
        facilityId: CHANNEL_PROOF.facilityId,
        sourceId: CHANNEL_PROOF.sourceId,
        externalEventId: 'idem-channel-port-3',
        type: AlertEventTypes.fall,
        detectedAt: CHANNEL_PROOF.detectedAt,
        confidence: 0.9,
      }),
    ).resolves.toBeUndefined();

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(repository.recordDeliveryResult).toHaveBeenCalledWith(
      CHANNEL_PROOF.firstAttemptId,
      {
        kind: 'failed',
        failure_class: 'terminal_operator_action',
        reason: 'smtp_EAUTH',
        retry_after_ms: undefined,
        operator_action:
          'Verify SMTP credentials and recipient address before retrying delivery.',
      },
    );
    // The service's own rejection fallback (transient channel_send_rejected)
    // must not replace the adapter's terminal identity.
    expect(repository.recordDeliveryResult).not.toHaveBeenCalledWith(
      CHANNEL_PROOF.firstAttemptId,
      expect.objectContaining({ failure_class: 'transient' }),
    );

    await moduleRef.close();
  });

  it('fails terminally on missing SMTP_HOST and opens no transport (no ambient SMTP fallback)', async () => {
    const repository = repositoryDouble();
    repository.ensureIngestOutbox.mockResolvedValue({
      event: eventRecord(),
      duplicate: false,
      deliveryAttempts: [
        deliveryRecord({
          id: CHANNEL_PROOF.firstAttemptId,
          recipientUserId: CHANNEL_PROOF.firstRecipientId,
          status: DeliveryAttemptStatus.PENDING,
        }),
      ],
    });
    repository.recordDeliveryResult.mockResolvedValue(
      deliveryRecord({ status: DeliveryAttemptStatus.TERMINAL_FAILED }),
    );
    const prisma = prismaDouble([
      recipientRecord(
        CHANNEL_PROOF.firstRecipientId,
        CHANNEL_PROOF.firstRecipientEmail,
      ),
    ]);
    const config = new ConfigService({ ...SMTP_UNSET_CONFIG });
    const moduleRef = await wiredModule(repository, prisma, config);

    await moduleRef.get(AlertEventsService).ensureOutboxForIngest({
      facilityId: CHANNEL_PROOF.facilityId,
      sourceId: CHANNEL_PROOF.sourceId,
      externalEventId: 'idem-channel-port-4',
      type: AlertEventTypes.fall,
      detectedAt: CHANNEL_PROOF.detectedAt,
      confidence: 0.9,
    });

    expect(createTransportMock).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(repository.recordDeliveryResult).toHaveBeenCalledWith(
      CHANNEL_PROOF.firstAttemptId,
      expect.objectContaining({
        kind: 'failed',
        failure_class: 'terminal_operator_action',
        reason: 'smtp_config_missing:SMTP_HOST',
        operator_action:
          'Set the backend SMTP_* environment variables before retrying delivery.',
      }),
    );

    await moduleRef.close();
  });
});

function createService(
  repository: AlertEventsRepositoryMock,
  channel: ChannelPortMock,
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
    prisma,
    config,
  );
}

/**
 * Narrowly owned provider set: the service under test, the channel registration
 * AlertsModule itself declares, and doubles for everything else. No module
 * imports, so AuthModule/PrismaModule/ConfigModule are never resolved.
 */
function wiredModule(
  repository: AlertEventsRepositoryMock,
  prisma: PrismaService,
  config: ConfigService,
): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      AlertEventsService,
      productionAlertChannelProvider(),
      { provide: AlertEventsRepository, useValue: repository },
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();
}

/** AlertsModule's own ALERT_CHANNEL_PORT entries, read from module metadata. */
function alertChannelRegistrations(): readonly JsonObject[] {
  const providers = readArray(
    Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AlertsModule),
    'AlertsModule providers',
  );
  const registrations: JsonObject[] = [];
  for (const provider of providers) {
    if (typeof provider !== 'object' || provider === null) {
      continue;
    }
    const entry = readObject(provider, 'AlertsModule provider entry');
    if (entry['provide'] === ALERT_CHANNEL_PORT) {
      registrations.push(entry);
    }
  }
  return registrations;
}

function productionAlertChannelProvider(): Provider {
  const registrations = alertChannelRegistrations();
  if (registrations.length !== 1) {
    throw new Error(
      `AlertsModule must register ALERT_CHANNEL_PORT exactly once, found ${registrations.length}`,
    );
  }
  const [registration] = registrations;
  if (registration['useClass'] !== EmailChannelAdapter) {
    throw new Error(
      'AlertsModule must bind ALERT_CHANNEL_PORT to EmailChannelAdapter',
    );
  }
  // Validated above, so DI below runs the module's own registration object
  // instead of a copy that could drift away from production wiring.
  return registration as unknown as Provider;
}

function sentMail(index: number): JsonObject {
  const call = sendMailMock.mock.calls.at(index);
  if (call === undefined) {
    throw new Error(`sendMail was not called ${index + 1} time(s)`);
  }
  return readObject(call[0], 'sendMail input');
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
    channel: DeliveryChannel.EMAIL,
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

function recipientRecord(id: string, notificationEmail: string) {
  return {
    id,
    facilityId: 'facility-1',
    notificationEmail,
    email: null,
    role: 'ADMIN',
    emailAlertsEnabled: true,
  };
}
