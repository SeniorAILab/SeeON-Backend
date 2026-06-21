import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { FacilitiesController } from './controllers/facilities.controller.js';
import { FacilitiesService } from './services/facilities.service.js';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [FacilitiesController],
  providers: [FacilitiesService],
})
export class FacilitiesModule {}
