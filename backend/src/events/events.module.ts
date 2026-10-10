import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AlertsModule } from '../alerts/alerts.module.js';
import { CamerasModule } from '../cameras/cameras.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EventRecorderService } from './services/event-recorder.service.js';
import { EventAlarmService } from './services/event-alarm.service.js';
import { EventsController } from './controllers/events.controller.js';
import { EdgeIngestTokenGuard } from './guards/edge-ingest-token.guard.js';

@Module({
  imports: [PrismaModule, CamerasModule, AuthModule, AlertsModule],
  controllers: [EventsController],
  providers: [EventRecorderService, EventAlarmService, EdgeIngestTokenGuard],
  exports: [EventRecorderService],
})
export class EventsModule {}
