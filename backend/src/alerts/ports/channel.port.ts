import type { AlertEventIngressDto } from '../dto/alert-events.dto.js';

export const ALERT_CHANNEL_PORT = Symbol('ALERT_CHANNEL_PORT');

export type AlertDeliveryMessage = AlertEventIngressDto & {
  readonly event_id: string;
  readonly delivery_attempt_id: string;
  readonly created_at: Date;
  readonly recipient_access_token?: string;
};

export type DeliveryResult =
  | {
      readonly kind: 'sent';
      readonly provider_reference?: string;
    }
  | {
      readonly kind: 'failed';
      readonly failure_class: DeliveryFailureClass;
      readonly reason: string;
      readonly retry_after_ms?: number;
      readonly operator_action?: string;
    };

export type DeliveryFailureClass = 'transient' | 'terminal_operator_action';

export interface ChannelPort {
  send(message: AlertDeliveryMessage): Promise<DeliveryResult>;
}
