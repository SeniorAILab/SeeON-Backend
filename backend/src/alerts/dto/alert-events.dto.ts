export const AlertEventTypes = {
  detectionLost: 'detection-lost',
  bedExit: 'bed-exit',
  fall: 'fall',
} as const;

export type AlertEventType =
  (typeof AlertEventTypes)[keyof typeof AlertEventTypes];

export type AlertEventRequestDto = {
  readonly type: AlertEventType;
  readonly source_id: string;
  readonly external_event_id: string;
  readonly detected_at: string;
  readonly confidence?: number;
};

export type PredictFallResponseDto = {
  readonly fall_probability: number;
  readonly operating_threshold: number;
  readonly is_fall: boolean;
};

export type PredictionAlertRequestDto = {
  readonly source_id: string;
  readonly external_event_id: string;
  readonly detected_at: string;
  readonly prediction: PredictFallResponseDto;
};

export type DeliveryStatusDto =
  | 'pending'
  | 'sent'
  | 'retry_scheduled'
  | 'terminal_failed';

export type AlertEventResponseDto = {
  readonly event_id: string;
  readonly duplicate: boolean;
  readonly delivery_attempt_id?: string;
  readonly delivery_status?: DeliveryStatusDto;
};
export type AlertSuppressedReason =
  | 'cooldown'
  | 'hourly_cap'
  | 'below_threshold';

export type AlertPolicyDecision =
  | { readonly kind: 'dispatch' }
  | {
      readonly kind: 'suppress';
      readonly suppressed_reason: AlertSuppressedReason;
    };
