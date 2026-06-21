import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { FloorsController } from './controllers/floors.controller.js';
import { FloorsRepository } from './repositories/floors.repository.js';
import { FloorsService } from './services/floors.service.js';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [FloorsController],
  providers: [FloorsRepository, FloorsService],
})
export class FloorsModule {}
