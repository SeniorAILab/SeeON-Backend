import type { AlertEventType } from '../alert-event.types.js';
import type { PredictFallResponseDto } from './alert-event-response.dto.js';

export type AlertEventRequestDto = {
  readonly type: AlertEventType;
  readonly source_id: string;
  readonly external_event_id: string;
  readonly detected_at: string;
  readonly confidence?: number;
};

export type PredictionAlertRequestDto = {
  readonly source_id: string;
  readonly external_event_id: string;
  readonly detected_at: string;
  readonly prediction: PredictFallResponseDto;
};
