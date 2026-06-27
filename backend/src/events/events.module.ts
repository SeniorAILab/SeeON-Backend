import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AlertsModule } from '../alerts/alerts.module.js';
import { CamerasModule } from '../cameras/cameras.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EventRecorderService } from './event-recorder.service.js';
import { EventAlarmService } from './event-alarm.service.js';
import { EventsController } from './events.controller.js';

@Module({
  imports: [PrismaModule, CamerasModule, AuthModule, AlertsModule],
  controllers: [EventsController],
  providers: [EventRecorderService, EventAlarmService],
  exports: [EventRecorderService],
})
export class EventsModule {}
