import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  AlertEventTypes,
  type AlertEventRequestDto,
  type AlertPolicyDecision,
  type PredictionAlertRequestDto,
} from '../dto/alert-events.dto.js';

const DEFAULT_POLICY_ENABLED = true;
const DEFAULT_COOLDOWN_SEC = 60;
const DEFAULT_HOURLY_CAP = 10;
const ONE_HOUR_MS = 60 * 60 * 1_000;

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
  private readonly dispatchTimestampsMsByFacility = new Map<string, number[]>();
  private readonly cooldownUntilMsByKey = new Map<string, number>();

  constructor(
    private readonly configService: ConfigService,
    private readonly clock: AlertPolicyClock,
  ) {}

  evaluateIngress(facilityId: string, event: AlertEventRequestDto): AlertPolicyDecision {
    if (!this.isPolicyEnabled()) {
      return { kind: 'dispatch' };
    }

    const nowMs = this.clock.nowMs();
    const dispatchTimestampsMs = this.dispatchTimestampsForFacility(facilityId);
    this.pruneDispatches(dispatchTimestampsMs, nowMs);

    const key = policyKey(facilityId, event);
    const cooldownUntilMs = this.cooldownUntilMsByKey.get(key);
    if (cooldownUntilMs !== undefined && nowMs < cooldownUntilMs) {
      return { kind: 'suppress', suppressed_reason: 'cooldown' };
    }

    const hourlyCap = this.hourlyCap();
    if (dispatchTimestampsMs.length >= hourlyCap) {
      return { kind: 'suppress', suppressed_reason: 'hourly_cap' };
    }

    dispatchTimestampsMs.push(nowMs);
    this.cooldownUntilMsByKey.set(key, nowMs + this.cooldownMs());
    return { kind: 'dispatch' };
  }

  evaluatePrediction(
    facilityId: string,
    input: PredictionAlertRequestDto,
  ): AlertPolicyDecision {
    const { prediction } = input;
    if (
      !prediction.is_fall ||
      prediction.fall_probability < prediction.operating_threshold
    ) {
      return { kind: 'suppress', suppressed_reason: 'below_threshold' };
    }

    return this.evaluateIngress(facilityId, {
      type: AlertEventTypes.fall,
      source_id: input.source_id,
      external_event_id: input.external_event_id,
      detected_at: input.detected_at,
      confidence: prediction.fall_probability,
    });
  }

  private dispatchTimestampsForFacility(facilityId: string): number[] {
    const key = facilityId.trim();
    let timestamps = this.dispatchTimestampsMsByFacility.get(key);
    if (!timestamps) {
      timestamps = [];
      this.dispatchTimestampsMsByFacility.set(key, timestamps);
    }
    return timestamps;
  }

  private pruneDispatches(dispatchTimestampsMs: number[], nowMs: number): void {
    const cutoffMs = nowMs - ONE_HOUR_MS;
    while (
      dispatchTimestampsMs.length > 0 &&
      dispatchTimestampsMs[0] <= cutoffMs
    ) {
      dispatchTimestampsMs.shift();
    }
  }

  private isPolicyEnabled(): boolean {
    const value = this.configService.get<string | boolean>(
      'ALERT_POLICY_ENABLED',
    );
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      return value.toLowerCase() !== 'false';
    }
    return DEFAULT_POLICY_ENABLED;
  }

  private cooldownMs(): number {
    return (
      readNonNegativeIntegerConfig(
        this.configService.get<string | number>('ALERT_COOLDOWN_SEC'),
        DEFAULT_COOLDOWN_SEC,
      ) * 1_000
    );
  }

  private hourlyCap(): number {
    return readNonNegativeIntegerConfig(
      this.configService.get<string | number>('ALERT_HOURLY_CAP'),
      DEFAULT_HOURLY_CAP,
    );
  }
}

function policyKey(facilityId: string, event: AlertEventRequestDto): string {
  return `${facilityId.trim()}|${event.source_id}|${event.type}`;
}

function readNonNegativeIntegerConfig(
  value: string | number | undefined,
  defaultValue: number,
): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.trunc(parsed);
    }
  }
  return defaultValue;
}
