import { Injectable } from '@nestjs/common';
import { AlertPolicyClock } from '../ports/alert-policy-clock.port.js';

@Injectable()
export class SystemAlertPolicyClock extends AlertPolicyClock {
  nowMs(): number {
    return Date.now();
  }
}
