import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AlertsModule } from '../alerts/alerts.module.js';
import {
  DashboardStreamController,
  SSE_REAUTH_INTERVAL_MS,
} from './sse.controller.js';

const DEFAULT_REAUTH_INTERVAL_MS = 20_000;

@Module({
  imports: [PrismaModule, AuthModule, AlertsModule],
  controllers: [DashboardStreamController],
  providers: [
    { provide: SSE_REAUTH_INTERVAL_MS, useValue: DEFAULT_REAUTH_INTERVAL_MS },
  ],
})
export class DashboardModule {}
