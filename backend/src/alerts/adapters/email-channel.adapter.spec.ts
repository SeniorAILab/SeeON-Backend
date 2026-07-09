import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

const sendMailMock = jest.fn();
const createTransportMock = jest.fn((_config?: unknown) => ({ sendMail: sendMailMock }));

jest.mock('nodemailer', () => ({
  createTransport: (config: unknown) => createTransportMock(config),
}));

import {
  EmailChannelAdapter,
  SmtpConfigError,
  classifyEmailDeliveryFailure,
  notConfiguredEmailDelivery,
} from './email-channel.adapter.js';

const alertMessage = {
  event_id: 'event-1',
  delivery_attempt_id: 'delivery-attempt-1',
  created_at: new Date('2026-07-06T00:00:00.000Z'),
  type: 'fall',
  source_id: 'cam-1',
  external_event_id: 'external-1',
  detected_at: '2026-07-06T00:00:00.000Z',
} as const;

function configService(values: Record<string, string> = {}): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

beforeEach(() => {
  sendMailMock.mockReset();
  createTransportMock.mockClear();
});

describe('EmailChannelAdapter.send', () => {
  it('returns explicit NOT_CONFIGURED delivery failure and warns when recipient email is absent', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const adapter = new EmailChannelAdapter(configService());

    await expect(adapter.send(alertMessage)).resolves.toEqual(
      notConfiguredEmailDelivery(),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      'Email alert skipped: recipient email not configured for delivery_attempt_id=delivery-attempt-1',
    );
    expect(sendMailMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('sends via nodemailer and returns kind sent with the provider message id', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'msg-123' });
    const adapter = new EmailChannelAdapter(
      configService({
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'alerts@example.com',
        SMTP_PASSWORD: 'dev-smtp-password',
      }),
    );

    const result = await adapter.send({
      ...alertMessage,
      recipient_email: 'admin@example.test',
    });

    expect(result).toEqual({ kind: 'sent', provider_reference: 'msg-123' });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const sentArgs = sendMailMock.mock.calls[0][0] as { to: string };
    expect(sentArgs.to).toBe('admin@example.test');
  });

  it('falls back to a synthetic provider_reference when messageId is absent', async () => {
    sendMailMock.mockResolvedValue({});
    const adapter = new EmailChannelAdapter(
      configService({ SMTP_HOST: 'smtp.example.com' }),
    );

    const result = await adapter.send({
      ...alertMessage,
      recipient_email: 'admin@example.test',
    });

    expect(result).toEqual({ kind: 'sent', provider_reference: 'smtp-email' });
  });

  it('classifies a missing SMTP_HOST as a terminal SmtpConfigError failure', async () => {
    const adapter = new EmailChannelAdapter(configService());

    const result = await adapter.send({
      ...alertMessage,
      recipient_email: 'admin@example.test',
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'failed',
        failure_class: 'terminal_operator_action',
        reason: 'smtp_config_missing:SMTP_HOST',
      }),
    );
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

describe('classifyEmailDeliveryFailure', () => {
  it('classifies SmtpConfigError as terminal', () => {
    expect(
      classifyEmailDeliveryFailure(new SmtpConfigError('SMTP_HOST')),
    ).toEqual(
      expect.objectContaining({
        kind: 'failed',
        failure_class: 'terminal_operator_action',
        reason: 'smtp_config_missing:SMTP_HOST',
      }),
    );
  });

  it('classifies EAUTH auth failures as terminal operator-action', () => {
    expect(
      classifyEmailDeliveryFailure({ code: 'EAUTH' }),
    ).toEqual(
      expect.objectContaining({
        kind: 'failed',
        failure_class: 'terminal_operator_action',
        reason: 'smtp_EAUTH',
      }),
    );
  });

  it('classifies provider 5xx responseCode as terminal operator-action', () => {
    expect(
      classifyEmailDeliveryFailure({ responseCode: 550 }),
    ).toEqual(
      expect.objectContaining({
        kind: 'failed',
        failure_class: 'terminal_operator_action',
        reason: 'smtp_550',
      }),
    );
  });

  it('classifies EENVELOPE / EMESSAGE as terminal operator-action', () => {
    expect(
      classifyEmailDeliveryFailure({ code: 'EENVELOPE' }),
    ).toEqual(
      expect.objectContaining({
        kind: 'failed',
        failure_class: 'terminal_operator_action',
        reason: 'smtp_EENVELOPE',
      }),
    );
    expect(
      classifyEmailDeliveryFailure({ code: 'EMESSAGE' }),
    ).toEqual(
      expect.objectContaining({
        kind: 'failed',
        failure_class: 'terminal_operator_action',
        reason: 'smtp_EMESSAGE',
      }),
    );
  });

  it('classifies connection/timeout errors as retryable transient failures', () => {
    expect(
      classifyEmailDeliveryFailure({ code: 'ECONNECTION' }),
    ).toEqual(
      expect.objectContaining({
        kind: 'failed',
        failure_class: 'transient',
        retry_after_ms: 60_000,
      }),
    );
    expect(
      classifyEmailDeliveryFailure({ code: 'ETIMEDOUT' }),
    ).toEqual(
      expect.objectContaining({
        kind: 'failed',
        failure_class: 'transient',
        retry_after_ms: 60_000,
      }),
    );
  });

  it('classifies an unrecognized error as transient with a generic reason', () => {
    expect(classifyEmailDeliveryFailure(new Error('boom'))).toEqual(
      expect.objectContaining({
        kind: 'failed',
        failure_class: 'transient',
        reason: 'smtp_send_error',
        retry_after_ms: 60_000,
      }),
    );
  });
});
