export type PredictFallResponseDto = {
  readonly fall_probability: number;
  readonly operating_threshold: number;
  readonly is_fall: boolean;
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
