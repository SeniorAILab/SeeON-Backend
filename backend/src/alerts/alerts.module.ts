import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { EmailChannelAdapter } from './adapters/email-channel.adapter.js';
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
 *  - /api/v1/events is the live ML ingress; EventAlarmService records the Event
 *    + camera offline/online state and derives an Alert. It does not run the
 *    outbox or email fan-out on ingest.
 *  - AlertEventsService owns the persisted outbox + email channel fan-out as
 *    separate delivery infrastructure, not part of the live Event API ingest path.
 *  - #105 read-model: dashboard-facing Alert queries + snapshot proxy
 *    (GET /api/v1/alerts, GET/PUT /api/v1/alerts/:alertId/snapshot), guarded by AuthModule.
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
    { provide: ALERT_CHANNEL_PORT, useClass: EmailChannelAdapter },
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
