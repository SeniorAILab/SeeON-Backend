import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { KakaoSendToMeChannelAdapter } from './adapters/kakao-send-to-me-channel.adapter.js';
import { ALERT_CHANNEL_PORT } from './ports/channel.port.js';
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
 * AlertsModule bounds the live alert domain:
 *  - /api/v1/events is the live ML ingress; AlertEventsService owns the
 *    persisted outbox + Kakao channel fan-out used by the Event API.
 *  - AlertEventsService owns persisted outbox + Kakao channel fan-out only;
 *    live alert decisions come from pushed Event API payload confidence.
 *  - #105 read-model: dashboard-facing Alert queries + snapshot proxy
 *    (GET/PATCH/PUT api/alerts, api/snapshots), guarded by AuthModule.
 *  - #105 write path: AlertWriterService serializes Alert inserts (alertSeq
 *    causal order) and fans out live alert events for the SSE slice;
 *    exported for the dashboard SSE transport.
 */
@Module({
  imports: [ConfigModule, PrismaModule, AuthModule],
  controllers: [AlertsController],
  providers: [
    AlertEventsRepository,
    AlertEventsService,
    AlertPolicyService,
    { provide: AlertPolicyClock, useClass: SystemAlertPolicyClock },
    { provide: ALERT_CHANNEL_PORT, useClass: KakaoSendToMeChannelAdapter },
    AlertsService,
    AlertWriterService,
  ],
  exports: [
    AlertsService,
    AlertWriterService,
    AlertEventsService,
    AlertPolicyService,
  ],
})
export class AlertsModule {}
