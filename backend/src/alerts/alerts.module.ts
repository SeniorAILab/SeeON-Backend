import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { KakaoSendToMeChannelAdapter } from './adapters/kakao-send-to-me-channel.adapter.js';
import { MlServingPredictionAdapter } from './adapters/ml-serving-prediction.adapter.js';
import { AlertEventsController } from './controllers/alert-events.controller.js';
import { ALERT_CHANNEL_PORT } from './ports/channel.port.js';
import { ALERT_PREDICTION_PORT } from './ports/prediction.port.js';
import { AlertEventsRepository } from './repositories/alert-events.repository.js';
import { AlertEventsService } from './services/alert-events.service.js';
import {
  AlertPolicyClock,
  AlertPolicyService,
  SystemAlertPolicyClock,
} from './services/alert-policy.service.js';
import { AlertsController } from './alerts.controller.js';
import { AlertsService } from './alerts.service.js';
import { AlertWriterService } from './alert-writer.service.js';

/**
 * AlertsModule bounds three cooperating concerns over the same domain:
 *  - #103 ingestion pipeline: AlertEvent outbox + policy + channel/prediction
 *    ports (POST api.alerts/events).
 *  - #105 read-model: dashboard-facing Alert queries + snapshot proxy
 *    (GET/PATCH/PUT api/alerts, api/snapshots), guarded by AuthModule.
 *  - #105 write path: AlertWriterService serializes Alert inserts (alertSeq
 *    causal order) and fans out live alert/status events for the SSE slice;
 *    exported for the dashboard SSE transport.
 */
@Module({
  imports: [ConfigModule, PrismaModule, AuthModule],
  controllers: [AlertEventsController, AlertsController],
  providers: [
    AlertEventsRepository,
    AlertEventsService,
    AlertPolicyService,
    { provide: AlertPolicyClock, useClass: SystemAlertPolicyClock },
    { provide: ALERT_CHANNEL_PORT, useClass: KakaoSendToMeChannelAdapter },
    { provide: ALERT_PREDICTION_PORT, useClass: MlServingPredictionAdapter },
    AlertsService,
    AlertWriterService,
  ],
  exports: [AlertsService, AlertWriterService, AlertEventsService],
})
export class AlertsModule {}
