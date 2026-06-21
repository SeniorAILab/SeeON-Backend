import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { FacilitiesController } from './controllers/facilities.controller.js';
import { FacilitiesRepository } from './repositories/facilities.repository.js';
import { FacilitiesService } from './services/facilities.service.js';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [FacilitiesController],
  providers: [FacilitiesRepository, FacilitiesService],
})
export class FacilitiesModule {}
