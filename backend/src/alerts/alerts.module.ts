import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaModule } from '../prisma/prisma.module.js';
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

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [AlertEventsController],
  providers: [
    AlertEventsRepository,
    AlertEventsService,
    AlertPolicyService,
    { provide: AlertPolicyClock, useClass: SystemAlertPolicyClock },
    { provide: ALERT_CHANNEL_PORT, useClass: KakaoSendToMeChannelAdapter },
    { provide: ALERT_PREDICTION_PORT, useClass: MlServingPredictionAdapter },
  ],
})
export class AlertsModule {}
