import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EdgeIngestTokenGuard } from '../events/guards/edge-ingest-token.guard.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MlConfigController } from './controllers/ml-config.controller.js';
import { MlConfigService } from './services/ml-config.service.js';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [MlConfigController],
  providers: [MlConfigService, EdgeIngestTokenGuard],
  exports: [MlConfigService],
})
export class MlConfigModule {}
