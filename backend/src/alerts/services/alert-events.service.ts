import { Inject, Injectable } from '@nestjs/common';
import { DeliveryAttemptStatus } from '@prisma/client';

import {
  AlertEventTypes,
  type AlertEventIngressDto,
  type AlertEventResponseDto,
  type DeliveryStatusDto,
  type PredictionAlertInputDto,
  type PredictionWindowAlertInputDto,
} from '../dto/alert-events.dto.js';
import { ALERT_CHANNEL_PORT, type ChannelPort } from '../ports/channel.port.js';
import {
  ALERT_PREDICTION_PORT,
  type PredictionPort,
} from '../ports/prediction.port.js';
import type { ExistingAlertEventAggregate } from '../repositories/alert-events.repository.js';
import { AlertEventsRepository } from '../repositories/alert-events.repository.js';
import { AlertPolicyService } from './alert-policy.service.js';

@Injectable()
export class AlertEventsService {
  constructor(
    private readonly alertPolicyService: AlertPolicyService,
    private readonly alertEventsRepository: AlertEventsRepository,
    @Inject(ALERT_CHANNEL_PORT)
    private readonly channelPort: ChannelPort,
    @Inject(ALERT_PREDICTION_PORT)
    private readonly predictionPort: PredictionPort,
  ) {}

  async ingest(event: AlertEventIngressDto): Promise<AlertEventResponseDto> {
    const duplicate = await this.findDuplicate(event);
    if (duplicate !== null) {
      return toDuplicateResponse(duplicate);
    }

    const policyDecision = this.alertPolicyService.evaluateIngress(event);
    return this.createAndDispatch({ event, policyDecision });
  }

  async predictAndIngest(
    input: PredictionWindowAlertInputDto,
  ): Promise<AlertEventResponseDto> {
    const prediction = await this.predictionPort.predict(input.request);
    return this.ingestPrediction({
      source_id: input.source_id,
      external_event_id: input.external_event_id,
      detected_at: input.detected_at,
      prediction,
    });
  }

  async ingestPrediction(
    input: PredictionAlertInputDto,
  ): Promise<AlertEventResponseDto> {
    const event = {
      type: AlertEventTypes.fall,
      source_id: input.source_id,
      external_event_id: input.external_event_id,
      detected_at: input.detected_at,
      confidence: input.prediction.fall_probability,
    };
    const duplicate = await this.findDuplicate(event);
    if (duplicate !== null) {
      return toDuplicateResponse(duplicate);
    }

    const policyDecision = this.alertPolicyService.evaluatePrediction(input);
    return this.createAndDispatch({
      event,
      fallProbability: input.prediction.fall_probability,
      operatingThreshold: input.prediction.operating_threshold,
      policyDecision,
    });
  }

  private async createAndDispatch(input: {
    readonly event: AlertEventIngressDto;
    readonly policyDecision: ReturnType<AlertPolicyService['evaluateIngress']>;
    readonly fallProbability?: number;
    readonly operatingThreshold?: number;
  }): Promise<AlertEventResponseDto> {
    const aggregate =
      await this.alertEventsRepository.createEventWithInitialDelivery({
        event: input.event,
        decision: input.policyDecision,
        fallProbability: input.fallProbability,
        operatingThreshold: input.operatingThreshold,
      });

    const baseResponse = {
      event_id: aggregate.event.id,
      duplicate: aggregate.duplicate,
    };

    if (aggregate.deliveryAttempt === undefined) {
      return baseResponse;
    }

    if (aggregate.duplicate) {
      return {
        ...baseResponse,
        delivery_attempt_id: aggregate.deliveryAttempt.id,
        delivery_status: toDeliveryStatusDto(aggregate.deliveryAttempt.status),
      };
    }

    const result = await this.channelPort.send({
      ...input.event,
      event_id: aggregate.event.id,
      delivery_attempt_id: aggregate.deliveryAttempt.id,
      created_at: aggregate.deliveryAttempt.createdAt,
    });
    const updatedDelivery =
      await this.alertEventsRepository.recordDeliveryResult(
        aggregate.deliveryAttempt.id,
        result,
      );

    return {
      ...baseResponse,
      delivery_attempt_id: updatedDelivery.id,
      delivery_status: toDeliveryStatusDto(updatedDelivery.status),
    };
  }

  private async findDuplicate(
    event: AlertEventIngressDto,
  ): Promise<ExistingAlertEventAggregate | null> {
    return this.alertEventsRepository.findExistingByExternalKey(
      event.source_id,
      event.external_event_id,
    );
  }
}

function toDuplicateResponse(
  aggregate: ExistingAlertEventAggregate,
): AlertEventResponseDto {
  if (aggregate.deliveryAttempt === undefined) {
    return {
      event_id: aggregate.event.id,
      duplicate: true,
    };
  }

  return {
    event_id: aggregate.event.id,
    duplicate: true,
    delivery_attempt_id: aggregate.deliveryAttempt.id,
    delivery_status: toDeliveryStatusDto(aggregate.deliveryAttempt.status),
  };
}

function toDeliveryStatusDto(status: DeliveryAttemptStatus): DeliveryStatusDto {
  if (status === DeliveryAttemptStatus.SENT) {
    return 'sent';
  }
  if (status === DeliveryAttemptStatus.RETRY_SCHEDULED) {
    return 'retry_scheduled';
  }
  if (status === DeliveryAttemptStatus.TERMINAL_FAILED) {
    return 'terminal_failed';
  }
  return 'pending';
}
