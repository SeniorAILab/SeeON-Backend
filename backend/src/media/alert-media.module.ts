import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AlertMediaController } from './alert-media.controller.js';
import { AlertMediaDownloadController } from './alert-media-download.controller.js';
import { AlertMediaExceptionFilter } from './alert-media-exception.filter.js';
import { AlertMediaFacilityGuard } from './alert-media-facility.guard.js';
import { AlertMediaRepository } from './alert-media.repository.js';
import { AlertMediaService } from './alert-media.service.js';
import { MediaDownloadAuditRepository } from './media-download-audit.repository.js';
import { MediaDownloadAuditService } from './media-download-audit.service.js';
import { MediaDownloadProcessRepository } from './media-download-process.repository.js';
import {
  MediaDownloadRuntime,
  SystemMediaDownloadRuntime,
} from './media-download-runtime.js';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [AlertMediaController, AlertMediaDownloadController],
  providers: [
    AlertMediaExceptionFilter,
    AlertMediaFacilityGuard,
    AlertMediaRepository,
    AlertMediaService,
    MediaDownloadAuditRepository,
    MediaDownloadProcessRepository,
    MediaDownloadAuditService,
    { provide: MediaDownloadRuntime, useClass: SystemMediaDownloadRuntime },
  ],
})
export class AlertMediaModule {}
