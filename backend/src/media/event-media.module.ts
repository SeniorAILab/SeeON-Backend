import { Module } from '@nestjs/common';
import { CamerasModule } from '../cameras/cameras.module.js';
import { EdgeIngestTokenGuard } from '../events/edge-ingest-token.guard.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ClipStorageModule } from './clip-storage.module.js';
import { EdgeMediaController } from './edge-media.controller.js';
import { readEventMediaConfig } from './event-media.config.js';
import { EventMediaLifecycleRepository } from './event-media-lifecycle.repository.js';
import { EventMediaRepository } from './event-media.repository.js';
import {
  EVENT_MEDIA_CONFIG,
  EventMediaService,
} from './event-media.service.js';

@Module({
  imports: [PrismaModule, CamerasModule, ClipStorageModule],
  controllers: [EdgeMediaController],
  providers: [
    EdgeIngestTokenGuard,
    EventMediaRepository,
    EventMediaLifecycleRepository,
    EventMediaService,
    { provide: EVENT_MEDIA_CONFIG, useFactory: readEventMediaConfig },
  ],
  exports: [EventMediaService],
})
export class EventMediaModule {}
