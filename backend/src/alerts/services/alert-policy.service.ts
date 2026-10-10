import { Injectable } from '@nestjs/common';
import type {
  AlertEventRequestDto,
  PredictionAlertRequestDto,
} from '../dto/alert-event-request.dto.js';
import type { AlertPolicyDecision } from '../alert-event.types.js';

@Injectable()
export class AlertPolicyService {
  evaluateIngress(
    facilityId: string,
    event: AlertEventRequestDto,
  ): AlertPolicyDecision {
    void facilityId;
    void event;
    return { kind: 'dispatch' };
  }

  evaluatePrediction(
    facilityId: string,
    input: PredictionAlertRequestDto,
  ): AlertPolicyDecision {
    void facilityId;
    void input;
    return { kind: 'dispatch' };
  }
}
