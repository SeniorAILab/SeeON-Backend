import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SpacesController } from './controllers/spaces.controller.js';
import { SpacesService } from './services/spaces.service.js';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [SpacesController],
  providers: [SpacesService],
})
export class SpacesModule {}
