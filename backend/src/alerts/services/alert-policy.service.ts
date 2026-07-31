import { Injectable } from '@nestjs/common';
import {
  type AlertEventRequestDto,
  type AlertPolicyDecision,
  type PredictionAlertRequestDto,
} from '../dto/alert-events.dto.js';

export abstract class AlertPolicyClock {
  abstract nowMs(): number;
}

@Injectable()
export class SystemAlertPolicyClock extends AlertPolicyClock {
  nowMs(): number {
    return Date.now();
  }
}

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
