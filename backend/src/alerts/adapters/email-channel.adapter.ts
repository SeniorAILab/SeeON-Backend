import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

import { readPositiveIntegerConfig } from './config.js';
import type {
  AlertDeliveryMessage,
  ChannelPort,
  DeliveryFailureClass,
  DeliveryResult,
} from '../ports/channel.port.js';
import {
  buildEmailAlertHtml,
  buildEmailAlertText,
  toEmailAlertMessageDto,
} from '../dto/email-alert-message.dto.js';

const DEFAULT_SMTP_PORT = 587;
const DEFAULT_LINK_URL = 'http://localhost:3000';
const DEFAULT_FROM = 'Eldercare Safety <no-reply@localhost>';

@Injectable()
export class EmailChannelAdapter implements ChannelPort {
  private readonly logger = new Logger(EmailChannelAdapter.name);
  private transporter: Transporter | undefined;

  constructor(private readonly configService: ConfigService) {}

  async send(message: AlertDeliveryMessage): Promise<DeliveryResult> {
    const to = message.recipient_email?.trim();
    if (to === undefined || to.length === 0) {
      this.logger.warn(
        `Email alert skipped: recipient email not configured for delivery_attempt_id=${message.delivery_attempt_id}`,
      );
      return notConfiguredEmailDelivery();
    }

    let transporter: Transporter;
    try {
      transporter = this.resolveTransporter();
    } catch (error) {
      return classifyEmailDeliveryFailure(error);
    }

    try {
      const dto = toEmailAlertMessageDto(message, this.messageLinkUrl());
      const info = await transporter.sendMail({
        from: this.fromAddress(),
        to,
        subject: dto.subject,
        text: buildEmailAlertText(dto),
        html: buildEmailAlertHtml(dto),
      });
      return {
        kind: 'sent',
        provider_reference: info.messageId ?? 'smtp-email',
      };
    } catch (error) {
      return classifyEmailDeliveryFailure(error);
    }
  }

  /**
   * Lazily builds (and caches) the SMTP transport. Throws SmtpConfigError when
   * SMTP_HOST is missing so a misconfigured deployment surfaces as a terminal,
   * operator-actionable delivery failure rather than a silent drop.
   */
  private resolveTransporter(): Transporter {
    if (this.transporter !== undefined) {
      return this.transporter;
    }
    const host = this.configService.get<string>('SMTP_HOST')?.trim();
    if (host === undefined || host.length === 0) {
      throw new SmtpConfigError('SMTP_HOST');
    }
    const port = readPositiveIntegerConfig(
      this.configService,
      'SMTP_PORT',
      DEFAULT_SMTP_PORT,
    );
    const secure = this.readBoolean('SMTP_SECURE', port === 465);
    const user = this.configService.get<string>('SMTP_USER')?.trim();
    const pass = this.configService.get<string>('SMTP_PASSWORD');
    this.transporter = createTransport({
      host,
      port,
      secure,
      auth:
        user !== undefined && user.length > 0 && pass
          ? { user, pass }
          : undefined,
    });
    return this.transporter;
  }

  private fromAddress(): string {
    const from = this.configService.get<string>('SMTP_FROM')?.trim();
    if (from !== undefined && from.length > 0) {
      return from;
    }
    const user = this.configService.get<string>('SMTP_USER')?.trim();
    return user !== undefined && user.length > 0 ? user : DEFAULT_FROM;
  }

  private messageLinkUrl(): string {
    return (
      this.configService.get<string>('ALERT_DASHBOARD_URL') ?? DEFAULT_LINK_URL
    );
  }

  private readBoolean(name: string, defaultValue: boolean): boolean {
    const value = this.configService.get<string>(name)?.trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    return defaultValue;
  }
}

export class SmtpConfigError extends Error {
  constructor(readonly configName: string) {
    super(`SMTP config is missing: ${configName}`);
  }
}

interface SmtpError {
  readonly code?: string;
  readonly responseCode?: number;
}

function smtpErrorFields(error: unknown): SmtpError {
  if (typeof error !== 'object' || error === null) {
    return {};
  }
  const candidate = error as { code?: unknown; responseCode?: unknown };
  return {
    code: typeof candidate.code === 'string' ? candidate.code : undefined,
    responseCode:
      typeof candidate.responseCode === 'number'
        ? candidate.responseCode
        : undefined,
  };
}

export function classifyEmailDeliveryFailure(error: unknown): DeliveryResult {
  if (error instanceof SmtpConfigError) {
    return failed(
      'terminal_operator_action',
      `smtp_config_missing:${error.configName}`,
      undefined,
      'Set the backend SMTP_* environment variables before retrying delivery.',
    );
  }

  const { code, responseCode } = smtpErrorFields(error);

  // Authentication and permanent 5xx server rejections require operator action.
  if (
    code === 'EAUTH' ||
    (responseCode !== undefined && responseCode >= 500)
  ) {
    return failed(
      'terminal_operator_action',
      `smtp_${code ?? responseCode}`,
      undefined,
      'Verify SMTP credentials and recipient address before retrying delivery.',
    );
  }

  // Bad envelope/message (invalid recipient) is terminal until corrected.
  if (code === 'EENVELOPE' || code === 'EMESSAGE') {
    return failed(
      'terminal_operator_action',
      `smtp_${code}`,
      undefined,
      'Correct the recipient email address before retrying delivery.',
    );
  }

  // Connection/timeout/greylisting and other transient conditions are retryable.
  return failed(
    'transient',
    `smtp_${code ?? responseCode ?? 'send_error'}`,
    60_000,
  );
}

export function notConfiguredEmailDelivery(): DeliveryResult {
  return failed(
    'terminal_operator_action',
    'NOT_CONFIGURED',
    undefined,
    'Set a notification email for the recipient before retrying delivery.',
  );
}

function failed(
  failureClass: DeliveryFailureClass,
  reason: string,
  retryAfterMs?: number,
  operatorAction?: string,
): DeliveryResult {
  return {
    kind: 'failed',
    failure_class: failureClass,
    reason,
    retry_after_ms: retryAfterMs,
    operator_action: operatorAction,
  };
}
