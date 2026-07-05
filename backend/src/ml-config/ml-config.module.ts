import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MlConfigController } from './ml-config.controller.js';
import { MlConfigService } from './ml-config.service.js';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [MlConfigController],
  providers: [MlConfigService],
  exports: [MlConfigService],
})
export class MlConfigModule {}
