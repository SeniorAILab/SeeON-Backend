import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AlertMediaController } from './alert-media.controller.js';
import { AlertMediaExceptionFilter } from './alert-media-exception.filter.js';
import { AlertMediaFacilityGuard } from './alert-media-facility.guard.js';
import { AlertMediaRepository } from './alert-media.repository.js';
import { AlertMediaService } from './alert-media.service.js';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [AlertMediaController],
  providers: [
    AlertMediaExceptionFilter,
    AlertMediaFacilityGuard,
    AlertMediaRepository,
    AlertMediaService,
  ],
})
export class AlertMediaModule {}
