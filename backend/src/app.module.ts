import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AlertsModule } from './alerts/alerts.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ResidentsModule } from './residents/residents.module.js';
import { GuardiansModule } from './guardians/guardians.module.js';
import { CamerasModule } from './cameras/cameras.module.js';
import { StatusModule } from './status/status.module.js';
import { IngestModule } from './ingest/ingest.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';

// Ensure BigInt fields (e.g. Alert.alertSeq, exposed by the alerts read API
// and the SSE stream) serialize in JSON responses. Nest uses JSON.stringify,
// which throws on BigInt without this prototype shim.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (
  this: bigint,
): string {
  return this.toString();
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `.env.${process.env.NODE_ENV ?? 'development'}`,
    }),
    PrismaModule,
    AuthModule,
    ResidentsModule,
    GuardiansModule,
    CamerasModule,
    StatusModule,
    AlertsModule,
    IngestModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
