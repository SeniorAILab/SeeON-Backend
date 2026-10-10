import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import {
  CamerasController,
  EdgeCamerasController,
} from './controllers/cameras.controller.js';
import { CamerasService } from './services/cameras.service.js';
import { EdgeFacilityTokenGuard } from './guards/edge-facility-token.guard.js';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [CamerasController, EdgeCamerasController],
  providers: [CamerasService, EdgeFacilityTokenGuard],
  exports: [CamerasService],
})
export class CamerasModule {}
