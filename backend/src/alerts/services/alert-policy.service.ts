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
    _facilityId: string,
    _event: AlertEventRequestDto,
  ): AlertPolicyDecision {
    return { kind: 'dispatch' };
  }

  evaluatePrediction(
    _facilityId: string,
    _input: PredictionAlertRequestDto,
  ): AlertPolicyDecision {
    return { kind: 'dispatch' };
  }
}
