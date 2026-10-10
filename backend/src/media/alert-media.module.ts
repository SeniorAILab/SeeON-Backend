import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AlertMediaController } from './controllers/alert-media.controller.js';
import { AlertMediaDownloadController } from './controllers/alert-media-download.controller.js';
import { AlertMediaExceptionFilter } from './filters/alert-media-exception.filter.js';
import { AlertMediaFacilityGuard } from './guards/alert-media-facility.guard.js';
import { AlertMediaRepository } from './repositories/alert-media.repository.js';
import { AlertMediaService } from './services/alert-media.service.js';
import { MediaDownloadAuditRepository } from './repositories/media-download-audit.repository.js';
import { MediaDownloadAuditService } from './services/media-download-audit.service.js';
import { MediaDownloadProcessRepository } from './repositories/media-download-process.repository.js';
import { MediaDownloadRuntime } from './ports/media-download-runtime.port.js';
import { SystemMediaDownloadRuntime } from './adapters/system-media-download-runtime.adapter.js';

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
